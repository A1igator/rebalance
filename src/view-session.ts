import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { connectionPath, readProfiles, validateProfileDirectory, walletIdentity } from '../scripts/profile-routing.mjs';
import { connectPortfolio } from './profiles.js';
import { acquireLock, atomicWriteJson, readJson } from './storage.js';

const hex = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export type SetupMode = 'private-key' | 'privy' | 'ledger';
export type ViewDelivery = { kind: 'codex'; command?: string } | { kind: 'claude' } | { kind: 'opencode' } | null;
export type ViewRecord = { version: 1; sessionId: string; delivery: ViewDelivery; createdAt: string };
export type ViewSetupResult = { state: 'accepted' | 'pending' | 'uncertain'; requestId: string; message: string };
type StoredRequest = {
  version: 1; id: string; viewHash: string; sessionId: string; mode: SetupMode; requestId: string;
  state: 'prepared' | ViewSetupResult['state']; createdAt: string; queueId?: string; acknowledgedAt?: string;
};
export type ViewSetupRequest = StoredRequest & { message: string };
export type ViewSetupDependencies = {
  execute: (command: string, args: readonly string[]) => Promise<{ stdout: string }>;
  persist: (path: string, value: unknown) => Promise<void>;
};
const defaults: ViewSetupDependencies = {
  execute: (command, args) => new Promise((resolve, reject) => {
    execFile(command, [...args], { encoding: 'utf8', timeout: 10_000, maxBuffer: 32_768, killSignal: 'SIGKILL' },
      (error, stdout) => error ? reject(error) : resolve({ stdout }));
  }),
  persist: atomicWriteJson,
};
const failure = () => new Error('The conversation view or setup request is unavailable or invalid.');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
const time = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
function rootPath(root: string): string {
  if (typeof root !== 'string' || !isAbsolute(root) || root.length > 4096 || /[\0\r\n]/.test(root)) throw failure();
  return resolve(root);
}
function session(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\x00-\x1f\x7f]/.test(value)) throw failure();
  return uuid.test(value) ? value.toLowerCase() : value;
}
function delivery(value: unknown, sessionId: string): ViewDelivery {
  if (value === null) return null;
  if (!object(value)) throw failure();
  if (value.kind === 'opencode' && keys(value, ['kind']) && /^opencode:ses_[A-Za-z0-9]{1,128}$/.test(sessionId)) return { kind: 'opencode' };
  if (value.kind === 'claude' && keys(value, ['kind']) && sessionId.startsWith('claude:') && sessionId.length > 7) return { kind: 'claude' };
  if (value.kind === 'codex' && keys(value, ['kind', 'command']) && uuid.test(sessionId)) {
    const command = value.command ?? 'codex';
    if (typeof command === 'string' && (command === 'codex' || isAbsolute(command)) && command.length <= 1000 && !/[\x00-\x1f\x7f]/.test(command)) return { kind: 'codex', command };
  }
  throw failure();
}
function validateView(value: unknown): ViewRecord {
  if (!object(value) || !keys(value, ['version', 'sessionId', 'delivery', 'createdAt']) || value.version !== 1 || !time(value.createdAt)) throw failure();
  const sessionId = session(value.sessionId);
  return { version: 1, sessionId, delivery: delivery(value.delivery, sessionId), createdAt: value.createdAt };
}
async function safeDirectory(root: string, name: 'views' | 'ui-requests'): Promise<string> {
  root = rootPath(root);
  await validateProfileDirectory(root, '.');
  const path = resolve(root, name);
  try { const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink()) throw failure(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw failure(); }
  return path;
}
async function privateJson(path: string): Promise<unknown> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16_384 || (info.mode & 0o077) !== 0) throw failure();
    return await readJson(path);
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw failure(); }
}
function tokenHash(token: string): string { if (typeof token !== 'string' || !hex.test(token)) throw failure(); return hash(token); }
async function viewByHash(root: string, id: string): Promise<ViewRecord> {
  if (!hex.test(id)) throw failure();
  return validateView(await privateJson(resolve(await safeDirectory(root, 'views'), `${id}.json`)));
}

