import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute, join, parse, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Observable, Subscription } from 'rxjs';
import { getAddress, isAddress, type Address } from 'viem';
import { acquireLock, atomicWriteJson } from './storage.js';
import type { SetupWallet, WalletSetupContext } from './wallet-setup-types.js';

type ActionState = { status: string; output?: unknown };
export type LedgerAddressAction = { observable: Observable<ActionState>; cancel(): void };
export type LedgerDevice = {
  getAddress(path: string, options: { checkOnDevice: boolean; returnChainCode: false }): LedgerAddressAction;
  close(): Promise<void>;
};
type LedgerManager = {
  listenToAvailableDevices(args: { transport: string }): Observable<readonly unknown[]>;
  connect(args: { device: unknown; sessionRefresherOptions: { isRefresherDisabled: true } }): Promise<string>;
  disconnect(args: { sessionId: string }): Promise<void>;
  close(): void | Promise<void>;
};
export type LedgerSdk = {
  manager: LedgerManager;
  signer(sessionId: string): Pick<LedgerDevice, 'getAddress'>;
};
export type LedgerOnboardingDependencies = {
  connect?: (signal: AbortSignal) => Promise<LedgerDevice>;
  loadSdk?: () => LedgerSdk;
  timeoutMs?: number;
};
type Reservation = {
  fingerprint: string;
  accountIndex: number;
  derivationPath: string;
  address?: Address;
  verifiedAt?: string;
};
type Accounts = { version: 1; requests: Record<string, Reservation> };
const MAX_INDEX = 2_147_483_647;
const MAX_REQUESTS = 10_000;
const TIMEOUT_MS = 120_000;
const CLEANUP_MS = 2_000;
const require = createRequire(import.meta.url);
const pathFor = (index: number) => `44'/60'/${index}'/0/0`;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasOnly = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key));
const storageError = () => new Error('Ledger account storage could not be verified. Existing files were preserved.');

async function safeDirectory(path: string): Promise<void> {
  let current = parse(path).root;
  for (const part of path.slice(current.length).split('/').filter(Boolean)) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw storageError();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      try { await mkdir(current, { mode: 0o700 }); }
      catch (created) { if ((created as NodeJS.ErrnoException).code !== 'EEXIST') throw created; }
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw storageError();
    }
  }
}

async function privateFile(path: string, maximum: number): Promise<string | null> {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw storageError(); }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > maximum || (info.mode & 0o077)) throw storageError();
    return await handle.readFile('utf8');
  } finally { await handle.close(); }
}

async function loadAccounts(file: string): Promise<Accounts> {
  const text = await privateFile(file, 4 * 1024 * 1024);
  let value: unknown;
  try { value = text === null ? null : JSON.parse(text); }
  catch { throw storageError(); }
  return readAccounts(value);
}

function address(value: unknown): Address {
  if (typeof value !== 'string' || !isAddress(value, { strict: false }) || /^0x0{40}$/i.test(value)) {
    throw new Error('Ledger returned an invalid public address.');
  }
  return getAddress(value);
}

function readAccounts(value: unknown): Accounts {
  if (value === null) return { version: 1, requests: {} };
  const invalid = () => new Error('Ledger account reservations are invalid; existing records were preserved.');
  if (!object(value) || !hasOnly(value, ['version', 'requests']) || value.version !== 1 || !object(value.requests)) throw invalid();
  const entries = Object.entries(value.requests);
  if (entries.length > MAX_REQUESTS) throw invalid();
  const used = new Set<string>();
  for (const [key, item] of entries) {
    if (!/^[a-f0-9]{64}$/.test(key) || !object(item) || !hasOnly(item, ['fingerprint', 'accountIndex', 'derivationPath', 'address', 'verifiedAt']) ||
      typeof item.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(item.fingerprint) ||
      !Number.isInteger(item.accountIndex) || Number(item.accountIndex) < 1 || Number(item.accountIndex) > MAX_INDEX ||
      item.derivationPath !== pathFor(Number(item.accountIndex)) || (item.address === undefined) !== (item.verifiedAt === undefined)) throw invalid();
    const identity = `${item.fingerprint}:${item.accountIndex}`;
    if (used.has(identity)) throw invalid();
    used.add(identity);
    if (item.address !== undefined) {
      address(item.address);
      if (typeof item.verifiedAt !== 'string' || !Number.isFinite(Date.parse(item.verifiedAt)) || new Date(item.verifiedAt).toISOString() !== item.verifiedAt) throw invalid();
    }
  }
  return value as Accounts;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Ledger setup was cancelled.');
}

