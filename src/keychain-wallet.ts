import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { getAddress, type Address } from 'viem';
import { english, generateMnemonic, mnemonicToAccount } from 'viem/accounts';
import { acquireLock, atomicWriteJson, stringifyJson } from './storage.js';
import { macosSeedStore, type SeedStore } from './macos-keychain.js';

type Path = `m/44'/60'/0'/0/${number}`;
type Reservation = { requestKey: string; accountIndex: number; address: Address; derivationPath: Path };
type Accounts = { version: 1; seedAddress: Address; accounts: Reservation[] };
type Vault = { version: 1; seedId: string; state: 'pending' | 'ready'; seedAddress?: Address; createdAt: string };
type Metadata = { address: Address; chainId: 4663; createdAt: string;
  hd: { version: 1; requestKey: string; accountIndex: number; derivationPath: Path };
  keychain: { version: 1; seedId: string; seedAddress: Address } };
const queues = new Map<string, Promise<unknown>>();
const words = new Map(english.map((word, index) => [word, index]));
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const address = (value: unknown): value is Address => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
const date = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const request = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const pathFor = (index: number): Path => `m/44'/60'/0'/0/${index}`;
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const failure = () => new Error('Keychain wallet setup could not be verified. Existing keys were not replaced; check macOS Keychain access.');

async function exists(path: string) {
  try { await lstat(path); return true; } catch (error) { if (missing(error)) return false; throw error; }
}
async function directory(path: string, create = true) {
  let current = parse(path).root;
  for (const part of path.slice(current.length).split('/').filter(Boolean)) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw failure();
    } catch (error) {
      if (!missing(error) || !create) throw error;
      try { await mkdir(current, { mode: 0o700 }); }
      catch (created) { if ((created as NodeJS.ErrnoException).code !== 'EEXIST') throw created; }
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw failure();
    }
  }
}
async function readPublic(path: string, max = 1024 * 1024): Promise<unknown | null> {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (missing(error)) return null; throw error; }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > max || (info.mode & 0o077)) throw failure();
    return JSON.parse(await file.readFile('utf8'));
  } finally { await file.close(); }
}
async function exclusivePublic(path: string, value: unknown) {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(stringifyJson(value)); await file.sync(); } finally { await file.close(); }
  const parent = await open(dirname(path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await parent.sync(); } finally { await parent.close(); }
}
function vaultRecord(value: unknown): Vault {
  if (!object(value) || value.version !== 1 || !uuid(value.seedId) || !date(value.createdAt) ||
      !['pending', 'ready'].includes(String(value.state)) ||
      (value.state === 'ready' ? !address(value.seedAddress) : value.seedAddress !== undefined)) throw failure();
  return value as Vault;
}
function reservations(value: unknown, seedAddress: Address): Accounts {
  if (!object(value) || value.version !== 1 || value.seedAddress !== seedAddress || !Array.isArray(value.accounts) || value.accounts.length > 10000) throw failure();
  const keys = new Set<string>(), addresses = new Set<string>();
  for (const [index, item] of value.accounts.entries()) {
    if (!object(item) || !request(item.requestKey) || keys.has(item.requestKey) || !address(item.address) ||
        addresses.has(item.address.toLowerCase()) || item.accountIndex !== index || item.derivationPath !== pathFor(index)) throw failure();
    keys.add(item.requestKey); addresses.add(item.address.toLowerCase());
  }
  if (value.accounts.length && value.accounts[0].address !== seedAddress) throw failure();
  return value as Accounts;
}
function seedMnemonic(value: string): string {
  const record: unknown = JSON.parse(value);
  if (!object(record) || record.version !== 1 || typeof record.mnemonic !== 'string' || !date(record.createdAt)) throw failure();
  const phrase = record.mnemonic.split(' ');
  if (phrase.length !== 24 || phrase.some(word => !words.has(word))) throw failure();
  const bits = phrase.map(word => words.get(word)!.toString(2).padStart(11, '0')).join('');
  const entropy = Buffer.from(Array.from({ length: 32 }, (_, index) => parseInt(bits.slice(index * 8, index * 8 + 8), 2)));
  if (parseInt(bits.slice(256), 2) !== createHash('sha256').update(entropy).digest()[0]) throw failure();
  return record.mnemonic;
}
function metadataRecord(value: unknown): Metadata {
  if (!object(value) || !address(value.address) || value.chainId !== 4663 || !date(value.createdAt) ||
      !object(value.keychain) || value.keychain.version !== 1 || !uuid(value.keychain.seedId) || !address(value.keychain.seedAddress) ||
      !object(value.hd) || value.hd.version !== 1 || !request(value.hd.requestKey) ||
      !Number.isSafeInteger(value.hd.accountIndex) || Number(value.hd.accountIndex) < 0 || Number(value.hd.accountIndex) >= 10000 ||
      value.hd.derivationPath !== pathFor(Number(value.hd.accountIndex))) throw failure();
  return value as Metadata;
}
function sameIdentity(a: Metadata, b: Metadata) {
  return a.address === b.address && a.chainId === b.chainId && a.createdAt === b.createdAt &&
    a.hd.requestKey === b.hd.requestKey && a.hd.accountIndex === b.hd.accountIndex && a.hd.derivationPath === b.hd.derivationPath &&
    a.keychain.seedId === b.keychain.seedId && a.keychain.seedAddress === b.keychain.seedAddress;
}
async function locked(root: string) {
  for (let attempt = 0; attempt < 400; attempt++) {
    for (const name of ['hd-wallet.lock', 'hd-wallet.lock.reclaim']) {
      const path = join(root, name);
      if (await exists(path)) {
        const info = await lstat(path).catch(error => { if (missing(error)) return null; throw error; });
        if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.mode & 0o077)) throw failure();
      }
    }
    try { return await acquireLock(root, 'hd-wallet.lock'); }
    catch (error) {
      if (!(error instanceof SyntaxError) && !(error instanceof Error && /^Lock hd-wallet\.lock (is held by process \d+|was acquired by another process)$/.test(error.message))) throw error;
      await delay(25);
    }
  }
  throw failure();
}

