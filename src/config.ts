import { constants } from 'node:fs';
import { chmod, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { getAddress, isAddress, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { acquireLock, atomicWriteJson, readJson } from './storage.js';
import { ASSETS } from './assets.js';

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
  driftThresholdBps: number;
  slippageBps: number;
  deadlineSeconds: number;
  pollSeconds: number;
};

export function validateConfig(value: unknown): Config {
  if (!value || typeof value !== 'object') throw new Error('Configuration must be an object');
  const c = value as Config;
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
  ] as const) {
    if (!Number.isInteger(c[name]) || c[name] < min || c[name] > max) throw new Error(`Invalid ${name} (${min}–${max})`);
  }
  return { ...c, wallet: getAddress(c.wallet) };
}

export async function loadConfig(): Promise<Config | null> {
  const value = await readJson<unknown>(CONFIG_PATH);
  return value === null ? null : validateConfig(value);
}

export function percentToBps(value: string): number {
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(value)) throw new Error('Use a percentage with at most two decimal places');
  const [whole, fraction = ''] = value.split('.');
  const bps = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (bps > 10000) throw new Error('Percentage cannot exceed 100');
  return bps;
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

export async function createWallet(): Promise<{ address: Address; created: boolean }> {
  const release = await acquireLock(DATA, 'wallet.lock');
  try {
    const walletPath = resolve(DATA, 'wallet.json');
    const metadata = await readJson<{ address: string; chainId: number; createdAt: string }>(walletPath);
    let account;
    let created = false;
    try {
      // Wallet creation/reuse always describes the file, never an env override.
      account = await fileAccount();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (metadata) throw new Error('Wallet metadata exists but its private key is missing; refusing to replace the wallet');
      const key = generatePrivateKey();
      const file = await open(KEY_PATH, 'wx', 0o600);
      try { await file.chmod(0o600); await file.writeFile(key + '\n'); await file.sync(); }
      finally { await file.close(); }
      account = privateKeyToAccount(key);
      created = true;
    }
    if (metadata) {
      if (typeof metadata.address !== 'string' || !isAddress(metadata.address, { strict: false }) ||
          getAddress(metadata.address) !== account.address || metadata.chainId !== 4663) {
        throw new Error('Wallet metadata does not match the local private key');
      }
    } else {
      // Recover public metadata after an interrupted first creation, reusing its key.
      await atomicWriteJson(walletPath, { address: account.address, chainId: 4663, createdAt: new Date().toISOString() });
    }
    return { address: account.address, created };
  } finally { await release(); }
}

export async function localAccount() {
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
