import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs, { mkdtemp, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { getAddress, type Address } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { connectionPath, readProfiles } from '../scripts/profile-routing.mjs';
import { createHdWallet } from '../src/hd-wallet.js';
import { addPortfolio } from '../src/profiles.js';
import { acquireLock, atomicWriteJson, readJson } from '../src/storage.js';
import { connectView, issueView, viewState, type SetupMode } from '../src/view-session.js';
import type { SeedStore } from '../src/macos-keychain.js';
import { WalletSetups, type WalletSetupDependencies, type WalletSetupResult } from '../src/wallet-setup.js';
import type { SetupWallet, WalletSetupContext } from '../src/wallet-setup-types.js';

const chatA = '00000000-0000-4000-8000-000000000001', chatB = '00000000-0000-4000-8000-000000000002';
const walletA = `0x${'a'.repeat(40)}` as Address, walletB = `0x${'b'.repeat(40)}` as Address;
const targets = { USDG: 500, AAPL: 2375, NVDA: 2375, MSFT: 2375, AMD: 2375 };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const keyFor = (token: string, requestId: string) => hash(`${hash(token)}\0${requestId.toLowerCase()}`);
const fileFor = (root: string, token: string, requestId: string) => join(root, 'wallet-setups', `${keyFor(token, requestId)}.json`);
const config = (wallet: Address, mode: SetupMode, weights = targets) => ({ version: 1, wallet, chainId: 4663, mode,
  rpcUrl: 'https://fixture.invalid', targets: weights, driftThresholdBps: 500, slippageBps: 50,
  deadlineSeconds: 120, pollSeconds: 30, rebalanceIntervalSeconds: 3600 });
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function gate(context: WalletSetupContext, wait: Promise<void>) {
  if (context.signal.aborted) throw new Error('Fixture aborted');
  let abort!: () => void;
  try { await Promise.race([wait, new Promise<never>((_done, fail) => {
    abort = () => fail(new Error('Fixture aborted')); context.signal.addEventListener('abort', abort, { once: true });
  })]); }
  finally { context.signal.removeEventListener('abort', abort); }
}
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rebalance-wallet-setup-')));
  const services: WalletSetups[] = [];
  t.after(async () => { await Promise.all(services.map(service => service.close())); await rm(root, { recursive: true, force: true }); });
  const a = await issueView(root, chatA), b = await issueView(root, chatB);
  const service = (mode: SetupMode, provider: (context: WalletSetupContext) => Promise<SetupWallet>) => {
    const unexpected = async (): Promise<never> => { throw new Error('Unexpected fixture signer'); };
    const providers: WalletSetupDependencies['providers'] = { 'private-key': unexpected, privy: unexpected, ledger: unexpected, [mode]: provider };
    const value = new WalletSetups(root, { providers }); services.push(value); return value;
  };
  return { root, a: a.token, b: b.token, service };
}
async function state(service: WalletSetups, token: string, requestId: string, expected: WalletSetupResult['state']) {
  for (let i = 0; i < 1000; i++) {
    const current = await service.read(token, requestId);
    if (current.state === expected) return current;
    await delay(5);
  }
  assert.fail(`Fixture setup did not reach ${expected}`);
}
async function absent(path: string) { assert.equal(await readJson(path), null); }

test('request replay and concurrent replays produce one provider wallet and public ready metadata', async t => {
  const f = await fixture(t), id = randomUUID(), wait = deferred(), started = deferred();
  const contexts: WalletSetupContext[] = [];
  const service = f.service('private-key', async context => {
    contexts.push(context); started.resolve(); await gate(context, wait.promise);
    return { address: walletA, accountIndex: 0, derivationPath: "m/44'/60'/0'/0/0" };
  });
  const initial = await service.begin(f.a, 'private-key', id); await started.promise;
  assert.equal(initial.state, 'preparing'); assert.equal(initial.tradingChanged, false);
  assert.deepEqual(Object.keys(initial).sort(), ['message', 'mode', 'requestId', 'state', 'tradingChanged']);
  const replays = await Promise.all([service.begin(f.a, 'private-key', id), service.begin(f.a, 'private-key', id.toUpperCase())]);
  assert.ok(replays.every(value => value.state === 'preparing')); assert.equal(contexts.length, 1);
  assert.equal(contexts[0].rootDir, f.root); assert.equal(contexts[0].requestKey, keyFor(f.a, id));
  wait.resolve();
  const ready = await state(service, f.a, id, 'ready');
  assert.equal(ready.wallet, getAddress(walletA)); assert.equal(ready.reused, false);
  assert.match(ready.chartUrl!, /^http:\/\/127\.0\.0\.1:\d+\/chart$/);
  assert.deepEqual(await service.begin(f.a, 'private-key', id), ready);
  await service.close();
  const restarted = f.service('private-key', async () => { assert.fail('A ready replay must not create another wallet'); });
  assert.deepEqual(await restarted.begin(f.a, 'private-key', id), ready);
  assert.equal(contexts.length, 1); assert.equal((await readProfiles(f.root)).length, 1);
  const bytes = await readFile(fileFor(f.root, f.a, id), 'utf8');
  assert.ok(!bytes.includes(f.a)); assert.equal((await stat(fileFor(f.root, f.a, id))).mode & 0o777, 0o600);
  assert.ok(!('verified' in ready) && !('viewHash' in ready) && !('sessionId' in ready));
});

