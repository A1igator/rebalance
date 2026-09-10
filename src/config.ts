import { assertTestStorageEnvironment } from './test-isolation.js';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { chmod, lstat, open } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { getAddress, isAddress, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { acquireLock, atomicWriteJson, readJson } from './storage.js';
import { ASSETS } from './assets.js';
import { validateManagedAllocation, type ManagedAllocation } from './allocation-management.js';
import type { SeedStore } from './macos-keychain.js';

assertTestStorageEnvironment();

export const DATA = resolve(process.env.REBALANCE_DATA_DIR || '.local');
export const CONFIG_PATH = resolve(DATA, 'config.json');
export const KEY_PATH = resolve(DATA, 'private-key');
export const STATE_PATH = resolve(DATA, 'status.json');
export const PENDING_PATH = resolve(DATA, 'pending.json');
export const LAST_TRANSACTION_PATH = resolve(DATA, 'last-transaction.json');

export type Config = {
  version: 1;
  chainId: 4663;
  wallet: Address;
  mode: 'private-key' | 'privy' | 'ledger';
  rpcUrl: string;
  targets: Record<string, number>;
  allocation?: ManagedAllocation;
  driftThresholdBps: number;
  slippageBps: number;
  deadlineSeconds: number;
  pollSeconds: number;
  rebalanceIntervalSeconds: number;
  rebalanceFeeTargetUsdE8?: string;
};

export function validateConfig(value: unknown): Config {
  if (!value || typeof value !== 'object') throw new Error('Configuration must be an object');
  // Do not reinterpret a saved gas-abstraction opt-in as native ETH execution.
  if (Object.hasOwn(value, 'gasPayment')) {
    throw new Error('The saved gasPayment setting is no longer supported. Preserve the configuration for review; native ETH was not selected automatically.');
  }
  const c = { ...value as Config };
  if (c.rebalanceIntervalSeconds === undefined) c.rebalanceIntervalSeconds = 3600;
  if (c.version !== 1 || c.chainId !== 4663) throw new Error('Only Robinhood mainnet (4663) is supported');
  if (!isAddress(c.wallet, { strict: false })) throw new Error('Invalid public wallet address');
  if (!['private-key', 'privy', 'ledger'].includes(c.mode)) throw new Error('Unknown signing mode');
  const url = new URL(c.rpcUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search) {
    throw new Error('Use an HTTP(S) RPC URL without credentials or query parameters');
  }
  if (!c.targets || typeof c.targets !== 'object' || Array.isArray(c.targets) ||
      Object.keys(c.targets).length !== 5 || !Object.hasOwn(c.targets, 'USDG') ||
      Object.keys(c.targets).some(id => !Object.hasOwn(ASSETS, id))) {
    throw new Error('Select exactly USDG plus four supported stock targets');
  }
  for (const weight of Object.values(c.targets)) {
    if (!Number.isInteger(weight) || weight < 0 || weight > 10000) throw new Error('Targets must be integer basis points');
  }
  if (Object.values(c.targets).reduce((a, b) => a + b, 0) !== 10000) throw new Error('Targets must total 100%');
  for (const [name, min, max] of [
    ['driftThresholdBps', 0, 10000], ['slippageBps', 1, 9999],
    ['deadlineSeconds', 15, 600], ['pollSeconds', 5, 3600],
    ['rebalanceIntervalSeconds', 1, 604800],
  ] as const) {
    if (!Number.isInteger(c[name]) || c[name] < min || c[name] > max) throw new Error(`Invalid ${name} (${min}–${max})`);
  }
  if (c.rebalanceFeeTargetUsdE8 !== undefined && (typeof c.rebalanceFeeTargetUsdE8 !== 'string' ||
      !/^(0|[1-9][0-9]{0,19})$/.test(c.rebalanceFeeTargetUsdE8))) {
    throw new Error('Invalid rebalanceFeeTargetUsdE8: use a canonical unsigned integer below 100000000000000000000');
  }
  if (c.allocation !== undefined) c.allocation = validateManagedAllocation(c.allocation, c.targets);
  return { ...c, wallet: getAddress(c.wallet) };
}

export async function loadConfig(): Promise<Config | null> {
  const value = await readJson<unknown>(CONFIG_PATH);
  const config = value === null ? null : validateConfig(value);
  const wallet = process.env.REBALANCE_PROFILE_WALLET;
  if (config && wallet && config.wallet.toLowerCase() !== wallet.toLowerCase()) {
    throw new Error('Configuration wallet differs from this pinned portfolio; no other wallet was selected.');
  }
  return config;
}

export function percentToBps(value: string): number {
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(value)) throw new Error('Use a percentage with at most two decimal places');
  const [whole, fraction = ''] = value.split('.');
  const bps = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (bps > 10000) throw new Error('Percentage cannot exceed 100');
  return bps;
}

