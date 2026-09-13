import { resolve } from 'node:path';
import { connectionPath, readProfiles, readRoutingJson, resolveProfile, sessionIdentity, walletIdentity, type RoutedProfile } from '../scripts/profile-routing.mjs';
import { validateConfig } from './config.js';
import { decodeShareCode, encodeSharedStrategy, sharePreview } from './share.js';
import { readJson } from './storage.js';
import { prepareView } from './view.js';
import { publicViewFailure } from './view-error.js';

export type SharePreviewDependencies = {
  profiles: typeof readProfiles;
  connection: (root: string, session: string) => Promise<unknown>;
  resolve: typeof resolveProfile;
  config: (profile: RoutedProfile) => Promise<unknown>;
  view: typeof prepareView;
};
const defaults: SharePreviewDependencies = {
  profiles: readProfiles,
  connection: (root, session) => readRoutingJson(connectionPath(root, session)),
  resolve: resolveProfile,
  config: profile => readJson(resolve(profile.dataDir, 'config.json')),
  view: prepareView,
};
const routingFailure = () => new Error('Share preview could not read the selected portfolio; no changes were made.');

/** Decode before touching local state; comparison never applies a strategy or starts a runner. */
export async function previewSharedCode(rootDir: string, sessionId: string | undefined, code: string, wallet?: string,
  overrides: Partial<SharePreviewDependencies> = {}) {
  let shared, canonical;
  try { shared = decodeShareCode(code); canonical = encodeSharedStrategy(shared); }
  catch { throw new Error('Invalid strategy share code; no changes were made.'); }
  const deps = {...defaults, ...overrides};
  const root = resolve(rootDir);
  let session: string | undefined, selected: string | undefined;
  try {
    session = sessionIdentity(sessionId, {});
    const profiles = await deps.profiles(root);
    selected = wallet === undefined ? undefined : walletIdentity(wallet);
    if (!selected && session) {
      const connection = await deps.connection(root, session);
      if (connection !== null) {
        if (!connection || typeof connection !== 'object' || !('version' in connection) || connection.version !== 1 ||
          !('chainId' in connection) || connection.chainId !== 4663 || !('wallet' in connection)) throw routingFailure();
        selected = walletIdentity(connection.wallet);
      }
    }
    if (!selected && profiles.length === 1) selected = walletIdentity(profiles[0]!.wallet);
  } catch { throw routingFailure(); }
  const base = { app: 'Rebalance', operation: 'share-import', code: canonical, applied: false } as const;
  if (!selected) {
    let view;
    try { view = await deps.view(root, session); }
    catch (error) { view = publicViewFailure(error); }
    return { ...base, outcome: 'select-portfolio' as const, shared: {targets: shared.targets,
      driftThresholdBps: shared.driftThresholdBps ?? null, rebalanceIntervalSeconds: shared.rebalanceIntervalSeconds ?? null}, view };
  }
  try {
    // Resolve by the captured identity, never reread the conversation's changing selection.
    const profile = await deps.resolve(root, {wallet: selected});
    if (profile.wallet !== selected || profile.chainId !== 4663 || profile.rootDir !== root ||
      profile.dataDir !== resolve(root, profile.directory)) throw routingFailure();
    const config = validateConfig(await deps.config(profile));
    if (walletIdentity(config.wallet) !== selected || config.chainId !== profile.chainId) throw routingFailure();
    return { ...base, outcome: 'preview' as const, ...sharePreview(config, shared) };
  } catch { throw routingFailure(); }
}
