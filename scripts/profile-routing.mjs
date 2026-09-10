import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const walletIdentity = value => {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error('Choose a wallet by its full public Ethereum address.');
  return value.toLowerCase();
};
export function portfolioRoot(env = process.env, root = repository) {
  return resolve(root, env.REBALANCE_ROOT_DIR || env.REBALANCE_DATA_DIR || '.local');
}
export function sessionIdentity(explicit, env = process.env) {
  const id = explicit ?? env.REBALANCE_SESSION_ID ?? env.CODEX_THREAD_ID ?? (env.CLAUDE_CODE_SESSION_ID ? `claude:${env.CLAUDE_CODE_SESSION_ID}` : undefined);
  if (id === undefined || id === '') return undefined;
  if (typeof id !== 'string' || id.length > 2048 || /[\0\r\n]/.test(id)) throw new Error('Invalid conversation identity.');
  return id;
}
export function connectionPath(root, sessionId) {
  if (!sessionIdentity(sessionId, {})) throw new Error('A stable conversation identity is required to connect.');
  return resolve(root, 'connections', `${createHash('sha256').update(sessionId).digest('hex')}.json`);
}
export async function readRoutingJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error('Wallet routing data is unavailable or invalid; existing portfolios were preserved.'); }
}
export async function validateProfileDirectory(root, directory) {
  for (const path of directory === '.' ? [root] : [root, resolve(root, 'wallets'), resolve(root, directory)]) {
    try { const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Wallet data must use a real local directory.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
export async function readProfiles(root) {
  const saved = await readRoutingJson(resolve(root, 'portfolios.json'));
  if (saved !== null && (saved.version !== 1 || !Array.isArray(saved.profiles))) throw new Error('Invalid wallet registry.');
  const entries = [...(saved?.profiles ?? [])];
  const wallets = new Set(), directories = new Set(), ports = new Set();
  for (const entry of entries) {
    const id = walletIdentity(entry.wallet);
    if (entry.chainId !== 4663 || (entry.directory !== '.' && entry.directory !== `wallets/${id}`) ||
        !Number.isInteger(entry.chartPort) || entry.chartPort < 4663 || entry.chartPort > 65535 ||
        (entry.directory === '.' ? entry.chartPort !== 4663 : entry.chartPort === 4663) ||
        wallets.has(id) || directories.has(entry.directory) || ports.has(entry.chartPort)) throw new Error('Invalid or duplicate wallet portfolio identity.');
    wallets.add(id); directories.add(entry.directory); ports.add(entry.chartPort);
  }
  // Adopt existing public identity in place. No private files or live state are moved.
  const legacy = saved !== null ? null : await readRoutingJson(resolve(root, 'config.json'));
  if (legacy) {
    const id = walletIdentity(legacy.wallet);
    if (legacy.chainId !== 4663) throw new Error('Only Robinhood mainnet portfolios are supported.');
    const entry = entries.find(p => walletIdentity(p.wallet) === id);
    if (entry && entry.directory !== '.') throw new Error('This wallet already has a different portfolio directory.');
    if (!entry) {
      if (directories.has('.')) throw new Error('Legacy wallet identity changed; preserve the existing portfolio.');
      entries.unshift({ wallet: id, chainId: 4663, directory: '.', chartPort: 4663 });
    }
  }
  return entries.map(entry => ({ ...entry, wallet: walletIdentity(entry.wallet), dataDir: resolve(root, entry.directory), rootDir: root }));
}
export async function resolveProfile(root, { wallet, sessionId } = {}) {
  const profiles = await readProfiles(root);
  let selected = wallet === undefined ? undefined : walletIdentity(wallet);
  if (!selected && sessionId) {
    const connection = await readRoutingJson(connectionPath(root, sessionId));
    if (connection !== null) {
      if (connection.version !== 1 || connection.chainId !== 4663) throw new Error('Invalid conversation wallet connection.');
      selected = walletIdentity(connection.wallet);
    }
  }
  if (selected) {
    const profile = profiles.find(p => p.wallet === selected);
    if (!profile) throw new Error('The selected wallet has no portfolio. Use wallet add or choose an existing wallet.');
    await validateProfileDirectory(root, profile.directory);
    return profile;
  }
  if (profiles.length > 1) throw new Error('Choose this conversation’s wallet with wallet connect <public-address>. Other portfolios keep running.');
  if (profiles[0]) await validateProfileDirectory(root, profiles[0].directory);
  return profiles[0] ?? { wallet: null, chainId: 4663, directory: '.', dataDir: root, rootDir: root, chartPort: 4663 };
}
