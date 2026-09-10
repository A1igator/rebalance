import { createKeychainWallet } from './keychain-wallet.js';
import type { SeedStore } from './macos-keychain.js';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { getAddress, toHex, type Address } from 'viem';
import { english, generateMnemonic, mnemonicToAccount } from 'viem/accounts';
import { acquireLock, atomicWriteJson, stringifyJson } from './storage.js';

type Reservation = { requestKey: string; accountIndex: number; address: Address; derivationPath: `m/44'/60'/0'/0/${number}` };
type Accounts = { version: 1; seedAddress: Address; accounts: Reservation[] };
type Seed = { version: 1; mnemonic: string; createdAt: string };
type Wallet = { address: Address; accountIndex: number; derivationPath: string; dataDir: string };
const queues = new Map<string, Promise<Wallet>>();
const words = new Map(english.map((word, index) => [word, index]));
const failure = () => new Error('HD wallet setup could not be verified. Existing seed and wallet files were not replaced.');
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const date = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const address = (value: unknown): value is Address => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
const pathFor = (index: number): Reservation['derivationPath'] => `m/44'/60'/0'/0/${index}`;

async function syncDirectory(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); }
  finally { await handle.close(); }
}
/** Validate each existing component before creating a child; never follow a directory alias. */
async function directory(path: string) {
  const base = parse(path).root;
  let current = base;
  for (const part of path.slice(base.length).split('/').filter(Boolean)) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw failure();
    } catch (error) {
      if (!missing(error)) throw error;
      try { await mkdir(current, { mode: 0o700 }); await syncDirectory(dirname(current)); }
      catch (created) { if ((created as NodeJS.ErrnoException).code !== 'EEXIST') throw created; }
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw failure();
    }
  }
}
async function exists(path: string) {
  try { await lstat(path); return true; }
  catch (error) { if (missing(error)) return false; throw error; }
}
/** Descriptor checks avoid symlinks, special files, shared hard links and broad permissions. */
async function privateFile(path: string, maxBytes: number): Promise<string | null> {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (missing(error)) return null; throw error; }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > maxBytes || (info.mode & 0o077) !== 0) throw failure();
    return await handle.readFile('utf8');
  } finally { await handle.close(); }
}
async function exclusive(path: string, content: string) {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.chmod(0o600); await handle.writeFile(content, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  await syncDirectory(dirname(path));
}
function seedRecord(value: unknown): Seed {
  if (!object(value) || Object.keys(value).some(key => !['version', 'mnemonic', 'createdAt'].includes(key)) ||
      value.version !== 1 || typeof value.mnemonic !== 'string' || !date(value.createdAt)) throw failure();
  const phrase = value.mnemonic.split(' ');
  if (phrase.length !== 24 || phrase.some(word => !words.has(word))) throw failure();
  // A 24-word BIP-39 phrase encodes 256 entropy bits followed by an 8-bit checksum.
  const bits = phrase.map(word => words.get(word)!.toString(2).padStart(11, '0')).join('');
  const entropy = Buffer.from(Array.from({ length: 32 }, (_, index) => parseInt(bits.slice(index * 8, index * 8 + 8), 2)));
  if (parseInt(bits.slice(256), 2) !== createHash('sha256').update(entropy).digest()[0]) throw failure();
  return value as Seed;
}
function reservations(value: unknown): Accounts {
  if (!object(value) || Object.keys(value).some(key => !['version', 'seedAddress', 'accounts'].includes(key)) ||
      value.version !== 1 || !address(value.seedAddress) || !Array.isArray(value.accounts) || value.accounts.length > 10000) throw failure();
  const keys = new Set<string>(), addresses = new Set<string>();
  for (const [index, item] of value.accounts.entries()) {
    if (!object(item) || Object.keys(item).some(key => !['requestKey', 'accountIndex', 'address', 'derivationPath'].includes(key)) ||
        typeof item.requestKey !== 'string' || !/^[a-f0-9]{64}$/.test(item.requestKey) || keys.has(item.requestKey) ||
        item.accountIndex !== index || !address(item.address) || addresses.has(item.address.toLowerCase()) || item.derivationPath !== pathFor(index)) throw failure();
    keys.add(item.requestKey); addresses.add(item.address.toLowerCase());
  }
  if (value.accounts.length && value.accounts[0].address.toLowerCase() !== value.seedAddress.toLowerCase()) throw failure();
  return value as Accounts;
}
async function locked(root: string) {
  for (let attempt = 0; attempt < 400; attempt++) {
    await directory(root);
    await privateFile(join(root, 'hd-wallet.lock'), 4096);
    await privateFile(join(root, 'hd-wallet.lock.reclaim'), 4096);
    try { return await acquireLock(root, 'hd-wallet.lock'); }
    catch (error) {
      // Another process can observe the exclusively created lock before its first write.
      const initializing = error instanceof SyntaxError && attempt < 4;
      if (!initializing && (!(error instanceof Error) || !/^Lock hd-wallet\.lock (is held by process \d+|was acquired by another process)$/.test(error.message))) throw error;
      await pause(25);
    }
  }
  throw failure();
}
async function provision(root: string, requestKey: string): Promise<Wallet> {
  const release = await locked(root);
  try {
    const hd = join(root, 'hd');
    await directory(hd);
    const hdInfo = await lstat(hd);
    if ((hdInfo.mode & 0o077) !== 0) throw failure();
    const seedPath = join(hd, 'seed.json'), accountsPath = join(hd, 'accounts.json');
    const savedAccounts = await privateFile(accountsPath, 4 * 1024 * 1024);
    let accounts = savedAccounts === null ? null : reservations(JSON.parse(savedAccounts));
    let savedSeed = await privateFile(seedPath, 4096);
    if (savedSeed === null) {
      if (accounts !== null) throw failure();
      const seed = { version: 1, mnemonic: generateMnemonic(english, 256), createdAt: new Date().toISOString() };
      savedSeed = stringifyJson(seedRecord(seed));
      await exclusive(seedPath, savedSeed);
    }
    const seed = seedRecord(JSON.parse(savedSeed));
    const first = mnemonicToAccount(seed.mnemonic, { path: pathFor(0) });
    if (accounts && accounts.seedAddress.toLowerCase() !== first.address.toLowerCase()) throw failure();
    accounts ??= { version: 1, seedAddress: first.address, accounts: [] };
    let reservation = accounts.accounts.find(item => item.requestKey === requestKey);
    const fresh = !reservation;
    const accountIndex = reservation?.accountIndex ?? accounts.accounts.length;
    if (accountIndex >= 10000) throw failure();
    const derivationPath = pathFor(accountIndex);
    const derived = accountIndex === 0 ? first : mnemonicToAccount(seed.mnemonic, { path: derivationPath });
    if (reservation && reservation.address.toLowerCase() !== derived.address.toLowerCase()) throw failure();
    const dataDir = join(root, 'wallets', derived.address.toLowerCase());
    await directory(join(root, 'wallets'));
    if ((await lstat(join(root, 'wallets'))).mode & 0o077) throw failure();
    if (fresh) {
      if (await exists(dataDir)) throw failure();
      reservation = { requestKey, accountIndex, address: derived.address, derivationPath };
      accounts.accounts.push(reservation);
      // The index/address survives any later directory, key or registration failure.
      await atomicWriteJson(accountsPath, accounts);
    }
    await directory(dataDir);
    if ((await lstat(dataDir)).mode & 0o077) throw failure();
    const keyPath = join(dataDir, 'private-key'), walletPath = join(dataDir, 'wallet.json');
    const metadataText = await privateFile(walletPath, 4096);
    const metadata = metadataText === null ? null : JSON.parse(metadataText);
    if (metadata !== null && (!object(metadata) || metadata.address !== derived.address || metadata.chainId !== 4663 || !date(metadata.createdAt) ||
        !object(metadata.hd) || metadata.hd.version !== 1 || metadata.hd.requestKey !== requestKey || metadata.hd.accountIndex !== accountIndex || metadata.hd.derivationPath !== derivationPath)) throw failure();
    const configText = await privateFile(join(dataDir, 'config.json'), 1024 * 1024);
    if (configText !== null) {
      const config = JSON.parse(configText);
      if (!metadata || !object(config) || !address(config.wallet) || config.wallet.toLowerCase() !== derived.address.toLowerCase() || config.chainId !== 4663 || config.mode !== 'private-key') throw failure();
    }
    const key = toHex(derived.getHdKey().privateKey!);
    const storedKey = await privateFile(keyPath, 80);
    if (storedKey !== null && storedKey.trim() !== key) throw failure();
    if (storedKey === null) {
      // A reserved but otherwise empty directory is a safe interrupted first write.
      if (metadata || configText !== null || (await readdir(dataDir)).length) throw failure();
      await exclusive(keyPath, `${key}\n`);
    }
    if (!metadata) await exclusive(walletPath, stringifyJson({ address: derived.address, chainId: 4663, createdAt: new Date().toISOString(),
      hd: { version: 1, requestKey, accountIndex, derivationPath } }));
    return { address: getAddress(derived.address), accountIndex, derivationPath, dataDir };
  } finally { await release(); }
}

/** Creates only an isolated signer account; registration, chat selection and trading remain separate. */
export async function createHdWallet(rootDir: string, requestKey: string, options: { platform?: NodeJS.Platform; store?: SeedStore } = {}): Promise<Wallet> {
  if ((options.platform ?? process.platform) === 'darwin') return createKeychainWallet(rootDir, typeof requestKey === 'string' ? requestKey.toLowerCase() : requestKey, { store: options.store });
  let root: string;
  try {
    if (typeof rootDir !== 'string' || !isAbsolute(rootDir) || rootDir.length > 4096 || /[\0\r\n]/.test(rootDir) ||
        typeof requestKey !== 'string' || !/^[a-f0-9]{64}$/i.test(requestKey)) throw failure();
    root = resolve(rootDir); requestKey = requestKey.toLowerCase();
  } catch { throw failure(); }
  const previous = queues.get(root);
  const operation = (previous?.catch(() => undefined) ?? Promise.resolve()).then(() => provision(root, requestKey));
  queues.set(root, operation);
  try { return await operation; }
  catch { throw failure(); }
  finally { if (queues.get(root) === operation) queues.delete(root); }
}
