import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { connectionPath, readRoutingJson, resolveProfile, sessionIdentity, walletIdentity, type RoutedProfile } from '../scripts/profile-routing.mjs';
import { withoutAllocation } from './allocation-management.js';
import { validateConfig, withUserRebalanceRequest } from './config.js';
import { acquireConfigLock } from './config-lock.js';
import { decodeShareCode, encodeShareCode, encodeSharedStrategy, sharePreview, type SharedStrategy } from './share.js';
import { acquireLock, atomicWriteJson, readJson } from './storage.js';
import { prepareView } from './view.js';
import { publicViewFailure } from './view-error.js';

type Strategy = Parameters<typeof encodeShareCode>[0];
type Route = { wallet: string; directory: string };
type Journal = {
  version: 1; requestId: string; sessionDigest: string; codeDigest: string; requestedWallet: string | null;
} & ({ state: 'unselected'; wallet: null } | { state: 'started' | 'blocked'; wallet: string | null } |
  { state: 'applying' | 'applied'; wallet: string; route: Route; beforeCode: string });
export type ShareReceiveDependencies = {
  connection: (root: string, session: string) => Promise<unknown>;
  resolve: typeof resolveProfile;
  config: (profile: RoutedProfile) => Promise<unknown>;
  view: typeof prepareView;
  read: typeof readJson;
  write: typeof atomicWriteJson;
  requestLock: typeof acquireLock;
  configLock: typeof acquireConfigLock;
};
const defaults: ShareReceiveDependencies = {
  connection: (root, session) => readRoutingJson(connectionPath(root, session)),
  resolve: resolveProfile,
  config: profile => readJson(resolve(profile.dataDir, 'config.json')),
  view: prepareView, read: readJson, write: atomicWriteJson,
  requestLock: acquireLock, configLock: acquireConfigLock,
};
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const publicShared = (shared: SharedStrategy) => ({ targets: shared.targets,
  driftThresholdBps: shared.driftThresholdBps ?? null, rebalanceIntervalSeconds: shared.rebalanceIntervalSeconds ?? null });
function savedStrategy(code: unknown): Strategy {
  if (typeof code !== 'string') throw new Error('Invalid share receipt');
  const strategy = decodeShareCode(code);
  if (encodeSharedStrategy(strategy) !== code || strategy.driftThresholdBps === undefined || strategy.rebalanceIntervalSeconds === undefined) {
    throw new Error('Invalid share receipt');
  }
  return { targets: strategy.targets, driftThresholdBps: strategy.driftThresholdBps, rebalanceIntervalSeconds: strategy.rebalanceIntervalSeconds };
}
function journal(value: unknown, identity: Pick<Journal, 'requestId' | 'sessionDigest' | 'codeDigest' | 'requestedWallet'>): Journal {
  if (!isRecord(value) || value.version !== 1 || Object.entries(identity).some(([key, item]) => value[key] !== item)) {
    throw new Error('Invalid share receipt');
  }
  const wallet = value.wallet === null ? null : walletIdentity(value.wallet);
  if (wallet !== value.wallet || identity.requestedWallet !== null && wallet !== null && identity.requestedWallet !== wallet) throw new Error('Invalid share route');
  if (value.state === 'unselected' && wallet === null) return {version: 1, ...identity, state: 'unselected', wallet: null};
  if (value.state === 'started' || value.state === 'blocked') return {version: 1, ...identity, state: value.state, wallet};
  if (!wallet || !isRecord(value.route) || value.route.wallet !== wallet) throw new Error('Invalid share route');
  const directory = value.route.directory;
  if (directory !== '.' && directory !== `wallets/${wallet}`) throw new Error('Invalid share route');
  if (value.state !== 'applying' && value.state !== 'applied') throw new Error('Invalid share receipt');
  savedStrategy(value.beforeCode);
  return {version: 1, ...identity, state: value.state, wallet, route: {wallet, directory}, beforeCode: value.beforeCode as string};
}

function verifyProfile(root: string, profile: RoutedProfile, route: Route) {
  if (profile.wallet !== route.wallet || profile.chainId !== 4663 || profile.rootDir !== root || profile.directory !== route.directory ||
      profile.dataDir !== resolve(root, route.directory)) throw new Error('The selected portfolio changed');
}

