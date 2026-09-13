import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { readProfiles, sessionIdentity, validateProfileDirectory } from './profile-routing.mjs';

const problem = 'Running state inputs could not be verified.';
const missing = 'missing';
const digest = value => createHash('sha256').update(value).digest('hex');
const hash = value => typeof value === 'string' && (value === missing || /^[a-f0-9]{64}$/.test(value));
const keys = (value, allowed) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === allowed.length && Object.keys(value).every(key => allowed.includes(key));
const failure = () => new Error('App entry inputs could not be verified; no restoration was attempted.');
function directory(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || resolve(value) !== value) throw failure();
  return value;
}
function identity(rootDir, requestId, sessionId) {
  const root = directory(rootDir);
  if (typeof requestId !== 'string' || !requestId || requestId.length > 2048 || /[\0\r\n]/.test(requestId)) throw failure();
  const session = sessionIdentity(sessionId ?? undefined, {}) ?? null;
  return { root, requestId, session, path: resolve(root, 'app-entry-inputs', `${digest(requestId)}.json`) };
}
async function realDirectory(path) {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw failure();
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
async function publicFile(path, privateRecord = false) {
  let file;
  try {
    // No public filename can redirect this read to a key or another secret.
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await file.stat();
    if (!info.isFile() || info.size > 1_048_576 || privateRecord && (info.mode & 0o077) !== 0) throw failure();
    return await file.readFile();
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  finally { await file?.close(); }
}
async function publicHash(path) {
  const value = await publicFile(path);
  return value === null ? missing : digest(value);
}
async function statusHash(path) {
  const raw = await publicFile(path);
  if (raw === null) return missing;
  const value = JSON.parse(raw.toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure();
  // Observation timestamps and balances are not running intent. Preserve only
  // the identity/armed fields used to verify a legacy live runner.
  return digest(JSON.stringify({ app: value.app ?? null, wallet: value.wallet ?? null,
    chain: { id: value.chain?.id ?? null }, mode: value.mode ?? null, armed: value.armed ?? null }));
}
function validateInput(value) {
  if (!keys(value, value?.preference === missing ? ['preference', 'stop', 'legacy'] : ['preference', 'stop']) ||
      !hash(value.preference) || !hash(value.stop) || value.preference === missing &&
      (!keys(value.legacy, ['runLock', 'config', 'status']) || !Object.values(value.legacy).every(hash))) throw failure();
  return value;
}
async function captureInput(dataDir) {
  await realDirectory(directory(dataDir));
  const [preference, stop] = await Promise.all([
    publicHash(resolve(dataDir, 'runner-preference.json')), publicHash(resolve(dataDir, 'stop.json')),
  ]);
  if (preference !== missing) return { preference, stop };
  const [runLock, config, status] = await Promise.all([
    publicHash(resolve(dataDir, 'run.lock')), publicHash(resolve(dataDir, 'config.json')), statusHash(resolve(dataDir, 'status.json')),
  ]);
  return { preference, stop, legacy: { runLock, config, status } };
}
function validateJournal(value, context) {
  if (!keys(value, ['version', 'requestId', 'sessionId', 'entries']) || value.version !== 1 ||
      value.requestId !== context.requestId || value.sessionId !== context.session || !Array.isArray(value.entries)) throw failure();
  const wallets = new Set(), ports = new Set(), directories = new Set();
  for (const entry of value.entries) {
    if (!keys(entry, entry?.input === null ? ['profile', 'input', 'problem'] : ['profile', 'input'])) throw failure();
    const p = entry.profile;
    if (!keys(p, ['wallet', 'chainId', 'directory', 'dataDir', 'rootDir', 'chartPort']) ||
        p.rootDir !== context.root || typeof p.wallet !== 'string' || !/^0x[a-f0-9]{40}$/.test(p.wallet) || p.chainId !== 4663 ||
        !['.', `wallets/${p.wallet}`].includes(p.directory) || p.dataDir !== resolve(context.root, p.directory) ||
        !Number.isInteger(p.chartPort) || p.chartPort < 4663 || p.chartPort > 65535 ||
        (p.directory === '.' ? p.chartPort !== 4663 : p.chartPort === 4663) ||
        wallets.has(p.wallet) || ports.has(p.chartPort) || directories.has(p.directory)) throw failure();
    wallets.add(p.wallet); ports.add(p.chartPort); directories.add(p.directory);
    if (entry.input === null) { if (entry.problem !== problem) throw failure(); }
    else validateInput(entry.input);
  }
  return value;
}

/** Reads a frozen public-input receipt. Existing partial/corrupt files never become missing. */
export async function readAppEntryInputs(rootDir, requestId, sessionId) {
  try {
    const context = identity(rootDir, requestId, sessionId);
    await realDirectory(context.root);
    await realDirectory(resolve(context.root, 'app-entry-inputs'));
    const raw = await publicFile(context.path, true);
    return raw === null ? null : validateJournal(JSON.parse(raw.toString('utf8')), context);
  } catch { throw failure(); }
}

/** Captures public inputs only. It never adopts running intent or starts a service. */
export async function captureAppEntryInputs(rootDir, requestId, sessionId) {
  let file;
  try {
    const context = identity(rootDir, requestId, sessionId);
    const saved = await readAppEntryInputs(context.root, requestId, context.session);
    if (saved !== null) return saved;
    await validateProfileDirectory(context.root, '.');
    // readProfiles is dependency-free; reject public routing symlinks first.
    let registryMissing = false;
    try { const info = await lstat(resolve(context.root, 'portfolios.json')); if (!info.isFile() || info.isSymbolicLink()) throw failure(); }
    catch (error) { if (error.code !== 'ENOENT') throw error; registryMissing = true; }
    if (registryMissing) {
      try { const info = await lstat(resolve(context.root, 'config.json')); if (!info.isFile() || info.isSymbolicLink()) throw failure(); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const profiles = await readProfiles(context.root);
    const entries = await Promise.all(profiles.map(async profile => {
      try {
        await validateProfileDirectory(context.root, profile.directory);
        return { profile, input: await captureInput(profile.dataDir) };
      } catch { return { profile, input: null, problem }; }
    }));
    const record = validateJournal({ version: 1, requestId, sessionId: context.session, entries }, context);
    const parent = resolve(context.root, 'app-entry-inputs');
    await realDirectory(parent);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    try { file = await open(context.path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const winner = await readAppEntryInputs(context.root, requestId, context.session);
      if (winner === null) throw failure();
      return winner;
    }
    await file.writeFile(JSON.stringify(record) + '\n');
    await file.sync();
    try {
      const handle = await open(parent, 'r');
      try { await handle.sync(); } finally { await handle.close(); }
    } catch (error) {
      if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(error.code) &&
          !(process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code))) throw error;
    }
    return record;
  } catch { throw failure(); }
  finally { await file?.close(); }
}

/** Caller holds the wallet's control.lock; a mismatch cannot establish running intent. */
export async function runnerInputMatches(dataDir, input) {
  directory(dataDir); validateInput(input);
  try {
    const current = await captureInput(dataDir);
    return current.preference === input.preference && current.stop === input.stop &&
      (input.legacy === undefined || ['runLock', 'config', 'status'].every(key => current.legacy?.[key] === input.legacy[key]));
  }
  catch { return false; }
}