// Public wallet anchors survive independently of the shared reservation journal.
// Their presence prevents treating lost shared metadata as a fresh installation.
async function hasKeychainIdentity(root: string): Promise<boolean> {
  async function known(path: string) {
    if (await exists(join(path, 'keychain-wallet.json'))) return true;
    const wallet = await readPublic(join(path, 'wallet.json'), 4096);
    return object(wallet) && Object.hasOwn(wallet, 'keychain');
  }
  if (await known(root)) return true;
  const wallets = join(root, 'wallets');
  if (!await exists(wallets)) return false;
  await directory(wallets, false);
  const entries = await readdir(wallets, { withFileTypes: true });
  if (entries.length > 10000) throw failure();
  for (const entry of entries) {
    if (!/^0x[0-9a-f]{40}$/i.test(entry.name)) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw failure();
    if (await known(join(wallets, entry.name))) return true;
  }
  return false;
}

async function provision(root: string, requestKey: string, bootstrap: boolean, store: SeedStore) {
  await directory(root);
  if ((await lstat(root)).mode & 0o077) throw failure();
  const release = await locked(root);
  try {
    const hd = join(root, 'hd');
    await directory(hd);
    if ((await lstat(hd)).mode & 0o077) throw failure();
    // Existing file-based seeds require an explicit migration, never another seed.
    if (await exists(join(hd, 'seed.json'))) throw failure();
    if (bootstrap && !await exists(join(root, 'keychain-wallet.json')) &&
        (await exists(join(root, 'private-key')) || await exists(join(root, 'wallet.json')) || await exists(join(root, 'config.json')))) throw failure();
    const vaultPath = join(hd, 'keychain.json'), accountsPath = join(hd, 'accounts.json');
    const savedVault = await readPublic(vaultPath, 4096);
    const savedAccounts = await readPublic(accountsPath, 4 * 1024 * 1024);
    if ((savedVault === null || savedAccounts === null) && await hasKeychainIdentity(root)) throw failure();
    let vault: Vault;
    if (savedVault === null) {
      if (savedAccounts !== null) throw failure();
      vault = { version: 1, seedId: randomUUID(), state: 'pending', createdAt: new Date().toISOString() };
      // Publish only the opaque reservation before writing its immutable Keychain item.
      await exclusivePublic(vaultPath, vault);
    } else vault = vaultRecord(savedVault);
    let secret = await store.read(vault.seedId);
    if (secret === null) {
      if (vault.state !== 'pending' || savedAccounts !== null) throw failure();
      const generated = JSON.stringify({ version: 1, mnemonic: generateMnemonic(english, 256), createdAt: vault.createdAt });
      try { await store.create(vault.seedId, generated); }
      catch (error) {
        // A duplicate or uncertain insertion is reconciled at this same ID only.
        secret = await store.read(vault.seedId);
        if (secret === null) throw error;
      }
      secret ??= await store.read(vault.seedId);
      if (secret === null) throw failure();
    }
    const mnemonic = seedMnemonic(secret);
    const first = mnemonicToAccount(mnemonic, { path: pathFor(0) });
    if (vault.state === 'ready' && vault.seedAddress !== first.address) throw failure();
    if (vault.state === 'pending') {
      if (savedAccounts !== null) throw failure();
      const current = vaultRecord(await readPublic(vaultPath, 4096));
      if (JSON.stringify(current) !== JSON.stringify(vault)) throw failure();
      vault = { ...vault, state: 'ready', seedAddress: first.address };
      await atomicWriteJson(vaultPath, vault);
    }
    const accounts = savedAccounts === null ? { version: 1 as const, seedAddress: first.address, accounts: [] as Reservation[] }
      : reservations(savedAccounts, first.address);
    let reservation = accounts.accounts.find(item => item.requestKey === requestKey);
    const accountIndex = reservation?.accountIndex ?? accounts.accounts.length;
    if (accountIndex >= 10000) throw failure();
    const derivationPath = pathFor(accountIndex);
    const derived = accountIndex === 0 ? first : mnemonicToAccount(mnemonic, { path: derivationPath });
    if (reservation && (reservation.address !== derived.address || reservation.derivationPath !== derivationPath)) throw failure();
    const dataDir = bootstrap ? root : join(root, 'wallets', derived.address.toLowerCase());
    if (!bootstrap) {
      await directory(join(root, 'wallets'));
      if ((await lstat(join(root, 'wallets'))).mode & 0o077) throw failure();
    }
    if (!reservation) {
      if (!bootstrap && await exists(dataDir)) throw failure();
      if (bootstrap && (await exists(join(root, 'wallet.json')) || await exists(join(root, 'private-key')) ||
          await exists(join(root, 'keychain-wallet.json')) || await exists(join(root, 'config.json')))) throw failure();
      reservation = { requestKey, accountIndex, address: derived.address, derivationPath };
      accounts.accounts.push(reservation);
      await atomicWriteJson(accountsPath, accounts);
    }
    await directory(dataDir);
    if ((await lstat(dataDir)).mode & 0o077 || await exists(join(dataDir, 'private-key'))) throw failure();
    const walletPath = join(dataDir, 'wallet.json'), anchorPath = join(dataDir, 'keychain-wallet.json');
    const savedMetadata = await readPublic(walletPath, 4096), savedAnchor = await readPublic(anchorPath, 4096);
    const savedConfig = await readPublic(join(dataDir, 'config.json'));
    let metadata: Metadata;
    if (savedAnchor !== null) {
      metadata = metadataRecord(savedAnchor);
      if (metadata.address !== derived.address || metadata.hd.requestKey !== requestKey || metadata.hd.accountIndex !== accountIndex ||
          metadata.keychain.seedId !== vault.seedId || metadata.keychain.seedAddress !== first.address) throw failure();
    } else {
      if (savedMetadata !== null || savedConfig !== null || (!bootstrap && (await readdir(dataDir)).length)) throw failure();
      metadata = { address: derived.address, chainId: 4663, createdAt: new Date().toISOString(),
        hd: { version: 1, requestKey, accountIndex, derivationPath },
        keychain: { version: 1, seedId: vault.seedId, seedAddress: first.address } };
      await exclusivePublic(anchorPath, metadata);
    }
    if (savedMetadata !== null && !sameIdentity(metadata, metadataRecord(savedMetadata))) throw failure();
    if (savedConfig !== null && (!object(savedConfig) || savedConfig.wallet !== derived.address || savedConfig.chainId !== 4663 || savedConfig.mode !== 'private-key')) throw failure();
    if (savedMetadata === null) await exclusivePublic(walletPath, metadata);
    return { address: getAddress(derived.address), accountIndex, derivationPath, dataDir, created: savedMetadata === null };
  } finally { await release(); }
}