/** Apply one native pasted-code request to its captured attachment. This never imports execution modules. */
export async function receiveSharedCode(rootDir: string, sessionId: string | undefined, code: string, requestId: string | undefined,
  wallet?: string, overrides: Partial<ShareReceiveDependencies> = {}) {
  const app = { app: 'Rebalance', operation: 'share-import' } as const;
  let shared: SharedStrategy, canonical: string;
  // Even malformed inputs must not create a journal, inspect routing, or prepare a view.
  try { shared = decodeShareCode(code); canonical = encodeSharedStrategy(shared); }
  catch { return { ...app, outcome: 'blocked' as const, applied: false as const, message: 'Invalid strategy share code; no changes were made.' }; }
  const base = { ...app, code: canonical, shared: publicShared(shared) };
  const blocked = (selected?: string, replayed = false) => ({ ...base, outcome: 'blocked' as const, applied: false as const,
    ...(selected ? {wallet: selected, chainId: 4663} : {}), ...(replayed ? {replayed: true} : {}),
    message: 'The shared strategy could not be applied to the selected portfolio; no changes were made.' });
  const unknown = (selected?: string, replayed = false) => ({ ...base, outcome: 'unknown' as const, applied: null,
    ...(selected ? {wallet: selected, chainId: 4663} : {}), ...(replayed ? {replayed: true} : {}),
    message: 'This import could not be confirmed. It will not be applied again automatically; inspect the portfolio settings.' });
  const deps = { ...defaults, ...overrides }, root = resolve(rootDir);
  let session: string, requestedWallet: string | null;
  try {
    const id = sessionIdentity(sessionId, {});
    if (!id || typeof requestId !== 'string' || !/^[0-9a-f]{64}$/.test(requestId)) return blocked();
    session = id; requestedWallet = wallet === undefined ? null : walletIdentity(wallet);
  } catch { return blocked(); }
  const identity = { requestId: requestId!, sessionDigest: digest(session), codeDigest: digest(canonical), requestedWallet };
  const directory = resolve(root, 'share-receive'), path = resolve(directory, `${requestId}.json`);
  let releaseRequest: (() => Promise<void>);
  try { releaseRequest = await deps.requestLock(directory, `${requestId}.lock`); }
  // Another process may be committing this exact request; never claim no application.
  catch { return unknown(); }
  let selected: string | null = requestedWallet, committing = false;
  try {
    let existing: Journal | null;
    try {
      const saved = await deps.read<unknown>(path);
      existing = saved === null ? null : journal(saved, identity);
    } catch { return unknown(undefined, true); }
    if (existing) {
      if (existing.state === 'started' || existing.state === 'applying') return unknown(existing.wallet ?? undefined, true);
      if (existing.state === 'applied') return appliedResult(existing, true);
      if (existing.state === 'blocked') return blocked(existing.wallet ?? undefined, true);
      return selectorResult(true);
    }
    // Claim the native prompt before routing. Interrupted/failed attempts cannot later
    // follow a different attachment or become a fresh edit when a registry is repaired.
    await deps.write(path, {version: 1, ...identity, state: 'started', wallet: selected} satisfies Journal);
    if (!selected) {
      const connection = await deps.connection(root, session);
      if (connection !== null) {
        if (!isRecord(connection) || connection.version !== 1 || connection.chainId !== 4663) throw new Error('Invalid connection');
        selected = walletIdentity(connection.wallet);
      }
    }
    if (!selected) {
      await deps.write(path, {version: 1, ...identity, state: 'unselected', wallet: null} satisfies Journal);
      return selectorResult(false);
    }
    // Persist the captured wallet before fallible profile reads. No lone-wallet fallback.
    await deps.write(path, {version: 1, ...identity, state: 'started', wallet: selected} satisfies Journal);
    const profile = await deps.resolve(root, {wallet: selected});
    const route = {wallet: selected, directory: profile.directory};
    if (route.directory !== '.' && route.directory !== `wallets/${selected}`) throw new Error('Invalid portfolio directory');
    verifyProfile(root, profile, route);
    const releaseConfig = await deps.configLock(profile.dataDir);
    try {
      const config = validateConfig(await deps.config(profile));
      if (walletIdentity(config.wallet) !== route.wallet || config.chainId !== profile.chainId) throw new Error('Configuration identity changed');
      const next = withUserRebalanceRequest({...withoutAllocation(config), targets: shared.targets,
        ...(shared.driftThresholdBps === undefined ? {} : {driftThresholdBps: shared.driftThresholdBps}),
        ...(shared.rebalanceIntervalSeconds === undefined ? {} : {rebalanceIntervalSeconds: shared.rebalanceIntervalSeconds}),
      });
      const barrier: Journal = {version: 1, ...identity, state: 'applying', wallet: selected, route, beforeCode: encodeShareCode(config)};
      // Persist the uncertainty barrier before the first possible config write. Never retry through it.
      await deps.write(path, barrier);
      committing = true;
      await deps.write(resolve(profile.dataDir, 'config.json'), next);
      const receipt: Journal = {...barrier, state: 'applied'};
      await deps.write(path, receipt);
      return appliedResult(receipt, false);
    } finally {
      // A cleanup failure cannot undo or conceal a committed configuration. A leftover lock fails closed.
      await releaseConfig().catch(() => undefined);
    }
  } catch {
    if (committing) return unknown(selected ?? undefined);
    // A known prewrite refusal is terminal too. Never let its replay mutate a
    // repaired registry, newly selected wallet or subsequently edited configuration.
    try {
      await deps.write(path, {version: 1, ...identity, state: 'blocked', wallet: selected} satisfies Journal);
      return blocked(selected ?? undefined);
    } catch { return unknown(selected ?? undefined); }
  } finally { await releaseRequest().catch(() => undefined); }

  async function selectorResult(replayed: boolean) {
    let view;
    try { view = await deps.view(root, session); } catch (error) { view = publicViewFailure(error); }
    return {...base, outcome: 'select-portfolio' as const, applied: false as const, view,
      ...(replayed ? {replayed: true} : {}), message: 'Choose a portfolio, then paste the strategy again to apply it.'};
  }

  function appliedResult(receipt: Extract<Journal, {beforeCode: string}>, replay: boolean) {
    const before = savedStrategy(receipt.beforeCode);
    return {...base, outcome: 'applied' as const, applied: true as const, wallet: receipt.route.wallet, chainId: 4663,
      ...sharePreview(before, shared), targets: shared.targets,
      driftThresholdBps: shared.driftThresholdBps ?? before.driftThresholdBps,
      rebalanceIntervalSeconds: shared.rebalanceIntervalSeconds ?? before.rebalanceIntervalSeconds,
      settingsApplied: shared.driftThresholdBps !== undefined || shared.rebalanceIntervalSeconds !== undefined,
      effective: 'next graph evaluation; an already-broadcast transaction still settles', ...(replay ? {replayed: true} : {})};
  }
}
