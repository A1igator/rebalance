import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, readdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import type { ContextModule } from '@ledgerhq/context-module';
import { Observable, Subject, of } from 'rxjs';
import { bytesToHex, parseTransaction, serializeTransaction, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ledgerContextWithoutReports, setupLedgerWallet, watchLedgerPresence, type LedgerAddressAction, type LedgerDevice, type LedgerSdk } from '../src/ledger-onboarding.js';
import { LedgerSigningError, ledgerSigner, preparedLedgerTransaction, verifiedLedgerTransaction } from '../src/ledger-signing.js';
import type { PreparedTransaction } from '../src/privy.js';
import { atomicWriteJson } from '../src/storage.js';

// Published disposable vectors only. No device, wallet CLI, RPC or network is used.
const account = privateKeyToAccount(`0x${'1'.padStart(64, '0')}`);
const anchor = privateKeyToAccount(`0x${'2'.padStart(64, '0')}`).address;
const other = privateKeyToAccount(`0x${'3'.padStart(64, '0')}`);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const path = "44'/60'/1'/0/0";
const anchorPath = "44'/60'/0'/0/0";
const pub = `04${'12'.repeat(64)}`;
const tx: PreparedTransaction = { chainId: 4663, type: 'legacy', nonce: 0, gas: 310_001n,
  gasPrice: 9_007_199_254_740_993n, to: other.address, value: 0n,
  data: `0x095ea7b3${'00'.repeat(64)}` };