/** The bearer token stays in the local URL fragment; only its hash is persisted. */
export async function issueView(root: string, sessionId: string, descriptor?: ViewDelivery): Promise<{ token: string }> {
  sessionId = session(sessionId);
  const inferred = uuid.test(sessionId) ? { kind: 'codex' } : sessionId.startsWith('claude:') && sessionId.length > 7 ? { kind: 'claude' } : /^opencode:ses_[A-Za-z0-9]{1,128}$/.test(sessionId) ? { kind: 'opencode' } : null;
  const selected = delivery(descriptor === undefined ? inferred : descriptor, sessionId);
  const directory = await safeDirectory(root, 'views');
  const token = randomBytes(32).toString('hex');
  await atomicWriteJson(resolve(directory, `${hash(token)}.json`), {
    version: 1, sessionId, delivery: selected, createdAt: new Date().toISOString(),
  });
  return { token };
}
export async function readView(root: string, token: string): Promise<ViewRecord> { return viewByHash(root, tokenHash(token)); }
export async function viewState(root: string, token: string): Promise<{ connectedWallet: string | null; canSetup: boolean }> {
  const view = await readView(root, token);
  const profiles = await readProfiles(rootPath(root));
  const connection = await readJson<unknown>(connectionPath(rootPath(root), view.sessionId));
  let connectedWallet: string | null = null;
  if (connection !== null) {
    if (!object(connection) || !keys(connection, ['version', 'chainId', 'wallet']) || connection.version !== 1 || connection.chainId !== 4663) throw failure();
    connectedWallet = walletIdentity(connection.wallet);
    if (!profiles.some(profile => profile.wallet === connectedWallet)) throw failure();
  }
  return { connectedWallet, canSetup: view.delivery !== null };
}
export async function connectView(root: string, token: string, wallet: string) {
  const view = await readView(root, token);
  return connectPortfolio(rootPath(root), view.sessionId, walletIdentity(wallet));
}

function requestIdentity(viewHash: string, requestId: string): string { return hash(`${viewHash}\0${requestId}`); }
function setupMessage(record: Pick<StoredRequest, 'id' | 'mode' | 'requestId'>): string {
  const signer = record.mode === 'private-key' ? 'a new local raw private key' : record.mode === 'privy' ? 'Privy' : 'Ledger';
  return `Rebalance wallet setup request from this conversation's local companion view. Request ID: ${record.requestId}; setup record: ${record.id}. ` +
    `The user selected New wallet with ${signer}. Use the project Rebalance skill to prepare a separate portfolio with this signer and connect it to this same conversation. ` +
    'This is setup intent only: do not arm or stop trading, overwrite an existing wallet, change existing targets, sign or submit transactions. ' +
    'Keep key material out of chat, URLs and logs; use existing local-only or provider setup commands, never inspect another wallet’s secrets. ' +
    'Privy may require provider login; Ledger requires local hardware and physical confirmation where applicable. Do not claim setup or delivery succeeded before checking its actual outcome.';
}
function validateRequest(value: unknown, id: string): StoredRequest {
  if (!object(value) || !keys(value, ['version', 'id', 'viewHash', 'sessionId', 'mode', 'requestId', 'state', 'createdAt', 'queueId', 'acknowledgedAt']) ||
      value.version !== 1 || value.id !== id || !hex.test(id) || typeof value.viewHash !== 'string' || !hex.test(value.viewHash) ||
      !['private-key', 'privy', 'ledger'].includes(value.mode as string) || typeof value.requestId !== 'string' || !uuid.test(value.requestId) ||
      value.requestId !== value.requestId.toLowerCase() || id !== requestIdentity(value.viewHash, value.requestId) ||
      !['prepared', 'accepted', 'pending', 'uncertain'].includes(value.state as string) || !time(value.createdAt) ||
      (value.acknowledgedAt !== undefined && !time(value.acknowledgedAt)) ||
      (value.queueId !== undefined && (value.state !== 'accepted' || typeof value.queueId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(value.queueId)))) throw failure();
  session(value.sessionId);
  return value as StoredRequest;
}
async function request(root: string, id: string): Promise<StoredRequest | null> {
  if (typeof id !== 'string' || !hex.test(id)) throw failure();
  const saved = await privateJson(resolve(await safeDirectory(root, 'ui-requests'), `${id}.json`));
  if (saved === null) return null;
  const record = validateRequest(saved, id);
  const view = await viewByHash(root, record.viewHash);
  if (view.sessionId !== record.sessionId || !view.delivery || (record.state === 'pending' && view.delivery.kind !== 'claude')) throw failure();
  return record;
}
function result(record: StoredRequest): ViewSetupResult {
  const state = record.state === 'prepared' ? 'uncertain' : record.state;
  return { state, requestId: record.requestId, message: state === 'accepted'
    ? 'Setup request accepted by the agent transport. Wallet creation and agent receipt are not yet confirmed.'
    : state === 'pending' ? 'Setup request saved, waiting for this conversation’s Claude channel to connect. No wallet has been created by this request handler.'
      : 'Setup delivery could not be confirmed. This request will not be resent automatically; inspect it in the agent conversation.' };
}
const inFlight = new Map<string, { mode: SetupMode; promise: Promise<ViewSetupResult> }>();
export async function requestWalletSetup(root: string, token: string, mode: SetupMode, requestId: string,
  overrides: Partial<ViewSetupDependencies> = {}): Promise<ViewSetupResult> {
  root = rootPath(root);
  if (!['private-key', 'privy', 'ledger'].includes(mode) || typeof requestId !== 'string' || !uuid.test(requestId)) throw failure();
  requestId = requestId.toLowerCase();
  const view = await readView(root, token);
  if (!view.delivery) throw new Error('Open this companion view through a supported agent conversation to request wallet setup.');
  if (view.delivery.kind === 'opencode') throw new Error('Use the companion wallet setup buttons for OpenCode; setup runs locally without a model queue.');
  const viewHash = tokenHash(token), id = requestIdentity(viewHash, requestId), key = `${root}/${id}`;
  const running = inFlight.get(key);
  if (running) { if (running.mode !== mode) throw new Error('This setup request ID already names another signer choice.'); return running.promise; }
  const deps = { ...defaults, ...overrides };
  const pending = (async () => {
    const directory = await safeDirectory(root, 'ui-requests');
    const release = await acquireLock(directory, `${id}.lock`);
    let record: StoredRequest;
    try {
      const saved = await request(root, id);
      if (saved) {
        if (saved.mode !== mode || saved.sessionId !== view.sessionId || saved.viewHash !== viewHash) throw new Error('This setup request ID already names another signer choice.');
        return result(saved);
      }
      record = { version: 1, id, viewHash, sessionId: view.sessionId, mode, requestId,
        state: view.delivery!.kind === 'claude' ? 'pending' : 'prepared', createdAt: new Date().toISOString() };
      await deps.persist(resolve(directory, `${id}.json`), record);
    } finally { await release(); }
    if (view.delivery!.kind === 'claude') return result(record);
    try {
      const output = await deps.execute(view.delivery!.kind === 'codex' ? view.delivery!.command ?? 'codex' : 'codex',
        ['queue', '--thread', view.sessionId, '--message', setupMessage(record)]);
      const accepted = /^Queued message ([A-Za-z0-9_-]{1,160}) for thread ([0-9a-f-]{36})\.?\s*$/i.exec(output.stdout.trim());
      if (accepted?.[2].toLowerCase() === view.sessionId) { record.state = 'accepted'; record.queueId = accepted[1]; }
      else record.state = 'uncertain';
    } catch { record.state = 'uncertain'; }
    try {
      const release = await acquireLock(directory, `${id}.lock`);
      try {
        const latest = await request(root, id);
        if (!latest) throw failure();
        // A fast receiver may acknowledge while the native client is still
        // returning its acceptance. Preserve that concurrent session processing.
        if (latest.acknowledgedAt) record.acknowledgedAt = latest.acknowledgedAt;
        await deps.persist(resolve(directory, `${id}.json`), record);
      } finally { await release(); }
    }
    catch { return result({ ...record, state: 'uncertain' }); }
    return result(record);
  })();
  inFlight.set(key, { mode, promise: pending });
  try { return await pending; } finally { if (inFlight.get(key)?.promise === pending) inFlight.delete(key); }
}