/** New macOS accounts share one Keychain seed; all returned fields are public. */
export async function createKeychainWallet(rootDir: string, requestKey: string, options: { bootstrap?: boolean; store?: SeedStore } = {}) {
  if (typeof rootDir !== 'string' || !isAbsolute(rootDir) || rootDir.length > 4096 || /[\0\r\n]/.test(rootDir) || !request(requestKey)) throw failure();
  const root = resolve(rootDir);
  const previous = queues.get(root);
  const operation = (previous?.catch(() => undefined) ?? Promise.resolve())
    .then(() => provision(root, requestKey, options.bootstrap === true, options.store ?? macosSeedStore()));
  queues.set(root, operation);
  try { return await operation; } catch { throw failure(); }
  finally { if (queues.get(root) === operation) queues.delete(root); }
}

/** Read only the selected Keychain identity. The derived key lives in process memory. */
export async function keychainAccount(dataDir: string, value: unknown, store: SeedStore = macosSeedStore()) {
  try {
    if (!isAbsolute(dataDir)) throw failure();
    await directory(dataDir, false);
    const metadata = metadataRecord(value), anchor = metadataRecord(await readPublic(join(dataDir, 'keychain-wallet.json'), 4096));
    if (!sameIdentity(metadata, anchor)) throw failure();
    const secret = await store.read(metadata.keychain.seedId);
    if (secret === null) throw failure();
    const mnemonic = seedMnemonic(secret);
    const first = mnemonicToAccount(mnemonic, { path: pathFor(0) });
    if (first.address !== metadata.keychain.seedAddress) throw failure();
    const account = metadata.hd.accountIndex === 0 ? first : mnemonicToAccount(mnemonic, { path: metadata.hd.derivationPath });
    if (account.address !== metadata.address) throw failure();
    return account;
  } catch { throw new Error('The Keychain wallet is unavailable or differs from its public identity. No fallback key was used.'); }
}