/** Parse up to 12 whole USD digits and eight decimals without floating point. */
export function parseRebalanceFeeTargetUsd(input: string): string {
  if (typeof input !== 'string' || !/^\$?[0-9]{1,12}(?:\.[0-9]{1,8})?$/.test(input)) {
    throw new Error('Use a nonnegative USD amount with at most 12 whole digits and eight decimal places');
  }
  const [whole, fraction = ''] = input.replace(/^\$/, '').split('.');
  return (BigInt(whole!) * 100_000_000n + BigInt(fraction.padEnd(8, '0'))).toString();
}

export function parseTargets(input: string): Record<string, number> {
  const targets: Record<string, number> = {};
  for (const pair of input.split(',')) {
    const [asset, percent, extra] = pair.split('=');
    if (!asset || percent === undefined || extra !== undefined || Object.hasOwn(targets, asset)) {
      throw new Error('Targets format: ASSET=percent,... (USDG plus four supported stocks); no duplicate assets');
    }
    targets[asset] = percentToBps(percent);
  }
  return targets;
}

function accountFromKey(value: string) {
  const key = value.trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('The local private-key file is invalid');
  try { return privateKeyToAccount(key as Hex); }
  catch { throw new Error('The local private key is invalid'); }
}

async function fileAccount() {
  // Do not follow a provisioned key-file symlink or alter its external target.
  const file = await open(KEY_PATH, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await file.stat()).isFile()) throw new Error('The local private-key path must be a regular file');
    await file.chmod(0o600);
    return accountFromKey(await file.readFile('utf8'));
  } finally { await file.close(); }
}

/** Dependency injection is for isolated fixtures; normal callers use the host platform/store. */
export type LocalWalletOptions = { platform?: NodeJS.Platform; seedStore?: SeedStore };
const BOOTSTRAP_WALLET_REQUEST = createHash('sha256').update('rebalance:wallet:create:bootstrap:v1').digest('hex');

function hasLegacyWalletMetadata(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object' || !('address' in metadata) || !('chainId' in metadata)) return false;
  return !Object.hasOwn(metadata, 'keychain') && typeof metadata.address === 'string' &&
    isAddress(metadata.address, { strict: false }) && metadata.chainId === 4663;
}

function hasKeychainMetadata(metadata: unknown): boolean {
  return metadata !== null && typeof metadata === 'object' && Object.hasOwn(metadata, 'keychain');
}

const invalidWalletMetadata = () => new Error('Wallet public metadata is invalid or unavailable; no key was selected.');

/** Public identity files never follow aliases or expose parser/input text in errors. */
async function readWalletPublicJson(path: string, limit = 16_384): Promise<Record<string, unknown> | null> {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw invalidWalletMetadata();
  }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > limit) throw invalidWalletMetadata();
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > limit) throw invalidWalletMetadata();
    const value: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidWalletMetadata();
    return value as Record<string, unknown>;
  } catch { throw invalidWalletMetadata(); }
  finally { await file.close(); }
}