test('real HD provisioning and registration create distinct private portfolios while preserving the standalone wallet', async t => {
  const f = await fixture(t), ids = [randomUUID(), randomUUID()];
  // Public zero-entropy BIP-39 test vector, used only inside this disposable root.
  const mnemonic = `${'abandon '.repeat(23)}art`;
  await atomicWriteJson(join(f.root, 'hd/seed.json'), { version: 1, mnemonic, createdAt: '2026-09-07T00:00:00.000Z' });
  await atomicWriteJson(join(f.root, 'config.json'), config(walletB, 'private-key'));
  await atomicWriteJson(join(f.root, 'wallet.json'), { address: walletB, chainId: 4663, fixture: 'standalone' });
  await atomicWriteJson(join(f.root, 'private-key'), { fixture: 'standalone key bytes must remain unchanged' });
  const standalone = ['config.json', 'wallet.json', 'private-key'];
  const before = await Promise.all(standalone.map(file => readFile(join(f.root, file), 'utf8')));
  let providerCalls = 0;
  const service = f.service('private-key', async context => {
    providerCalls++; return createHdWallet(context.rootDir, context.requestKey, { platform: 'linux' });
  });
  const ready: WalletSetupResult[] = [];
  for (const [index, id] of ids.entries()) {
    await service.begin(f.a, 'private-key', id);
    const result = await state(service, f.a, id, 'ready'); ready.push(result);
    const derivationPath = `m/44'/60'/0'/0/${index}` as const;
    const expected = mnemonicToAccount(mnemonic, { path: derivationPath }).address;
    assert.equal(result.wallet, expected); assert.equal(result.reused, false);
    const dataDir = join(f.root, 'wallets', expected.toLowerCase());
    const metadata = await readJson<{ address: string; hd: unknown }>(join(dataDir, 'wallet.json'));
    assert.equal(metadata!.address, expected);
    assert.deepEqual(metadata!.hd, { version: 1, requestKey: keyFor(f.a, id), accountIndex: index, derivationPath });
    const saved = await readJson<{ wallet: string; mode: string; targets: Record<string, number> }>(join(dataDir, 'config.json'));
    assert.equal(saved!.wallet, expected); assert.equal(saved!.mode, 'private-key'); assert.deepEqual(saved!.targets, targets);
    assert.equal((await stat(dataDir)).mode & 0o777, 0o700);
    for (const file of ['private-key', 'wallet.json', 'config.json']) assert.equal((await stat(join(dataDir, file))).mode & 0o777, 0o600);
    assert.deepEqual((await readdir(dataDir)).sort(), ['config.json', 'private-key', 'wallet.json']);
  }
  assert.notEqual(ready[0].wallet, ready[1].wallet);
  assert.deepEqual(await service.begin(f.a, 'private-key', ids[0]), ready[0]);
  assert.equal(providerCalls, 2);
  const profiles = await readProfiles(f.root);
  assert.equal(profiles.length, 3); assert.equal(profiles.filter(profile => profile.directory === '.').length, 1);
  assert.deepEqual(profiles.filter(profile => profile.directory !== '.').map(profile => profile.wallet).sort(), ready.map(result => result.wallet!.toLowerCase()).sort());
  assert.equal((await readdir(join(f.root, 'wallets'))).length, 2);
  assert.equal((await stat(join(f.root, 'hd/seed.json'))).mode & 0o777, 0o600);
  assert.deepEqual(await Promise.all(standalone.map(file => readFile(join(f.root, file), 'utf8'))), before);
  await absent(connectionPath(f.root, chatA));
});