const done = (address: Address): LedgerAddressAction => ({ observable: of({ status: 'completed', output: { address, publicKey: pub } }), cancel() {} });
async function signature(input = tx, signer = account) {
  const raw = await signer.signTransaction(input);
  const { r, s, v } = parseTransaction(raw);
  return { r: r!, s: s!, v: Number(v!) };
}
async function fixture(t: TestContext) {
  const rootDir = await mkdtemp(join(await realpath(tmpdir()), 'rebalance-ledger-sign-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const journal = join(rootDir, 'ledger-onboarding', 'accounts.json');
  const record = { fingerprint: hash(anchor.toLowerCase()), accountIndex: 1, derivationPath: path,
    address: account.address, verifiedAt: '2026-09-09T00:00:00.000Z' };
  await atomicWriteJson(journal, { version: 1, requests: { [hash('first')]: record } });
  return { rootDir, journal, record };
}
async function device(output?: unknown) {
  const result = output ?? await signature();
  const addresses: string[] = [], signed: { path: string; raw: string }[] = [];
  let closes = 0;
  const adapter: LedgerDevice = {
    getAddress(path) { addresses.push(path); return done(path === anchorPath ? anchor : account.address); },
    signTransaction(path, transaction) { signed.push({ path, raw: bytesToHex(transaction) }); return { observable: of({ status: 'completed', output: result }), cancel() {} }; },
    async close() { closes++; },
  };
  return { adapter, addresses, signed, closes: () => closes };
}
const outcome = (expected: string) => (error: unknown) => error instanceof LedgerSigningError && error.outcome === expected;
async function until(condition: () => boolean) {
  for (let i = 0; i < 300; i++) { if (condition()) return; await delay(2); }
  assert.fail('Fixture did not reach the expected state');
}

test('Ledger load is hardware-free; signing uses the verified indexed path and exact legacy bytes', async t => {
  const f = await fixture(t), d = await device();
  let connects = 0;
  const before = await readFile(f.journal, 'utf8');
  const signer = await ledgerSigner(account.address, { rootDir: f.rootDir, connect: async () => { connects++; return d.adapter; } });
  assert.equal(connects, 0);
  const raw = await signer.signTransaction(tx);
  assert.equal(raw, await account.signTransaction(tx));
  assert.equal(connects, 1);
  assert.deepEqual(d.signed, [{ path, raw: serializeTransaction(tx) }]);
  assert.deepEqual(d.addresses, [anchorPath, path, anchorPath]);
  assert.equal(d.closes(), 1);
  assert.equal(await readFile(f.journal, 'utf8'), before);
  assert.deepEqual(await readdir(join(f.rootDir, 'ledger-onboarding')), ['accounts.json']);
  assert.deepEqual(await readdir(f.rootDir), ['ledger-onboarding']);
});

test('Ledger verifies SDK-expanded EIP-155 v and rejects signatures for changed sender or fields', async () => {
  assert.equal(await verifiedLedgerTransaction(await signature(), account.address, tx), await account.signTransaction(tx));
  await assert.rejects(verifiedLedgerTransaction(await signature(tx, other), account.address, tx), outcome('invalid-signature'));
  for (const changed of [{ chainId: 1 }, { nonce: 1 }, { gas: 300_000n }, { gasPrice: 2n },
    { to: account.address }, { value: 1n }, { data: '0x1234' }]) {
    const output = await signature({ ...tx, ...changed } as PreparedTransaction);
    await assert.rejects(verifiedLedgerTransaction(output, account.address, tx), outcome('invalid-signature'));
  }
  const signed = await signature();
  for (const bad of [null, 'sensitive bytes', {}, { ...signed, v: 27 }, { ...signed, v: 28 }, { ...signed, v: 37 },
    { ...signed, v: 145 }, { ...signed, r: `0x${'0'.repeat(64)}` }, { ...signed, s: `0x${'f'.repeat(64)}` },
    { ...signed, r: '0x11' }, { ...signed, details: 'sensitive bytes' }]) {
    await assert.rejects(verifiedLedgerTransaction(bad, account.address, tx), error => outcome('invalid-signature')(error) && !(error as Error).message.includes('sensitive bytes'));
  }
});

test('invalid prepared transactions fail before device access and snapshot is immutable', async t => {
  const f = await fixture(t);
  const signer = await ledgerSigner(account.address, { rootDir: f.rootDir, connect: async () => assert.fail('Invalid input must not connect') });
  for (const changed of [{ chainId: 1 }, { type: 'eip1559' }, { nonce: -1 }, { nonce: 1.5 }, { gas: 0n }, { gasPrice: 0n },
    { gasPrice: 2n ** 256n }, { accessList: [] }, { value: -1n }, { value: 1 }, { data: '0x1' }, { to: 'not an address' }]) {
    await assert.rejects(signer.signTransaction({ ...tx, ...changed } as PreparedTransaction), outcome('invalid-transaction'));
  }
  assert.ok(Object.isFrozen(preparedLedgerTransaction(tx)));
});

test('missing, incomplete, duplicate, malformed or aliased journals never guess a signing account', async t => {
  const f = await fixture(t);
  const connect = async () => assert.fail('No verified binding must never connect');
  const incomplete = { ...f.record, address: undefined, verifiedAt: undefined };
  const cases = [
    { version: 1, requests: {} },
    { version: 1, requests: { [hash('first')]: incomplete } },
    { version: 1, requests: { [hash('first')]: f.record, [hash('second')]: { ...f.record, accountIndex: 2, derivationPath: "44'/60'/2'/0/0" } } },
    { version: 1, requests: { [hash('first')]: { ...f.record, derivationPath: anchorPath } } },
  ];
  for (const data of cases) {
    await atomicWriteJson(f.journal, data);
    await assert.rejects(ledgerSigner(account.address, { rootDir: f.rootDir, connect }), outcome('account-mismatch'));
  }
  await atomicWriteJson(f.journal, { version: 1, requests: { [hash('first')]: f.record } });
  await chmod(f.journal, 0o644);
  await assert.rejects(ledgerSigner(account.address, { rootDir: f.rootDir, connect }), outcome('account-mismatch'));
  await chmod(f.journal, 0o600);
  const alias = join(f.rootDir, 'alias');
  await symlink(join(f.rootDir, 'ledger-onboarding'), alias);
  await assert.rejects(ledgerSigner(account.address, { rootDir: alias, connect }), outcome('account-mismatch'));
});

test('wrong device seed or derived account prevents signature and closes the transport', async t => {
  const f = await fixture(t);
  for (const wrong of ['anchor', 'selected']) {
    const d = await device();
    d.adapter.getAddress = p => done(p === anchorPath ? (wrong === 'anchor' ? other.address : anchor) : other.address);
    const signer = await ledgerSigner(account.address, { rootDir: f.rootDir, connect: async () => d.adapter });
    await assert.rejects(signer.signTransaction(tx), outcome('account-mismatch'));
    assert.equal(d.signed.length, 0); assert.equal(d.closes(), 1);
  }
});

test('journal is revalidated under the hardware mutex; post-sign anchor changes discard signature', async t => {
  const f = await fixture(t), d = await device();
  const signer = await ledgerSigner(account.address, { rootDir: f.rootDir, connect: async () => d.adapter });
  await atomicWriteJson(f.journal, { version: 1, requests: {} });
  await assert.rejects(signer.signTransaction(tx), outcome('account-mismatch'));
  assert.equal(d.signed.length, 0);
  await atomicWriteJson(f.journal, { version: 1, requests: { [hash('first')]: f.record } });
  let reads = 0;
  d.adapter.getAddress = p => done(p === anchorPath ? (++reads > 1 ? other.address : anchor) : account.address);
  await assert.rejects(signer.signTransaction(tx), outcome('account-mismatch'));
  assert.equal(d.signed.length, 1); assert.equal(d.closes(), 2);
});

test('device rejection stays distinct and sanitized, and no retry is made', async t => {
  const f = await fixture(t);
  for (const error of [{ _tag: 'RefusedByUserDAError' }, { errorCode: '5501' }, { originalError: { errorCode: '6985' } }, { errorCode: 0x6982 }]) {
    const d = await device(); let signs = 0, cancels = 0;
    d.adapter.signTransaction = () => { signs++; return { observable: of({ status: 'error', error: { ...error, message: 'sensitive bytes' } }), cancel() { cancels++; } }; };
    const signer = await ledgerSigner(account.address, { rootDir: f.rootDir, connect: async () => d.adapter });
    await assert.rejects(signer.signTransaction(tx), rejection => outcome('rejected')(rejection) && !(rejection as Error).message.includes('sensitive bytes'));
    assert.equal(signs, 1); assert.equal(cancels, 1); assert.equal(d.closes(), 1);
  }
});

test('timeout and caller cancellation unsubscribe, cancel the device action, and release its mutex', async t => {
  const f = await fixture(t);
  for (const mode of ['timeout', 'cancelled']) {
    const d = await device(), controller = new AbortController();
    let subscribed = false, unsubscribed = 0, cancelled = 0;
    d.adapter.signTransaction = () => ({ observable: new Observable(subscriber => {
      subscribed = true; subscriber.next({ status: 'pending' }); return () => { unsubscribed++; };
    }), cancel() { cancelled++; } });
    const signer = await ledgerSigner(account.address, { rootDir: f.rootDir, timeoutMs: mode === 'timeout' ? 100 : 5000,
      signal: controller.signal, connect: async () => d.adapter });
    const pending = signer.signTransaction(tx);
    const rejected = assert.rejects(pending, outcome(mode));
    await until(() => subscribed);
    if (mode === 'cancelled') controller.abort(new Error('sensitive cancellation detail'));
    await rejected;
    assert.equal(unsubscribed, 1); assert.equal(cancelled, 1); assert.equal(d.closes(), 1);
    assert.deepEqual(await readdir(join(f.rootDir, 'ledger-onboarding')), ['accounts.json']);
  }
});

test('SDK fallback and unexpected terminal streams are refused without another action', async t => {
  const f = await fixture(t);
  for (const [events, expected] of [
    [[{ status: 'pending', intermediateValue: { step: 'signer.eth.steps.blindSignTransactionFallback' } }], 'unsupported'],
    [[{ status: 'stopped' }], 'cancelled'], [[{ status: 'mystery' }], 'unavailable'],
    [[{ status: 'error', error: { message: 'sensitive bytes' } }], 'unavailable'], [[], 'unavailable'],
  ] as const) {
    const d = await device(); let cancelled = 0;
    d.adapter.signTransaction = () => ({ observable: of(...events), cancel() { cancelled++; } });
    const signer = await ledgerSigner(account.address, { rootDir: f.rootDir, connect: async () => d.adapter });
    await assert.rejects(signer.signTransaction(tx), outcome(expected));
    assert.equal(cancelled, 1); assert.equal(d.closes(), 1);
  }
});

test('caller mutation while device waits cannot change the prepared transaction', async t => {
  const f = await fixture(t), d = await device(), action = new Subject<{ status: string; output?: unknown }>();
  let signing = false;
  d.adapter.signTransaction = (_path, raw) => {
    assert.equal(bytesToHex(raw), serializeTransaction(tx)); signing = true;
    return { observable: action, cancel() {} };
  };
  const signer = await ledgerSigner(account.address, { rootDir: f.rootDir, connect: async () => d.adapter });
  const mutable = { ...tx }, pending = signer.signTransaction(mutable);
  await until(() => signing);
  mutable.value = 999n; mutable.to = account.address; mutable.data = '0x';
  action.next({ status: 'completed', output: await signature() });
  assert.equal(await pending, await account.signTransaction(tx));
});

test('signing waits for onboarding to release the same device mutex', async t => {
  const f = await fixture(t), verification = new Subject<{ status: string; output?: unknown }>();
  let verificationStarted = false, connects = 0;
  const setupDevice: LedgerDevice = {
    getAddress(p) {
      if (p === anchorPath) return done(anchor);
      assert.equal(p, "44'/60'/2'/0/0"); verificationStarted = true;
      return { observable: verification, cancel() {} };
    }, async close() {},
  };
  const setup = setupLedgerWallet({ rootDir: f.rootDir, requestKey: hash('next'), signal: new AbortController().signal,
    onProgress: async () => {} }, { connect: async () => setupDevice });
  await until(() => verificationStarted);
  const d = await device(), signer = await ledgerSigner(account.address, { rootDir: f.rootDir, connect: async () => { connects++; return d.adapter; } });
  const pending = signer.signTransaction(tx);
  await delay(40); assert.equal(connects, 0);
  verification.next({ status: 'completed', output: { address: other.address, publicKey: pub } });
  await setup;
  assert.equal(await pending, await account.signTransaction(tx));
  assert.equal(connects, 1);
});

test('late connections after cancellation are disposed without addresses or signing', async t => {
  const f = await fixture(t), d = await device(), controller = new AbortController();
  let connectStarted = false;
  let finishConnect!: (device: LedgerDevice) => void;
  const signer = await ledgerSigner(account.address, { rootDir: f.rootDir, signal: controller.signal,
    connect: async () => { connectStarted = true; return new Promise(resolve => { finishConnect = resolve; }); } });
  const pending = signer.signTransaction(tx), rejected = assert.rejects(pending, outcome('cancelled'));
  await until(() => connectStarted); controller.abort(); await rejected;
  finishConnect(d.adapter); await until(() => d.closes() === 1);
  assert.deepEqual(d.addresses, []); assert.deepEqual(d.signed, []);
});

test('context wrapper preserves metadata methods and receiver while disabling both report APIs', async () => {
  const calls: string[] = [];
  const source = {
    marker: true,
    async getContexts() { assert.equal(this.marker, true); calls.push('contexts'); return []; },
    async getFieldContext() { assert.equal(this.marker, true); calls.push('field'); return {}; },
    async getTypedDataFilters() { assert.equal(this.marker, true); calls.push('typed'); return {}; },
    async report() { assert.fail('Signing telemetry must stay disabled'); },
    async signReport() { assert.fail('Signing telemetry must stay disabled'); },
  };
  const wrapped = ledgerContextWithoutReports(source as unknown as ContextModule);
  await wrapped.getContexts({});
  await wrapped.getFieldContext({}, 'fixture' as never);
  await wrapped.getTypedDataFilters({} as never);
  await wrapped.report({} as never); await wrapped.signReport!({} as never);
  assert.deepEqual(calls, ['contexts', 'field', 'typed']);
});


test('presence watcher emits initial status and changes only without opening a device or signer', async () => {
  const devices = new Subject<readonly unknown[]>(), changes: boolean[] = [];
  let closes = 0;
  const sdk: LedgerSdk = {
    manager: {
      listenToAvailableDevices(args) { assert.deepEqual(args, { transport: 'NODE-HID' }); return devices; },
      async connect() { assert.fail('Presence must not connect'); },
      async disconnect() { assert.fail('Presence owns no session'); },
      async close() { closes++; },
    },
    signer() { assert.fail('Presence must not construct a signer/context'); },
  };
  const close = watchLedgerPresence(value => changes.push(value), { loadSdk: () => sdk });
  devices.next([]); devices.next([]); devices.next([{}]); devices.next([{}]);
  devices.next([{}, {}]); devices.next([]); devices.next([{}]);
  assert.deepEqual(changes, [false, true, false, false, true]);
  await close(); await close();
  devices.next([]);
  assert.equal(closes, 1); assert.deepEqual(changes, [false, true, false, false, true]);
  assert.equal(devices.observed, false);
});

test('presence failure emits unavailable and disposes its own SDK; load failure stays a false hint', async () => {
  const devices = new Subject<readonly unknown[]>(), changes: boolean[] = [];
  let closes = 0;
  const sdk: LedgerSdk = {
    manager: { listenToAvailableDevices: () => devices,
      async connect() { assert.fail('Presence must not connect'); }, async disconnect() { assert.fail('No session'); },
      async close() { closes++; } },
    signer() { assert.fail('No signer'); },
  };
  const close = watchLedgerPresence(value => changes.push(value), { loadSdk: () => sdk });
  devices.next([{}]); devices.error(new Error('sensitive USB information'));
  await close();
  assert.equal(closes, 1); assert.deepEqual(changes, [true, false]);
  const unavailable: boolean[] = [];
  await watchLedgerPresence(value => unavailable.push(value), { loadSdk: () => { throw new Error('sensitive native error'); } })();
  assert.deepEqual(unavailable, [false]);
});


test('cancellation during transport cleanup discards an otherwise valid signature', async t => {
  const f = await fixture(t), d = await device(), controller = new AbortController();
  d.adapter.close = async () => { controller.abort(); };
  const signer = await ledgerSigner(account.address, { rootDir: f.rootDir, signal: controller.signal,
    connect: async () => d.adapter });
  await assert.rejects(signer.signTransaction(tx), outcome('cancelled'));
  assert.equal(d.signed.length, 1);
});

test('malformed device state fails promptly without an unhandled observable exception', async t => {
  const f = await fixture(t), d = await device();
  d.adapter.signTransaction = () => ({ observable: of(null) as unknown as LedgerAddressAction['observable'], cancel() {} });
  const signer = await ledgerSigner(account.address, { rootDir: f.rootDir, connect: async () => d.adapter });
  await assert.rejects(signer.signTransaction(tx), outcome('unavailable'));
  assert.equal(d.closes(), 1);
});


test('Ledger diagnostics locate connection and address failures without exposing SDK payloads', async t => {
  const f = await fixture(t);
  const secret = 'DO-NOT-LOG-request-body-or-credential';
  const blocked = await ledgerSigner(account.address, { rootDir: f.rootDir, connect: async () => {
    throw { _tag: 'SendApduTimeoutError', message: secret, originalError: { request: secret } };
  } });
  await assert.rejects(blocked.signTransaction(tx), error => {
    assert.ok(error instanceof LedgerSigningError);
    assert.equal(error.diagnostic?.phase, 'connect');
    assert.equal(error.diagnostic?.errorTag, 'SendApduTimeoutError');
    assert.ok(!JSON.stringify(error).includes(secret));
    assert.ok(!error.message.includes(secret));
    return true;
  });
  const d = await device();
  d.adapter.getAddress = () => ({ observable: of({ status: 'error', error: {
    _tag: 'EthAppCommandError', errorCode: '6982', message: secret,
  } }), cancel() {} });
  const unavailable = await ledgerSigner(account.address, { rootDir: f.rootDir, connect: async () => d.adapter });
  await assert.rejects(unavailable.signTransaction(tx), error => {
    assert.ok(error instanceof LedgerSigningError);
    assert.equal(error.diagnostic?.phase, 'anchor-read');
    assert.equal(error.diagnostic?.deviceCode, '0x6982');
    assert.equal(error.diagnostic?.errorTag, 'EthAppCommandError');
    assert.ok(!error.message.includes(secret));
    return true;
  });
  assert.equal(d.signed.length, 0);
});

test('Ledger diagnostic metadata steps distinguish pre-prompt failure and never contain signature or HTTP contents', async t => {
  const f = await fixture(t), d = await device();
  const secret = 'DO-NOT-LOG-signature-url-response';
  d.adapter.signTransaction = () => ({ observable: of(
    { status: 'pending', intermediateValue: { step: 'signer.eth.steps.buildContexts', requiredUserInteraction: 'none', response: secret } },
    { status: 'error', error: { name: 'DmkNetworkClientError', status: 403, isTimeout: false, url: secret, message: secret } },
  ), cancel() {} });
  const signer = await ledgerSigner(account.address, { rootDir: f.rootDir, connect: async () => d.adapter });
  await assert.rejects(signer.signTransaction(tx), error => {
    assert.ok(error instanceof LedgerSigningError);
    assert.equal(error.outcome, 'unavailable');
    assert.equal(error.diagnostic?.phase, 'sign');
    assert.equal(error.diagnostic?.step, 'signer.eth.steps.buildContexts');
    assert.equal(error.diagnostic?.interaction, 'none');
    assert.equal(error.diagnostic?.httpStatus, 403);
    assert.equal(error.diagnostic?.networkTimeout, false);
    assert.ok(Number.isSafeInteger(error.diagnostic?.elapsedMs));
    assert.ok(!JSON.stringify(error).includes(secret));
    assert.ok(!error.message.includes(secret));
    return true;
  });
  assert.equal(d.closes(), 1);
});

test('Ledger diagnostics omit unrecognized provider fields and pending-step strings', async t => {
  const f = await fixture(t), d = await device();
  const secret = 'UNRECOGNIZED-PRIVATE-PAYLOAD';
  d.adapter.signTransaction = () => ({ observable: of(
    { status: 'pending', intermediateValue: { step: secret, requiredUserInteraction: secret } },
    { status: 'error', error: { _tag: secret, errorCode: secret, status: secret, message: secret, stack: secret } },
  ), cancel() {} });
  const signer = await ledgerSigner(account.address, { rootDir: f.rootDir, connect: async () => d.adapter });
  await assert.rejects(signer.signTransaction(tx), error => {
    assert.ok(error instanceof LedgerSigningError);
    assert.deepEqual(Object.keys(error.diagnostic!).sort(), ['elapsedMs', 'phase', 'status']);
    assert.ok(!JSON.stringify(error).includes(secret));
    assert.ok(!error.message.includes(secret));
    return true;
  });
});