async function keychainMarkerExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Surviving root reservations still own a wallet after its child references disappear. */
async function knownKeychainIdentity(metadata: unknown): Promise<boolean> {
  const roots = new Set([DATA]);
  const selectorChild = basename(dirname(DATA)) === 'wallets' && isAddress(basename(DATA), { strict: false });
  if (selectorChild) roots.add(dirname(dirname(DATA)));
  const configuredRoot = process.env.REBALANCE_ROOT_DIR;
  if (configuredRoot && isAbsolute(configuredRoot)) {
    const root = resolve(configuredRoot), child = relative(root, DATA);
    if (child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`))) roots.add(root);
  }
  const addresses = new Set<string>();
  if (selectorChild) addresses.add(basename(DATA).toLowerCase());
  if (hasLegacyWalletMetadata(metadata)) addresses.add((metadata as { address: string }).address.toLowerCase());
  if (process.env.REBALANCE_PROFILE_WALLET && isAddress(process.env.REBALANCE_PROFILE_WALLET, { strict: false })) {
    addresses.add(process.env.REBALANCE_PROFILE_WALLET.toLowerCase());
  }
  for (const root of roots) {
    const vault = await keychainMarkerExists(resolve(root, 'hd', 'keychain.json'));
    // The original file-based HD backend owns this journal when no Keychain
    // vault exists. Missing seed plus surviving reservations remains fail-closed.
    if (!vault && await keychainMarkerExists(resolve(root, 'hd', 'seed.json'))) continue;
    const journal = await readWalletPublicJson(resolve(root, 'hd', 'accounts.json'), 4 * 1024 * 1024);
    if (journal === null) {
      if (vault && root !== DATA && (selectorChild || !hasLegacyWalletMetadata(metadata))) throw invalidWalletMetadata();
      continue;
    }
    if (!('version' in journal) || journal.version !== 1 || !('accounts' in journal) || !Array.isArray(journal.accounts)) {
      throw invalidWalletMetadata();
    }
    for (const reservation of journal.accounts) {
      if (!reservation || typeof reservation !== 'object' || typeof reservation.address !== 'string' ||
          !isAddress(reservation.address, { strict: false }) || typeof reservation.requestKey !== 'string') throw invalidWalletMetadata();
      if (addresses.has(reservation.address.toLowerCase()) || (root === DATA && reservation.requestKey === BOOTSTRAP_WALLET_REQUEST)) return true;
    }
    if (vault && root !== DATA && (selectorChild || !hasLegacyWalletMetadata(metadata))) throw invalidWalletMetadata();
  }
  return false;
}

export async function createWallet(options: LocalWalletOptions = {}): Promise<{ address: Address; created: boolean }> {
  const release = await acquireLock(DATA, 'wallet.lock');
  try {
    const walletPath = resolve(DATA, 'wallet.json');
    const metadata = await readWalletPublicJson(walletPath);
    // A Keychain identity is authoritative: never fall through to an env/file key
    // when its reference is malformed, its item is missing, or access is denied.
    if (hasKeychainMetadata(metadata) || await keychainMarkerExists(resolve(DATA, 'keychain-wallet.json'))) {
      const { keychainAccount } = await import('./keychain-wallet.js');
      const account = await keychainAccount(DATA, metadata, options.seedStore);
      return { address: account.address, created: false };
    }
    if (await knownKeychainIdentity(metadata)) {
      throw new Error('Keychain wallet metadata is missing or inconsistent; refusing to select another key');
    }
    if (await keychainMarkerExists(resolve(DATA, 'hd', 'keychain.json')) && !hasLegacyWalletMetadata(metadata)) {
      if (metadata) throw new Error('Keychain wallet metadata is missing or inconsistent; refusing to select another key');
      const { createKeychainWallet } = await import('./keychain-wallet.js');
      const wallet = await createKeychainWallet(DATA, BOOTSTRAP_WALLET_REQUEST, { bootstrap: true, store: options.seedStore });
      return { address: wallet.address, created: wallet.created };
    }
    let account;
    let created = false;
    try {
      // Wallet creation/reuse always describes the file, never an env override.
      account = await fileAccount();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (metadata) throw new Error('Wallet metadata exists but its private key is missing; refusing to replace the wallet');
      if ((options.platform ?? process.platform) === 'darwin') {
        const { createKeychainWallet } = await import('./keychain-wallet.js');
        const wallet = await createKeychainWallet(DATA, BOOTSTRAP_WALLET_REQUEST, { bootstrap: true, store: options.seedStore });
        return { address: wallet.address, created: wallet.created };
      }
      const key = generatePrivateKey();
      const file = await open(KEY_PATH, 'wx', 0o600);
      try { await file.chmod(0o600); await file.writeFile(key + '\n'); await file.sync(); }
      finally { await file.close(); }
      account = privateKeyToAccount(key);
      created = true;
    }
    if (metadata) {
      if (!('address' in metadata) || typeof metadata.address !== 'string' || !isAddress(metadata.address, { strict: false }) ||
          getAddress(metadata.address) !== account.address || !('chainId' in metadata) || metadata.chainId !== 4663) {
        throw new Error('Wallet metadata does not match the local private key');
      }
    } else {
      // Recover public metadata after an interrupted first creation, reusing its key.
      await atomicWriteJson(walletPath, { address: account.address, chainId: 4663, createdAt: new Date().toISOString() });
    }
    return { address: account.address, created };
  } finally { await release(); }
}

export async function localAccount(options: LocalWalletOptions = {}) {
  const metadata = await readWalletPublicJson(resolve(DATA, 'wallet.json'));
  if (hasKeychainMetadata(metadata) || await keychainMarkerExists(resolve(DATA, 'keychain-wallet.json'))) {
    const { keychainAccount } = await import('./keychain-wallet.js');
    return keychainAccount(DATA, metadata, options.seedStore);
  }
  if (await knownKeychainIdentity(metadata) || (await keychainMarkerExists(resolve(DATA, 'hd', 'keychain.json')) && !hasLegacyWalletMetadata(metadata))) {
    throw new Error('Keychain wallet metadata is missing or inconsistent; refusing to select another key');
  }
  if (process.env.REBALANCE_PRIVATE_KEY !== undefined) return accountFromKey(process.env.REBALANCE_PRIVATE_KEY);
  try {
    await chmod(DATA, 0o700);
    return await fileAccount();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('No local key found; use wallet create or provision .local/private-key locally');
    }
    throw error;
  }
}