test('Keychain setup registers two selectable portfolios from one seed without plaintext keys or trading', async t => {
  const f = await fixture(t), ids = [randomUUID(), randomUUID()];
  const values = new Map<string, string>();
  let seedCreates = 0, providerCalls = 0;
  const store: SeedStore = {
    async create(id, value) { assert.equal(values.has(id), false); seedCreates++; values.set(id, value); },
    async read(id) { return values.get(id) ?? null; },
  };
  const external: string[] = [];
  t.mock.method(globalThis, 'fetch', async () => { external.push('fetch'); throw new Error('Unexpected fixture network'); });
  for (const name of ['execFile', 'execFileSync', 'spawn'] as const) t.mock.method(childProcess, name, () => {
    external.push(name); throw new Error('Unexpected fixture subprocess');
  });
  syncBuiltinESMExports();
  try {
    const service = f.service('private-key', async context => {
      providerCalls++;
      return createHdWallet(context.rootDir, context.requestKey, { platform: 'darwin', store });
    });
    const ready: WalletSetupResult[] = [], seedIds: string[] = [], seedAddresses: string[] = [];
    for (const [index, id] of ids.entries()) {
      const previouslySelected = (await viewState(f.root, f.a)).connectedWallet;
      const starting = await service.begin(f.a, 'private-key', id);
      assert.equal(starting.tradingChanged, false);
      const result = await state(service, f.a, id, 'ready'); ready.push(result);
      assert.equal(result.tradingChanged, false);
      assert.equal(result.reused, false);
      assert.equal((await viewState(f.root, f.a)).connectedWallet, previouslySelected);
      const dataDir = join(f.root, 'wallets', result.wallet!.toLowerCase());
      const metadata = await readJson<{ address: string; hd: unknown; keychain: { version: number; seedId: string; seedAddress: string } }>(join(dataDir, 'wallet.json'));
      assert.equal(metadata!.address, result.wallet);
      assert.deepEqual(metadata!.hd, { version: 1, requestKey: keyFor(f.a, id), accountIndex: index, derivationPath: `m/44'/60'/0'/0/${index}` });
      assert.equal(metadata!.keychain.version, 1);
      seedIds.push(metadata!.keychain.seedId); seedAddresses.push(metadata!.keychain.seedAddress);
      assert.deepEqual(await readJson(join(dataDir, 'keychain-wallet.json')), metadata);
      const configPath = join(dataDir, 'config.json');
      const saved = await readJson<{ wallet: string; mode: string; targets: Record<string, number> }>(configPath);
      assert.equal(saved!.wallet, result.wallet); assert.equal(saved!.mode, 'private-key'); assert.deepEqual(saved!.targets, targets);
      const beforeSelection = await readFile(configPath, 'utf8');
      const selected = await connectView(f.root, f.a, result.wallet!);
      assert.equal(selected.wallet, result.wallet); assert.equal(selected.tradingChanged, false);
      assert.equal((await viewState(f.root, f.a)).connectedWallet, result.wallet!.toLowerCase());
      assert.equal((await viewState(f.root, f.b)).connectedWallet, null);
      assert.equal(await readFile(configPath, 'utf8'), beforeSelection);
      assert.deepEqual((await readdir(dataDir)).sort(), ['config.json', 'keychain-wallet.json', 'wallet.json']);
      for (const name of ['private-key', 'run.lock', 'stop.json', 'pending.json', 'cycle.json', 'recovery.json', 'events.json']) await absent(join(dataDir, name));
    }
    assert.notEqual(ready[0].wallet, ready[1].wallet);
    assert.equal(new Set(seedIds).size, 1); assert.equal(new Set(seedAddresses).size, 1);
    assert.equal(seedAddresses[0], ready[0].wallet); assert.equal(seedCreates, 1);
    assert.deepEqual(await service.begin(f.a, 'private-key', ids[0]), ready[0]);
    assert.equal(providerCalls, 2);
    assert.equal((await readProfiles(f.root)).length, 2);
    assert.equal((await readdir(join(f.root, 'wallets'))).length, 2);
    for (const name of ['private-key', 'hd/seed.json', 'run.lock', 'events.json']) await absent(join(f.root, name));
    await assert.rejects(readdir(join(f.root, 'ui-requests')), { code: 'ENOENT' });
    assert.deepEqual(external, []);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test('mode collisions, cross-view reads and unsupported tokens cannot reuse another setup request', async t => {
  const f = await fixture(t), id = randomUUID(); let calls = 0;
  const service = f.service('privy', async () => { calls++; return { address: walletA }; });
  await service.begin(f.a, 'privy', id); await state(service, f.a, id, 'ready');
  await assert.rejects(service.begin(f.a, 'ledger', id), /unavailable or invalid/);
  await assert.rejects(service.read(f.b, id), /unavailable or invalid/);
  const rotated = await issueView(f.root, chatA);
  await assert.rejects(service.read(rotated.token, id), /unavailable or invalid/);
  const unsupported = await issueView(f.root, 'unlinked-local-fixture', null);
  for (const token of [unsupported.token, '0'.repeat(64), '../view']) await assert.rejects(service.begin(token, 'privy', id));
  await assert.rejects(service.begin(f.a, 'privy', 'not-a-uuid'));
  await assert.rejects(service.begin(f.a, 'unknown' as SetupMode, id));
  assert.equal(calls, 1); assert.equal((await readdir(join(f.root, 'wallet-setups'))).filter(name => name.endsWith('.json')).length, 1);
});

test('validated progress and verified wallet survive registration failure and resume without repeating provider approval', async t => {
  for (const mode of ['privy', 'ledger', 'private-key'] as const) await t.test(mode, async t => {
    const f = await fixture(t), id = randomUUID(), wait = deferred(), progressed = deferred(); let calls = 0;
    const approval = { url: 'https://agents.privy.io/?user_code=ABCD-EFGH', code: 'ABCD-EFGH' };
    const service = f.service(mode, async context => {
      calls++;
      await context.onProgress(mode === 'privy' ? { state: 'awaiting-approval', message: 'Complete fixture provider approval.', approval }
        : { state: mode === 'ledger' ? 'awaiting-device' : 'preparing', message: 'Waiting at the fixture provider.' });
      progressed.resolve(); await gate(context, wait.promise);
      return { address: walletA, accountIndex: 1, derivationPath: mode === 'ledger' ? "m/44'/60'/1'/0/0" : "m/44'/60'/0'/0/1" };
    });
    const release = await acquireLock(f.root, 'portfolios.lock'); t.after(release);
    await service.begin(f.a, mode, id); await progressed.promise;
    const progress = await service.read(f.a, id);
    assert.equal(progress.state, mode === 'privy' ? 'awaiting-approval' : mode === 'ledger' ? 'awaiting-device' : 'preparing');
    if (mode === 'privy') assert.deepEqual(progress.approval, approval);
    wait.resolve(); await state(service, f.a, id, 'failed');
    const saved = await readJson<{ verified: SetupWallet; approval?: unknown }>(fileFor(f.root, f.a, id));
    assert.equal(saved!.verified.address, getAddress(walletA)); assert.equal(saved!.approval, undefined);
    assert.equal((await readProfiles(f.root)).length, 0);
    await release(); await service.close();
    const resumed = f.service(mode, async () => { calls++; return { address: walletA, accountIndex: 1, derivationPath: "m/44'/60'/0'/0/1" }; });
    await resumed.begin(f.a, mode, id);
    const ready = await state(resumed, f.a, id, 'ready');
    assert.equal(ready.wallet, getAddress(walletA)); assert.equal(calls, mode === 'private-key' ? 2 : 1);
    assert.equal((await readProfiles(f.root)).length, 1);
  });
});

test('existing Privy wallet reuse preserves its exact allocation and settings', async t => {
  const f = await fixture(t), id = randomUUID();
  const profile = await addPortfolio(f.root, config(walletA, 'privy', { USDG: 1000, AAPL: 4000, NVDA: 2000, MSFT: 1500, AMD: 1500 }));
  const configPath = join(profile.dataDir, 'config.json'), registry = join(f.root, 'portfolios.json');
  const before = await Promise.all([readFile(configPath, 'utf8'), readFile(registry, 'utf8')]);
  const service = f.service('privy', async () => ({ address: walletA, reused: true }));
  await service.begin(f.a, 'privy', id); const ready = await state(service, f.a, id, 'ready');
  assert.equal(ready.reused, true); assert.equal(ready.wallet, getAddress(walletA));
  assert.deepEqual(await Promise.all([readFile(configPath, 'utf8'), readFile(registry, 'utf8')]), before);
  await absent(join(profile.dataDir, 'private-key'));
});

test('new defaults total 100 percent and setup changes no model queue, connection or trading records', async t => {
  const f = await fixture(t), id = randomUUID();
  await atomicWriteJson(join(f.root, 'config.json'), config(walletB, 'ledger'));
  await atomicWriteJson(connectionPath(f.root, chatA), { version: 1, chainId: 4663, wallet: walletB });
  await atomicWriteJson(connectionPath(f.root, chatB), { version: 1, chainId: 4663, wallet: walletB });
  const protectedNames = ['config.json', 'private-key', 'pending.json', 'recovery.json', 'cycle.json', 'stop.json', 'run.lock', 'events.json'];
  for (const file of protectedNames.slice(1)) await atomicWriteJson(join(f.root, file), { fixture: file });
  const paths = [...protectedNames.map(file => join(f.root, file)), connectionPath(f.root, chatA), connectionPath(f.root, chatB)];
  const before = await Promise.all(paths.map(path => readFile(path, 'utf8')));
  const external: string[] = [];
  t.mock.method(globalThis, 'fetch', async () => { external.push('fetch'); throw new Error('Unexpected fixture network'); });
  for (const name of ['execFile', 'execFileSync', 'spawn'] as const) t.mock.method(childProcess, name, () => { external.push(name); throw new Error('Unexpected fixture subprocess'); });
  syncBuiltinESMExports();
  try {
    const service = f.service('private-key', async () => ({ address: walletA }));
    await service.begin(f.a, 'private-key', id); await state(service, f.a, id, 'ready');
    const added = (await readProfiles(f.root)).find(profile => profile.wallet === walletA)!;
    const saved = await readJson<{ targets: Record<string, number>; mode: string; wallet: string }>(join(added.dataDir, 'config.json'));
    assert.deepEqual(saved!.targets, targets); assert.equal(Object.values(saved!.targets).reduce((sum, weight) => sum + weight, 0), 10000);
    assert.equal(saved!.mode, 'private-key'); assert.equal(saved!.wallet, getAddress(walletA));
    assert.deepEqual(await Promise.all(paths.map(path => readFile(path, 'utf8'))), before);
    assert.deepEqual(await readdir(added.dataDir), ['config.json']);
    await assert.rejects(readdir(join(f.root, 'ui-requests')), { code: 'ENOENT' });
    assert.deepEqual(external, []);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test('close aborts active provider work, ignores late progress and rejects new jobs', async t => {
  const f = await fixture(t), id = randomUUID(), started = deferred(); let context!: WalletSetupContext;
  const service = f.service('ledger', async value => {
    context = value; await value.onProgress({ state: 'awaiting-device', message: 'Fixture device pending.' });
    started.resolve(); await gate(value, new Promise<void>(() => {})); return { address: walletA };
  });
  await service.begin(f.a, 'ledger', id); await started.promise;
  await service.close(); assert.equal(context.signal.aborted, true);
  const failed = await service.read(f.a, id); assert.equal(failed.state, 'failed');
  await context.onProgress({ state: 'awaiting-device', message: 'Late fixture update.' });
  assert.deepEqual(await service.read(f.a, id), failed);
  await assert.rejects(service.begin(f.a, 'ledger', randomUUID()), /unavailable or invalid/);
  assert.equal((await readProfiles(f.root)).length, 0);
});

test('close during asynchronous request validation prevents a provider from starting after shutdown', async t => {
  const f = await fixture(t), id = randomUUID(), reached = deferred(), resume = deferred(); let calls = 0, intercepted = false;
  const service = f.service('privy', async () => { calls++; return { address: walletA }; });
  const original = fs.lstat;
  t.mock.method(fs, 'lstat', async (...args: Parameters<typeof fs.lstat>) => {
    if (!intercepted && String(args[0]) === join(f.root, 'wallet-setups')) {
      intercepted = true; reached.resolve(); await resume.promise;
    }
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    const beginning = service.begin(f.a, 'privy', id);
    await reached.promise; await service.close(); resume.resolve();
    await assert.rejects(beginning, /unavailable or invalid/);
    assert.equal(calls, 0); assert.equal((await readProfiles(f.root)).length, 0);
  } finally { resume.resolve(); t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test('invalid provider approval and provider failures never persist arbitrary sensitive error text', async t => {
  for (const kind of ['approval', 'provider'] as const) await t.test(kind, async t => {
    const f = await fixture(t), id = randomUUID();
    const service = f.service('privy', async context => {
      if (kind === 'approval') await context.onProgress({ state: 'awaiting-approval', message: 'Unverified approval.', approval: { url: 'https://outside.invalid/?user_code=ABCD', code: 'ABCD' } });
      throw new Error('fixture-sensitive-provider-detail');
    });
    await service.begin(f.a, 'privy', id); const failed = await state(service, f.a, id, 'failed');
    assert.equal(failed.approval, undefined); assert.equal(failed.wallet, undefined);
    assert.doesNotMatch(await readFile(fileFor(f.root, f.a, id), 'utf8'), /outside\.invalid|fixture-sensitive-provider-detail/);
    assert.equal((await readProfiles(f.root)).length, 0);
  });
});
