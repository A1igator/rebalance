import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, link, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { Observable, Subject, of } from 'rxjs';
import { getAddress } from 'viem';
import { setupLedgerWallet, type LedgerAddressAction, type LedgerDevice, type LedgerSdk } from '../src/ledger-onboarding.js';
import { atomicWriteJson } from '../src/storage.js';
import type { WalletSetupContext, WalletSetupProgress } from '../src/wallet-setup-types.js';

const key = (value: string) => createHash('sha256').update(value).digest('hex');
const anchorA = getAddress(`0x${'a'.repeat(40)}`);
const anchorB = getAddress(`0x${'b'.repeat(40)}`);
const wallet = (index: number) => getAddress(`0x${index.toString(16).padStart(40, '0')}`);
const pathFor = (index: number) => `44'/60'/${index}'/0/0`;
const publicKey = `04${'12'.repeat(64)}`;
const done = (address: string): LedgerAddressAction => ({
  observable: of({ status: 'completed', output: { address, publicKey } }), cancel() {},
});
async function fixture(t: TestContext) {
  const rootDir = await mkdtemp(join(await realpath(tmpdir()), 'rebalance-ledger-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const progress: WalletSetupProgress[] = [];
  const context: WalletSetupContext = { rootDir, requestKey: key('first'), signal: new AbortController().signal,
    onProgress: async value => { progress.push(value); } };
  const journal = () => readFile(join(rootDir, 'ledger-onboarding', 'accounts.json'), 'utf8').then(JSON.parse);
  return { rootDir, progress, context, journal };
}
function device(anchor = anchorA, verified?: (index: number) => LedgerAddressAction) {
  const calls: { path: string; options: { checkOnDevice: boolean; returnChainCode: false } }[] = [];
  let closes = 0;
  const adapter: LedgerDevice = {
    getAddress(path, options) {
      calls.push({ path, options });
      const index = Number(path.split('/')[2].replace("'", ''));
      return index === 0 ? done(anchor) : verified?.(index) ?? done(wallet(index));
    },
    async close() { closes++; },
  };
  return { adapter, calls, closes: () => closes };
}
async function until(condition: () => boolean) {
  for (let i = 0; i < 500; i++) { if (condition()) return; await delay(2); }
  assert.fail('Fixture did not reach the expected state');
}

test('Ledger setup reserves before physical verification and stores only verified public metadata', async t => {
  const f = await fixture(t), d = device();
  const preserved = ['config.json', 'pending.json', 'cycle.json', 'stop.json', 'portfolios.json'];
  for (const file of preserved) await atomicWriteJson(join(f.rootDir, file), { fixture: file });
  const before = await Promise.all(preserved.map(file => readFile(join(f.rootDir, file), 'utf8')));
  const result = await setupLedgerWallet({ ...f.context, onProgress: async progress => {
    f.progress.push(progress);
    if (progress.state === 'awaiting-approval') {
      const journal = await f.journal();
      assert.equal(journal.requests[f.context.requestKey].accountIndex, 1);
      assert.equal(journal.requests[f.context.requestKey].address, undefined);
    }
  } }, { connect: async () => d.adapter });
  assert.deepEqual(result, { address: wallet(1), accountIndex: 1, derivationPath: pathFor(1) });
  assert.deepEqual(d.calls, [
    { path: pathFor(0), options: { checkOnDevice: false, returnChainCode: false } },
    { path: pathFor(1), options: { checkOnDevice: true, returnChainCode: false } },
    { path: pathFor(0), options: { checkOnDevice: false, returnChainCode: false } },
  ]);
  assert.equal(d.closes(), 1);
  assert.deepEqual(f.progress.map(value => value.state), ['awaiting-device', 'awaiting-approval']);
  const saved = await f.journal();
  assert.equal(saved.requests[f.context.requestKey].address, wallet(1));
  assert.equal(saved.requests[f.context.requestKey].fingerprint, key(anchorA.toLowerCase()));
  assert.equal((await stat(join(f.rootDir, 'ledger-onboarding', 'accounts.json'))).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(join(f.rootDir, 'ledger-onboarding')), ['accounts.json']);
  const bytes = JSON.stringify(saved);
  for (const forbidden of ['privateKey', 'mnemonic', 'chainCode', publicKey, anchorA]) assert.ok(!bytes.includes(forbidden));
  assert.deepEqual(await Promise.all(preserved.map(file => readFile(join(f.rootDir, file), 'utf8'))), before);
});

test('completed request replay returns the same wallet without native SDK/device access', async t => {
  const f = await fixture(t), d = device();
  await setupLedgerWallet(f.context, { connect: async () => d.adapter });
  const before = await readFile(join(f.rootDir, 'ledger-onboarding', 'accounts.json'), 'utf8');
  const result = await setupLedgerWallet(f.context, { loadSdk: () => { assert.fail('Replay must not load native modules'); } });
  assert.deepEqual(result, { address: wallet(1), accountIndex: 1, derivationPath: pathFor(1), reused: true });
  assert.equal(await readFile(join(f.rootDir, 'ledger-onboarding', 'accounts.json'), 'utf8'), before);
});

test('rejection keeps the same request index available for explicit retry', async t => {
  const f = await fixture(t);
  let cancelled = 0;
  const rejected = device(anchorA, () => ({ observable: of({ status: 'error', output: { privateText: 'must not leak' } }), cancel() { cancelled++; } }));
  await assert.rejects(setupLedgerWallet(f.context, { connect: async () => rejected.adapter }), /rejected or interrupted/);
  assert.equal(rejected.closes(), 1); assert.equal(cancelled, 1);
  const reservation = (await f.journal()).requests[f.context.requestKey];
  assert.equal(reservation.accountIndex, 1); assert.equal(reservation.address, undefined);
  const retried = device();
  assert.equal((await setupLedgerWallet(f.context, { connect: async () => retried.adapter })).address, wallet(1));
  assert.equal(Object.keys((await f.journal()).requests).length, 1);
});

test('verification timeout cancels and unsubscribes before closing, without completing the reservation', async t => {
  const f = await fixture(t);
  let subscribed = 0, unsubscribed = 0, cancelled = 0;
  const d = device(anchorA, () => ({ observable: new Observable(subscriber => {
    subscribed++; subscriber.next({ status: 'pending' }); return () => { unsubscribed++; };
  }), cancel() { cancelled++; } }));
  await assert.rejects(setupLedgerWallet(f.context, { connect: async () => d.adapter, timeoutMs: 500 }), /timed out/);
  assert.equal(subscribed, 1); assert.equal(unsubscribed, 1); assert.equal(cancelled, 1); assert.equal(d.closes(), 1);
  assert.equal((await f.journal()).requests[f.context.requestKey].address, undefined);
  assert.deepEqual(await readdir(join(f.rootDir, 'ledger-onboarding')), ['accounts.json']);
});

test('user cancellation during verification never creates a completed wallet and closes the device', async t => {
  const f = await fixture(t), controller = new AbortController();
  let subscribed = false, cancelled = 0;
  const d = device(anchorA, () => ({ observable: new Observable(() => { subscribed = true; }), cancel() { cancelled++; } }));
  const pending = setupLedgerWallet({ ...f.context, signal: controller.signal }, { connect: async () => d.adapter });
  const rejected = assert.rejects(pending, /fixture cancelled/);
  await until(() => subscribed); controller.abort(new Error('fixture cancelled'));
  await rejected;
  assert.equal(cancelled, 1); assert.equal(d.closes(), 1);
  assert.equal((await f.journal()).requests[f.context.requestKey].address, undefined);
});

test('an already cancelled request performs no SDK load, state write or device operation', async t => {
  const f = await fixture(t), controller = new AbortController(); controller.abort(new Error('already cancelled'));
  await assert.rejects(setupLedgerWallet({ ...f.context, signal: controller.signal }, { loadSdk: () => { assert.fail('must not load'); } }), /already cancelled/);
  assert.deepEqual(await readdir(f.rootDir), []);
});

test('a reserved request cannot switch seeds; distinct requests increment each seed independently', async t => {
  const f = await fixture(t);
  const rejected = device(anchorA, () => ({ observable: of({ status: 'stopped' }), cancel() {} }));
  await assert.rejects(setupLedgerWallet(f.context, { connect: async () => rejected.adapter }));
  const wrongSeed = device(anchorB);
  await assert.rejects(setupLedgerWallet(f.context, { connect: async () => wrongSeed.adapter }), /different Ledger account seed/);
  assert.equal(wrongSeed.calls.length, 1);
  const second = device();
  assert.equal((await setupLedgerWallet({ ...f.context, requestKey: key('second') }, { connect: async () => second.adapter })).accountIndex, 2);
  const otherSeed = device(anchorB, () => done(wallet(99)));
  assert.equal((await setupLedgerWallet({ ...f.context, requestKey: key('other-seed') }, { connect: async () => otherSeed.adapter })).accountIndex, 1);
});

test('only a valid completed device response establishes success', async t => {
  for (const output of [undefined, {}, { address: 'broken', publicKey }, { address: wallet(1), publicKey: 'invalid' }, { address: wallet(1), publicKey, chainCode: 'unexpected' }]) {
    const f = await fixture(t), d = device(anchorA, () => ({ observable: of({ status: 'completed', output }), cancel() {} }));
    await assert.rejects(setupLedgerWallet(f.context, { connect: async () => d.adapter }), /invalid/);
    assert.equal((await f.journal()).requests[f.context.requestKey].address, undefined);
    assert.equal(d.closes(), 1);
  }
  const f = await fixture(t), d = device(anchorA, () => ({ observable: of({ status: 'pending' }), cancel() {} }));
  await assert.rejects(setupLedgerWallet(f.context, { connect: async () => d.adapter }), /did not complete/);
});

test('a changed anchor after verification or reused account-zero address cannot complete a reservation', async t => {
  const f = await fixture(t);
  let anchors = 0, closes = 0;
  const changed: LedgerDevice = { getAddress(path) { return done(path === pathFor(0) ? ++anchors === 1 ? anchorA : anchorB : wallet(1)); }, async close() { closes++; } };
  await assert.rejects(setupLedgerWallet(f.context, { connect: async () => changed }), /identity changed/);
  assert.equal(closes, 1); assert.equal((await f.journal()).requests[f.context.requestKey].address, undefined);
  const duplicate = device(anchorA, () => done(anchorA));
  await assert.rejects(setupLedgerWallet(f.context, { connect: async () => duplicate.adapter }), /identity changed/);
});

test('native adapter waits for one device, disables background session refresh, and closes the manager', async t => {
  const f = await fixture(t), available = new Subject<readonly unknown[]>(), d = device();
  let listened = false, subscriptionsClosed = 0, managerCloses = 0;
  const connections: unknown[] = [], disconnections: unknown[] = [];
  const sdk: LedgerSdk = { manager: {
    listenToAvailableDevices(args) {
      assert.deepEqual(args, { transport: 'NODE-HID' }); listened = true;
      return new Observable(subscriber => { const sub = available.subscribe(subscriber); return () => { subscriptionsClosed++; sub.unsubscribe(); }; });
    },
    async connect(args) { connections.push(args); return 'fixture-device-session'; },
    async disconnect(args) { disconnections.push(args); },
    close() { managerCloses++; },
  }, signer(sessionId) { assert.equal(sessionId, 'fixture-device-session'); return d.adapter; } };
  const pending = setupLedgerWallet(f.context, { loadSdk: () => sdk });
  await until(() => listened); available.next([]); assert.equal(connections.length, 0);
  available.next([{ id: 'fixture-device' }]);
  assert.equal((await pending).address, wallet(1));
  assert.deepEqual(connections, [{ device: { id: 'fixture-device' }, sessionRefresherOptions: { isRefresherDisabled: true } }]);
  assert.deepEqual(disconnections, [{ sessionId: 'fixture-device-session' }]);
  assert.equal(managerCloses, 1); assert.equal(subscriptionsClosed, 1);
});

test('missing or ambiguous devices, load failure and connect failure never reserve an account', async t => {
  for (const scenario of ['none', 'multiple', 'load', 'connect'] as const) {
    const f = await fixture(t); let closes = 0;
    const sdk: LedgerSdk = { manager: {
      listenToAvailableDevices: () => scenario === 'none' ? new Observable(() => {}) : of(scenario === 'multiple' ? [{ id: 1 }, { id: 2 }] : [{ id: 1 }]),
      async connect() { throw new Error('fixture connect failed'); },
      async disconnect() {}, close() { closes++; },
    }, signer: () => { assert.fail('must not create a signer'); } };
    await assert.rejects(setupLedgerWallet(f.context, { timeoutMs: 500, loadSdk: () => {
      if (scenario === 'load') throw new Error('private arbitrary load diagnostic'); return sdk;
    } }));
    if (scenario !== 'load') await until(() => closes > 0);
    assert.equal(closes, scenario === 'load' ? 0 : 1);
    assert.deepEqual(await readdir(join(f.rootDir, 'ledger-onboarding')), []);
  }
});

test('a connection that resolves after cancellation is discarded and disconnected', async t => {
  const f = await fixture(t), controller = new AbortController();
  let resolveConnection!: (session: string) => void, started = false, closes = 0;
  const disconnected: string[] = [];
  const sdk: LedgerSdk = { manager: {
    listenToAvailableDevices: () => of([{ id: 'late' }]),
    connect: () => { started = true; return new Promise(resolve => { resolveConnection = resolve; }); },
    async disconnect({ sessionId }) { disconnected.push(sessionId); }, close() { closes++; },
  }, signer: () => { assert.fail('must not adopt late connection'); } };
  const pending = setupLedgerWallet({ ...f.context, signal: controller.signal }, { loadSdk: () => sdk });
  const rejection = assert.rejects(pending, /cancel late/);
  await until(() => started); controller.abort(new Error('cancel late')); await rejection;
  resolveConnection('late-session'); await until(() => disconnected.length > 0);
  assert.deepEqual(disconnected, ['late-session']); assert.equal(closes, 1);
});

test('concurrent requests serialize hardware access and never allocate the same seed index twice', async t => {
  const f = await fixture(t);
  let active = 0, maximum = 0;
  const connect = async () => {
    maximum = Math.max(maximum, ++active);
    const d = device();
    return { ...d.adapter, async close() { await delay(15); active--; } };
  };
  const results = await Promise.all([setupLedgerWallet(f.context, { connect }), setupLedgerWallet({ ...f.context, requestKey: key('parallel') }, { connect })]);
  assert.deepEqual(results.map(result => result.accountIndex).sort(), [1, 2]);
  assert.equal(maximum, 1); assert.equal(active, 0);
  assert.equal(Object.keys((await f.journal()).requests).length, 2);
});

test('invalid input or corrupt reservation metadata is preserved and never reaches the device', async t => {
  const f = await fixture(t);
  const never = async (): Promise<LedgerDevice> => { assert.fail('must not connect'); };
  await assert.rejects(setupLedgerWallet({ ...f.context, requestKey: '../invalid' }, { connect: never }));
  await assert.rejects(setupLedgerWallet({ ...f.context, rootDir: 'relative' }, { connect: never }));
  await assert.rejects(setupLedgerWallet(f.context, { connect: never, timeoutMs: 120_001 }));
  const file = join(f.rootDir, 'ledger-onboarding', 'accounts.json');
  await atomicWriteJson(file, { version: 1, requests: { [f.context.requestKey]: { fingerprint: key('seed'), accountIndex: 1, derivationPath: pathFor(1), unsupported: true } } });
  const before = await readFile(file, 'utf8');
  await assert.rejects(setupLedgerWallet(f.context, { connect: never }), /reservations are invalid/);
  assert.equal(await readFile(file, 'utf8'), before);
});

test('directory aliases and linked or broad-permission ledger journals cannot reach the device', async t => {
  const never = async (): Promise<LedgerDevice> => { assert.fail('unsafe storage must not connect'); };
  for (const kind of ['ancestor', 'directory', 'journal-symlink', 'journal-hardlink', 'journal-mode', 'lock'] as const) {
    const f = await fixture(t), outside = await mkdtemp(join(await realpath(tmpdir()), 'rebalance-ledger-outside-'));
    t.after(() => rm(outside, { recursive: true, force: true }));
    const target = join(outside, 'public-fixture.json');
    await atomicWriteJson(target, { version: 1, requests: {} });
    const original = await readFile(target, 'utf8');
    const directory = join(f.rootDir, 'ledger-onboarding');
    let context = f.context;
    if (kind === 'ancestor') {
      await symlink(outside, join(f.rootDir, 'alias'));
      context = { ...f.context, rootDir: join(f.rootDir, 'alias', 'nested') };
    } else if (kind === 'directory') await symlink(outside, directory);
    else {
      await mkdir(directory, { mode: 0o700 });
      const file = join(directory, kind === 'lock' ? 'device.lock' : 'accounts.json');
      if (kind === 'journal-hardlink') await link(target, file);
      else if (kind === 'journal-mode') { await atomicWriteJson(file, { version: 1, requests: {} }); await chmod(file, 0o644); }
      else await symlink(target, file);
    }
    await assert.rejects(setupLedgerWallet(context, { connect: never }), /storage could not be verified/);
    assert.equal(await readFile(target, 'utf8'), original);
    assert.deepEqual(await readdir(outside), ['public-fixture.json']);
  }
});