/** Stop waiting promptly; any eventual connection is closed instead of being adopted. */
function abortable<T>(pending: Promise<T>, signal: AbortSignal, discard?: (value: T) => Promise<void>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const abort = () => {
      if (settled) return;
      settled = true;
      reject(signal.reason instanceof Error ? signal.reason : new Error('Ledger setup was cancelled.'));
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    pending.then(value => {
      signal.removeEventListener('abort', abort);
      if (settled) { void discard?.(value).catch(() => {}); return; }
      settled = true;
      resolve(value);
    }, error => {
      signal.removeEventListener('abort', abort);
      if (!settled) { settled = true; reject(error); }
    });
  });
}

async function closeDevice(device: Pick<LedgerDevice, 'close'>): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Ledger USB cleanup did not complete. Disconnect the device before trying again.')), CLEANUP_MS);
  try { await abortable(device.close(), controller.signal); }
  finally { clearTimeout(timer); }
}

function completedAddress(action: LedgerAddressAction, signal: AbortSignal): Promise<Address> {
  return new Promise((resolve, reject) => {
    let subscription: Subscription | undefined;
    let settled = false;
    const finish = (error?: Error, result?: Address) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      if (error) { try { action.cancel(); } catch { /* Closing the connection also cancels the action. */ } }
      subscription?.unsubscribe();
      if (error) reject(error); else resolve(result!);
    };
    const abort = () => finish(signal.reason instanceof Error ? signal.reason : new Error('Ledger setup was cancelled.'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    subscription = action.observable.subscribe({
      next: state => {
        if (settled) return;
        if (state.status === 'completed') {
          try {
            if (!object(state.output) || typeof state.output.publicKey !== 'string' || !/^(?:0x)?04[a-f0-9]{128}$/i.test(state.output.publicKey) || state.output.chainCode !== undefined) {
              throw new Error('Ledger returned an invalid address response.');
            }
            finish(undefined, address(state.output.address));
          } catch (error) { finish(error as Error); }
        } else if (state.status === 'error' || state.status === 'stopped') {
          finish(new Error('Ledger address verification was rejected or interrupted. Unlock the device and open Ethereum to try again.'));
        } else if (state.status !== 'pending' && state.status !== 'not-started') {
          finish(new Error('Ledger returned an unexpected device state.'));
        }
      },
      error: () => finish(new Error('Ledger disconnected or could not complete address verification.')),
      complete: () => { if (!settled) finish(new Error('Ledger did not complete address verification.')); },
    });
    // RxJS may synchronously emit a final result before subscribe() returns.
    if (settled) subscription.unsubscribe();
  });
}

function singleDevice(manager: LedgerManager, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let subscription: Subscription | undefined;
    let settled = false;
    const finish = (error?: Error, device?: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      subscription?.unsubscribe();
      if (error) reject(error); else resolve(device);
    };
    const abort = () => finish(signal.reason instanceof Error ? signal.reason : new Error('Ledger setup was cancelled.'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    subscription = manager.listenToAvailableDevices({ transport: 'NODE-HID' }).subscribe({
      next: devices => {
        if (devices.length > 1) finish(new Error('Connect only the Ledger you want to use, then try again.'));
        else if (devices.length === 1) finish(undefined, devices[0]);
      },
      error: () => finish(new Error('Ledger USB access is unavailable. Connect and unlock the device, then try again.')),
      complete: () => { if (!settled) finish(new Error('No Ledger device was found.')); },
    });
    if (settled) subscription.unsubscribe();
  });
}

function loadNativeSdk(): LedgerSdk {
  // These pinned packages publish Node-compatible CJS exports; their ESM files
  // contain extensionless imports. Native modules stay unloaded on other paths.
  const { DeviceManagementKitBuilder } = require('@ledgerhq/device-management-kit') as typeof import('@ledgerhq/device-management-kit');
  const { nodeHidTransportFactory } = require('@ledgerhq/device-transport-kit-node-hid') as typeof import('@ledgerhq/device-transport-kit-node-hid');
  const { SignerEthBuilder } = require('@ledgerhq/device-signer-kit-ethereum') as typeof import('@ledgerhq/device-signer-kit-ethereum');
  let transport: import('@ledgerhq/device-transport-kit-node-hid').NodeHidTransport | undefined;
  let exitListeners: ((code: number) => void)[] = [];
  const dmk = new DeviceManagementKitBuilder().addTransport(args => {
    const before = new Set(process.listeners('exit'));
    transport = nodeHidTransportFactory(args) as import('@ledgerhq/device-transport-kit-node-hid').NodeHidTransport;
    // Node HID 1.0.1 registers an exit callback without removing it in destroy().
    // Capture only callbacks installed synchronously by this owned transport.
    exitListeners = process.listeners('exit').filter(listener => !before.has(listener));
    return transport;
  }).build(); // No loggers/analytics subscribers.
  return {
    manager: {
      listenToAvailableDevices: args => dmk.listenToAvailableDevices(args),
      connect: args => dmk.connect(args as Parameters<typeof dmk.connect>[0]),
      disconnect: args => dmk.disconnect(args),
      close: async () => {
        let closing: Promise<void> | undefined;
        try { closing = Promise.resolve(dmk.close()); }
        finally {
          transport?.destroy();
          for (const listener of exitListeners) process.removeListener('exit', listener);
        }
        await closing;
      },
    },
    signer: sessionId => new SignerEthBuilder({ dmk, sessionId }).build(),
  };
}

async function connectDevice(signal: AbortSignal, load: () => LedgerSdk): Promise<LedgerDevice> {
  throwIfAborted(signal);
  let sdk: LedgerSdk;
  try { sdk = load(); }
  catch { throw new Error('Ledger USB support could not load. Check the installed SDK and native USB dependencies.'); }
  let sessionId: string | undefined;
  try {
    const device = await singleDevice(sdk.manager, signal);
    throwIfAborted(signal);
    sessionId = await abortable(sdk.manager.connect({ device, sessionRefresherOptions: { isRefresherDisabled: true } }), signal,
      async lateId => { await sdk.manager.disconnect({ sessionId: lateId }); });
    throwIfAborted(signal);
    const signer = sdk.signer(sessionId);
    let closed: Promise<void> | undefined;
    return {
      getAddress: (path, options) => signer.getAddress(path, options),
      close: () => closed ??= (async () => {
        // Destroy the owned native transport even if session disconnection stalls.
        const disconnecting = sdk.manager.disconnect({ sessionId: sessionId! });
        const closing = Promise.resolve(sdk.manager.close());
        const results = await Promise.allSettled([disconnecting, closing]);
        if (results.some(result => result.status === 'rejected')) throw new Error('Ledger USB cleanup failed. Disconnect the device before trying again.');
      })(),
    };
  } catch (error) {
    const disconnecting = sessionId ? sdk.manager.disconnect({ sessionId }) : Promise.resolve();
    try { await closeDevice({ close: async () => { await Promise.allSettled([disconnecting, Promise.resolve(sdk.manager.close())]); } }); }
    catch { /* Preserve the original setup failure after initiating native cleanup. */ }
    throw error;
  }
}

/** Derive and physically verify a public account. Never initializes a seed or signs. */
export async function setupLedgerWallet(context: WalletSetupContext, overrides: LedgerOnboardingDependencies = {}): Promise<SetupWallet> {
  if (typeof context.rootDir !== 'string' || !isAbsolute(context.rootDir) || context.rootDir.length > 4096 || /[\0\r\n]/.test(context.rootDir) ||
      !/^[a-f0-9]{64}$/.test(context.requestKey)) throw new Error('Invalid Ledger setup request.');
  const timeoutMs = overrides.timeoutMs ?? TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > TIMEOUT_MS) throw new Error('Invalid Ledger setup timeout.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Ledger setup timed out. Connect and unlock your Ledger, open Ethereum, then try again.')), timeoutMs);
  const signal = AbortSignal.any([context.signal, controller.signal]);
  const directory = resolve(context.rootDir, 'ledger-onboarding');
  const file = join(directory, 'accounts.json');
  let release: (() => Promise<void>) | undefined;
  let device: LedgerDevice | undefined;
  const progress = async (state: 'awaiting-device' | 'awaiting-approval', message: string) => {
    throwIfAborted(signal);
    await abortable(context.onProgress({ state, message }), signal);
  };
  try {
    throwIfAborted(signal);
    // One scoped device operation also serializes durable per-seed reservations.
    for (let attempt = 0; ; attempt++) {
      throwIfAborted(signal);
      await safeDirectory(directory);
      await privateFile(join(directory, 'device.lock'), 4096);
      await privateFile(join(directory, 'device.lock.reclaim'), 4096);
      try { release = await acquireLock(directory, 'device.lock'); break; }
      catch (error) {
        const initializing = error instanceof SyntaxError && attempt < 4;
        if (!initializing && (!(error instanceof Error) || !/^Lock device\.lock (is held by process \d+|was acquired by another process)$/.test(error.message))) throw error;
        await abortable(delay(25), signal);
      }
    }
    const accounts = await loadAccounts(file);
    const previous = accounts.requests[context.requestKey];
    if (previous?.address) return { address: previous.address, reused: true, accountIndex: previous.accountIndex, derivationPath: previous.derivationPath };
    await progress('awaiting-device', 'Connect and unlock your Ledger, then open the Ethereum app.');
    const connect = overrides.connect ?? ((signal: AbortSignal) => connectDevice(signal, overrides.loadSdk ?? loadNativeSdk));
    device = await abortable(connect(signal), signal, closeDevice);
    throwIfAborted(signal);
    const anchor = await completedAddress(device.getAddress(pathFor(0), { checkOnDevice: false, returnChainCode: false }), signal);
    const fingerprint = digest(anchor.toLowerCase());
    if (previous && previous.fingerprint !== fingerprint) throw new Error('This setup request belongs to a different Ledger account seed. Reconnect the original Ledger account to continue.');
    let reservation = previous;
    if (!reservation) {
      if (Object.keys(accounts.requests).length >= MAX_REQUESTS) throw new Error('Ledger account reservation storage is full.');
      let accountIndex = 1;
      for (const item of Object.values(accounts.requests)) {
        if (item.fingerprint === fingerprint) accountIndex = Math.max(accountIndex, item.accountIndex + 1);
      }
      if (accountIndex > MAX_INDEX) throw new Error('No further Ledger account indices are available.');
      reservation = { fingerprint, accountIndex, derivationPath: pathFor(accountIndex) };
      accounts.requests[context.requestKey] = reservation;
      throwIfAborted(signal);
      await atomicWriteJson(file, accounts);
    }
    await progress('awaiting-approval', 'Verify the new Ethereum account address on your Ledger. This creates a Robinhood portfolio without a transaction.');
    const verified = await completedAddress(device.getAddress(reservation.derivationPath, { checkOnDevice: true, returnChainCode: false }), signal);
    // Ensure a passphrase/seed change during setup cannot cross-bind this index.
    const finalAnchor = await completedAddress(device.getAddress(pathFor(0), { checkOnDevice: false, returnChainCode: false }), signal);
    if (finalAnchor !== anchor || verified === anchor || Object.values(accounts.requests).some(item => item.address?.toLowerCase() === verified.toLowerCase())) {
      throw new Error('Ledger account identity changed or the returned address is already reserved. Existing accounts were preserved.');
    }
    throwIfAborted(signal);
    accounts.requests[context.requestKey] = { ...reservation, address: verified, verifiedAt: new Date().toISOString() };
    await atomicWriteJson(file, accounts);
    return { address: verified, accountIndex: reservation.accountIndex, derivationPath: reservation.derivationPath };
  } finally {
    clearTimeout(timer);
    try { if (device) await closeDevice(device); }
    finally { await release?.(); }
  }
}