/** Claude channel only: scoped, fixed-text requests, never a browser-provided prompt. */
export async function pendingViewRequests(root: string, sessionId: string): Promise<ViewSetupRequest[]> {
  sessionId = session(sessionId);
  const directory = await safeDirectory(root, 'ui-requests');
  let names: string[];
  try { names = await readdir(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  if (names.length > 4000) throw failure();
  const selected: ViewSetupRequest[] = [];
  for (const name of names.sort()) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const saved = await request(root, name.slice(0, -5));
    if (saved?.sessionId === sessionId && saved.state === 'pending' && !saved.acknowledgedAt) selected.push({ ...saved, message: setupMessage(saved) });
  }
  return selected;
}
async function changeRequest(root: string, sessionId: string, id: string, update: (record: StoredRequest) => boolean): Promise<ViewSetupRequest | null> {
  root = rootPath(root); sessionId = session(sessionId);
  if (typeof id !== 'string' || !hex.test(id)) throw failure();
  const directory = await safeDirectory(root, 'ui-requests');
  const release = await acquireLock(directory, `${id}.lock`);
  try {
    const saved = await request(root, id);
    if (!saved || saved.sessionId !== sessionId) throw failure();
    if (!update(saved)) return null;
    await atomicWriteJson(resolve(directory, `${id}.json`), saved);
    return { ...saved, message: setupMessage(saved) };
  } finally { await release(); }
}
export function beginViewRequestDelivery(root: string, sessionId: string, id: string): Promise<ViewSetupRequest | null> {
  return changeRequest(root, sessionId, id, record => {
    if (record.state !== 'pending' || record.acknowledgedAt) return false;
    record.state = 'prepared'; return true;
  });
}
export function completeViewRequestDelivery(root: string, sessionId: string, id: string, accepted: boolean): Promise<ViewSetupRequest | null> {
  if (typeof accepted !== 'boolean') return Promise.reject(failure());
  return changeRequest(root, sessionId, id, record => {
    if (record.state !== 'prepared') return false;
    record.state = accepted ? 'accepted' : 'uncertain'; return true;
  });
}
export function acknowledgeViewRequest(root: string, sessionId: string, id: string): Promise<ViewSetupRequest | null> {
  return changeRequest(root, sessionId, id, record => {
    if (record.acknowledgedAt) return false;
    record.acknowledgedAt = new Date().toISOString(); return true;
  });
}
