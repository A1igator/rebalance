import type { Status } from '../src/runtime.js';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test, type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { ASSETS } from '../src/assets.js';
import { evaluatePortfolio } from '../src/core.js';
import { runGraph, type GraphDependencies } from '../src/graph.js';
import { atomicWriteJson, readJson, type PendingTransaction } from '../src/storage.js';

// This suite has its own process/data directory. It never provisions a signer.
const directory = await mkdtemp(join(tmpdir(), 'rebalance-runtime-test-'));
process.env.REBALANCE_DATA_DIR = directory;
delete process.env.REBALANCE_PRIVATE_KEY;
const { CONFIG_PATH, STATE_PATH, PENDING_PATH, LAST_TRANSACTION_PATH, validateConfig } = await import('../src/config.js');
const { initialStatus, monitor, status, tick, STOP_PATH, CYCLE_PATH,
  rebalanceInterval, beginRebalanceCycle, finishRebalanceCycle, ACTIVE_CYCLE_SECONDS } = await import('../src/runtime.js');
const { events, acknowledgeEvent } = await import('../src/events.js');
const { noteSuccessfulSwap } = await import('../src/cadence.js');
const wallet = '0x0000000000000000000000000000000000000001';
const hash = `0x${'ab'.repeat(32)}`;
const targets = { USDG: 2000, TSLA: 2000, AAPL: 2000, NVDA: 2000, AMZN: 2000 };
const config = validateConfig({ version: 1, chainId: 4663, wallet, mode: 'ledger',
  rpcUrl: 'http://runtime-fixture.invalid', targets, driftThresholdBps: 500,
  slippageBps: 50, deadlineSeconds: 120, pollSeconds: 5 });
const portfolio = evaluatePortfolio(Object.values(ASSETS).filter(asset => Object.hasOwn(targets, asset.id)).map(asset => ({ ...asset,
  balance: 10n ** BigInt(asset.decimals), priceUsdE8: 100_000_000n, targetBps: 2000 })));
const observedAt = '2026-09-04T20:00:00.000Z';

beforeEach(async () => {
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { mode: 0o700 });
  await atomicWriteJson(CONFIG_PATH, config);
});
after(() => rm(directory, { recursive: true, force: true }));

async function saved(overrides = {}) {
  const state = { ...await initialStatus(), wallet, mode: config.mode, config: { targets }, portfolio,
    updatedAt: observedAt, nativeBalance: 123n, blockNumber: 100n,
    valuationNote: 'Cached fixture observation', armed: true,
    graph: { node: 'wait', trace: ['config', 'observe', 'plan', 'wait'] }, ...overrides };
  await atomicWriteJson(STATE_PATH, state);
  return JSON.parse(JSON.stringify(state, (_key, value) => typeof value === 'bigint' ? value.toString() : value));
}

function mockRpc(t: TestContext, chainId = 4663) {
  const requests: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: unknown, options?: RequestInit) => {
    assert.equal(String(input), 'http://runtime-fixture.invalid/');
    const request = JSON.parse(options!.body as string) as { id: number; method: string };
    requests.push(request.method);
    let result: unknown;
    if (request.method === 'eth_chainId') result = `0x${chainId.toString(16)}`;
    else if (request.method === 'eth_getTransactionReceipt') result = null;
    else if (request.method === 'eth_getBlockByNumber') result = {
      number: '0x64', timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}`,
      hash: `0x${'cd'.repeat(32)}`, transactions: [],
    };
    else assert.fail(`Unexpected RPC method: ${request.method}; this test cannot sign or send`);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), {
      headers: { 'Content-Type': 'application/json' },
    });
  });
  return requests;
}

async function markFixtureSwapConfirmed() {
  const cycle = await readJson<{ startedAt: number }>(CYCLE_PATH);
  assert.ok(cycle);
  await noteSuccessfulSwap({ chainId: 4663, wallet, hash, nonce: 1, kind: 'swap',
    status: 'broadcast', createdAt: new Date(cycle.startedAt).toISOString() });
}

test('pending recovery retains holdings and their timestamp without planning or completion events', async t => {
  const previous = await saved({ proposal: null,
    operation: { status: 'confirmed', kind: 'swap', hash } });
  const pending: PendingTransaction = { chainId: 4663, wallet, hash, nonce: 1,
    kind: 'swap', createdAt: observedAt, status: 'broadcast' };
  await atomicWriteJson(PENDING_PATH, pending);
  const requests = mockRpc(t);
  const result = await tick(false);
  assert.equal(result.operation?.status, 'pending');
  assert.equal(result.updatedAt, observedAt);
  assert.deepEqual(result.portfolio, previous.portfolio);
  assert.equal(result.proposal, undefined, 'cached no-trade proposals must not authorize completion');
  assert.deepEqual(requests, ['eth_chainId', 'eth_getTransactionReceipt']);
  assert.deepEqual(await events(), []);
  assert.deepEqual(await readJson(PENDING_PATH), pending);
});

test('a failed fresh observation retains the last portfolio and cannot turn a previous receipt into completion', async t => {
  const previous = await saved({ proposal: null });
  await atomicWriteJson(LAST_TRANSACTION_PATH, { status: 'confirmed', kind: 'swap', hash, wallet, chainId: 4663 });
  mockRpc(t, 1);
  const result = await tick(false);
  assert.ok(result.error);
  assert.equal(result.graph.node, 'error');
  assert.equal(result.updatedAt, observedAt);
  assert.deepEqual(result.portfolio, previous.portfolio);
  assert.equal(result.proposal, undefined);
  const queued = await events();
  assert.equal(queued.length, 1);
  assert.equal(queued[0]!.type, 'rebalance-attention');
  assert.match(queued[0]!.message, /holdings or prices could not be read/);
});

test('recovery clears an unscoped cached operation instead of reusing it for a later completion', async t => {
  const legacy = { status: 'confirmed', kind: 'swap', hash };
  await saved({ operation: legacy, proposal: null });
  await atomicWriteJson(LAST_TRANSACTION_PATH, legacy);
  mockRpc(t, 1);
  const result = await tick(false);
  assert.equal(result.operation, null);
  assert.deepEqual((await events()).map(event => event.type), ['rebalance-attention']);
  assert.deepEqual(await readJson(LAST_TRANSACTION_PATH), legacy);
});

test('an unresolved receipt emits one attention alert before observation and preserves its transaction and cycle', async t => {
  const previous = await saved({ proposal: null, operation: { status: 'confirmed', kind: 'swap', hash } });
  const pending: PendingTransaction = { chainId: 4663, wallet, hash, nonce: 1,
    kind: 'swap', createdAt: observedAt, status: 'unknown' };
  await atomicWriteJson(PENDING_PATH, pending);
  await beginRebalanceCycle(config);
  const cycle = await readJson(CYCLE_PATH);
  const requests = mockRpc(t);
  const result = await tick(false);
  assert.equal(result.operation?.status, 'unresolved');
  assert.equal(result.error, null);
  assert.equal(result.updatedAt, observedAt);
  assert.deepEqual(result.portfolio, previous.portfolio);
  assert.equal(result.proposal, undefined);
  assert.deepEqual(requests, ['eth_chainId', 'eth_getTransactionReceipt']);
  const queued = await events();
  assert.equal(queued.length, 1);
  assert.equal(queued[0]!.type, 'rebalance-attention');
  assert.equal(queued[0]!.hash, hash);
  assert.doesNotMatch(queued[0]!.message, /Rebalance completed/);
  await acknowledgeEvent(queued[0]!.id);
  await tick(false);
  assert.deepEqual(await events(), []);
  assert.deepEqual(await readJson(PENDING_PATH), pending);
  assert.deepEqual(await readJson(CYCLE_PATH), cycle);
});

test('runtime failure alerts omit provider text, stop repeating after acknowledgement and reset on a healthy traversal', async () => {
  const script = `
    import assert from 'node:assert/strict';
    import { readFile } from 'node:fs/promises';
    import { mock } from 'node:test';
    globalThis.fetch = () => { throw new Error('This fixture cannot use a network'); };
    let failing = true;
    const secret = 'fixture-secret-provider-request';
    const { evaluatePortfolio } = await import(process.argv[4]);
    const targets = { USDG: 2000, TSLA: 2000, AAPL: 2000, NVDA: 2000, AMZN: 2000 };
    const portfolio = evaluatePortfolio(Object.keys(targets).map(id => ({
      id, symbol: id, decimals: 6, balance: 1000000n, priceUsdE8: 100000000n, targetBps: 2000,
    })));
    mock.module(process.argv[1], { namedExports: { createChain: () => ({
      snapshot: async () => {
        if (failing) throw new Error(secret);
        return { portfolio, nativeBalance: 0n, blockNumber: 1n, valuationNote: 'Local fixture' };
      },
      quote: async () => { throw new Error('Balanced fixture cannot quote'); },
      transaction: async () => { throw new Error('Fixture cannot prepare transactions'); },
    }) } });
    const runtime = await import(process.argv[2]);
    const notifications = await import(process.argv[3]);
    await runtime.tick(false);
    const first = (await notifications.events())[0];
    assert.equal(first.type, 'rebalance-attention');
    assert.doesNotMatch(first.message, /fixture-secret/);
    await notifications.acknowledgeEvent(first.id);
    await runtime.tick(false);
    assert.deepEqual(await notifications.events(), []);
    failing = false;
    const healthy = await runtime.tick(false);
    assert.equal(healthy.error, null);
    assert.equal(healthy.proposal, null);
    assert.deepEqual(await notifications.events(), [], 'healthy observation alone is not a completed trade');
    failing = true;
    await runtime.tick(false);
    const repeated = await notifications.events();
    assert.equal(repeated.length, 1);
    assert.notEqual(repeated[0].id, first.id);
    assert.doesNotMatch(await readFile(process.argv[5], 'utf8'), /fixture-secret/);
    process.stdout.write(JSON.stringify({ outcome: 'attention-transition-verified' }));
  `;
  const result = await promisify(execFile)(process.execPath,
    ['--experimental-test-module-mocks', '--import', 'tsx', '--input-type=module', '-e', script, '--',
      ...['chain', 'runtime', 'events', 'core'].map(name => new URL(`../src/${name}.ts`, import.meta.url).href),
      join(directory, 'events.json')],
    { env: { ...process.env, REBALANCE_DATA_DIR: directory }, timeout: 10_000 });
  assert.deepEqual(JSON.parse(result.stdout), { outcome: 'attention-transition-verified' });
});

test('status reflects current targets without an RPC refresh and discards another wallet’s holdings', async t => {
  t.mock.method(globalThis, 'fetch', () => { assert.fail('Local status must not query RPC'); });
  const previous = await saved({ proposal: { sellAssetId: 'TSLA', buyAssetId: 'USDG', amountIn: '1', reason: 'old targets' } });
  const nextTargets = { USDG: 1750, TSLA: 3000, AAPL: 1750, NVDA: 1750, AMZN: 1750 };
  await atomicWriteJson(CONFIG_PATH, { ...config, targets: nextTargets });
  const current = await status();
  assert.deepEqual(current.config?.targets, nextTargets);
  assert.equal(current.updatedAt, observedAt);
  assert.equal(current.portfolio?.totalUsdE8, previous.portfolio.totalUsdE8);
  for (const position of current.portfolio!.positions) {
    assert.equal(position.targetBps, nextTargets[position.id as keyof typeof nextTargets]);
    assert.equal(position.driftBps, position.weightBps - position.targetBps);
  }
  assert.equal(current.proposal, undefined);
  await atomicWriteJson(CONFIG_PATH, { ...config, wallet: '0x0000000000000000000000000000000000000002' });
  const switched = await status();
  assert.equal(switched.wallet, '0x0000000000000000000000000000000000000002');
  assert.equal(switched.portfolio, null);
  assert.equal(switched.updatedAt, null);
  assert.equal(switched.operation, null);
});

test('changing the selected stock set hides old holdings and proposals while pending recovery continues', async t => {
  await saved({ proposal: { sellAssetId: 'TSLA', buyAssetId: 'USDG', amountIn: '1', reason: 'previous stock set' } });
  const selected = { USDG: 500, AAPL: 2375, NVDA: 2375, RUN: 2375, MRNA: 2375 };
  await atomicWriteJson(CONFIG_PATH, { ...config, targets: selected });
  const current = await status();
  assert.deepEqual(current.config?.targets, selected);
  assert.equal(current.portfolio, null);
  assert.equal(current.proposal, undefined);
  assert.equal(current.updatedAt, null);
  assert.equal(current.blockNumber, undefined);
  assert.equal(current.valuationNote, undefined);
  await atomicWriteJson(PENDING_PATH, { chainId: 4663, wallet, hash, nonce: 1,
    kind: 'swap', createdAt: observedAt, status: 'broadcast' });
  const requests = mockRpc(t);
  const observed = await tick(false);
  assert.equal(observed.operation?.status, 'pending');
  assert.equal(observed.portfolio, null);
  assert.equal(observed.proposal, undefined);
  assert.equal(observed.updatedAt, null);
  assert.deepEqual(observed.config?.targets, selected);
  assert.deepEqual(requests, ['eth_chainId', 'eth_getTransactionReceipt']);
  assert.deepEqual(await events(), []);
});

test('armed status requires saved arming, a live runner and no stop request', async t => {
  await saved();
  assert.equal((await status()).armed, false, 'a vanished runner must not remain armed');
  await atomicWriteJson(join(directory, 'run.lock'), { pid: process.pid });
  assert.equal((await status()).armed, true);
  await atomicWriteJson(STOP_PATH, { requestedAt: observedAt });
  assert.equal((await status()).armed, false);
  await rm(STOP_PATH);
  t.mock.method(process, 'kill', () => { throw Object.assign(new Error('dead fixture'), { code: 'ESRCH' }); });
  assert.equal((await status()).armed, false);
});

test('monitor preserves a new stop before its first tick and disarms even after a fatal config error', async t => {
  t.mock.method(globalThis, 'fetch', () => { assert.fail('Stopped or invalid monitor must not query RPC'); });
  await saved();
  const request = { requestedAt: observedAt };
  await atomicWriteJson(STOP_PATH, request);
  await monitor(new AbortController().signal);
  assert.deepEqual(await readJson(STOP_PATH), request);
  assert.equal((await readJson<{ armed: boolean }>(STATE_PATH))?.armed, false);
  await rm(STOP_PATH);
  await saved();
  await writeFile(CONFIG_PATH, '{corrupt');
  await assert.rejects(monitor(new AbortController().signal), SyntaxError);
  const failed = await readJson<Status>(STATE_PATH);
  assert.equal(failed?.armed, false);
  assert.equal(failed?.graph.node, 'error');
  assert.match(failed?.error ?? '', /Local control or transaction state/);
  assert.doesNotMatch(JSON.stringify(failed), /corrupt/);
  assert.equal((await events())[0]?.type, 'rebalance-attention');
});

test('one cycle can complete four buys and their approvals, then persistent cooldown blocks later drift', async t => {
  let now = 2_000_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const legs = ['TSLA', 'AAPL', 'NVDA', 'AMZN'].flatMap(stock => [
    { stock, kind: 'approval' }, { stock, kind: 'swap' },
  ]);
  let dispatched = 0;
  let reconciled = 0;
  let quoted = 0;
  let previousKind: string | undefined;
  const deps: GraphDependencies = {
    configured: async () => true,
    reconcile: async () => {
      reconciled += 1;
      if (previousKind === 'swap') await markFixtureSwapConfirmed();
      return { blocked: false, operation: dispatched ? { status: 'confirmed' } : null };
    },
    observe: async () => portfolio,
    plan: async () => {
      if (!legs.length) { await finishRebalanceCycle(); return null; }
      return { sellAssetId: 'USDG', buyAssetId: legs[0].stock, amountIn: 1n, reason: 'Fixture leg' };
    },
    interval: async () => (await rebalanceInterval(config)).operation,
    quote: async () => { quoted += 1; return {}; },
    execute: async () => {
      await beginRebalanceCycle(config);
      assert.ok(await readJson(CYCLE_PATH), 'the interval must be durable before the first dispatch');
      dispatched += 1;
      previousKind = legs.shift()!.kind;
      return { status: 'pending', kind: previousKind };
    },
    publish: async () => {}, canExecute: true,
  };
  await runGraph(deps);
  const first = await readJson<Record<string, unknown>>(CYCLE_PATH);
  for (let leg = 1; leg < 8; leg += 1) {
    now += 30_000;
    assert.equal((await runGraph(deps)).node, 'receipt');
    const current = await readJson<Record<string, unknown>>(CYCLE_PATH);
    assert.deepEqual({ ...current, swapConfirmed: first!.swapConfirmed }, first, 'later legs must not reset either timer');
  }
  assert.equal(dispatched, 8);
  assert.equal(quoted, 8);
  now += 30_000;
  await runGraph(deps);
  assert.equal((await rebalanceInterval(config)).operation?.status, 'cooling-down');
  const closed = await readJson<{ startedAt: number; activeUntil: number; nextEligibleAt: number }>(CYCLE_PATH);
  assert.equal(closed!.activeUntil, now);
  assert.equal(closed!.nextEligibleAt - closed!.startedAt, 3_600_000);
  legs.push({ stock: 'TSLA', kind: 'swap' });
  await runGraph(deps);
  assert.equal(dispatched, 8);
  assert.equal(quoted, 8);
  assert.equal(reconciled, 10, 'receipt recovery keeps running during cooldown');
});

test('cycle expiry bounds ongoing drift and target/wallet edits cannot shorten persisted eligibility', async t => {
  let now = 2_000_000_000_000;
  t.mock.method(Date, 'now', () => now);
  await beginRebalanceCycle(config);
  await markFixtureSwapConfirmed();
  const first = (await rebalanceInterval(config)).cycle!;
  assert.equal(Date.parse(first.activeUntil) - now, ACTIVE_CYCLE_SECONDS * 1000);
  const otherWallet = { ...config, wallet: '0x0000000000000000000000000000000000000002' as const };
  assert.equal((await rebalanceInterval(otherWallet)).operation?.status, 'cooling-down');
  await assert.rejects(beginRebalanceCycle(otherWallet), /no new trades before/);
  now += ACTIVE_CYCLE_SECONDS * 1000;
  assert.equal((await rebalanceInterval(config)).operation?.status, 'cooling-down');
  const edited = { ...config, rebalanceIntervalSeconds: 1,
    targets: { USDG: 500, AAPL: 2375, NVDA: 2375, MSFT: 2375, AMD: 2375 } };
  assert.equal((await rebalanceInterval(edited)).cycle?.nextEligibleAt, first.nextEligibleAt);
  await assert.rejects(beginRebalanceCycle(edited), /no new trades before/);
  now = Date.parse(first.nextEligibleAt);
  assert.equal((await rebalanceInterval(config)).operation, null);
  const next = await beginRebalanceCycle(config);
  assert.equal(Date.parse(next.startedAt), now);
  assert.equal(Date.parse(next.nextEligibleAt), now + ACTIVE_CYCLE_SECONDS * 1000);
});

test('a fresh process observes the retained cooldown without RPC, arming or signing', async t => {
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  await beginRebalanceCycle(config);
  await markFixtureSwapConfirmed();
  await finishRebalanceCycle();
  const before = await readJson(CYCLE_PATH);
  const script = `
    globalThis.fetch = () => { throw new Error('No test network calls'); };
    const { loadConfig } = await import(process.argv[1]);
    const { rebalanceInterval, status } = await import(process.argv[2]);
    process.stdout.write(JSON.stringify({ interval: await rebalanceInterval(await loadConfig()), status: await status() }));
  `;
  const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, '--',
    new URL('../src/config.ts', import.meta.url).href, new URL('../src/runtime.ts', import.meta.url).href],
  { env: { ...process.env, REBALANCE_DATA_DIR: directory }, timeout: 10_000 });
  const child = JSON.parse(result.stdout);
  assert.equal(result.stderr, '');
  assert.equal(child.interval.operation.status, 'cooling-down');
  assert.equal(child.status.armed, false);
  assert.equal(child.status.config.rebalanceIntervalSeconds, 3600);
  assert.equal(child.status.cycle.nextEligibleAt, child.interval.cycle.nextEligibleAt);
  assert.deepEqual(await readJson(CYCLE_PATH), before);
});

test('pending receipt recovery proceeds during cooldown and preserves both durable records', async t => {
  await beginRebalanceCycle(config);
  await finishRebalanceCycle();
  const before = await readJson(CYCLE_PATH);
  const pending = { chainId: 4663, wallet, hash, nonce: 1, kind: 'swap', createdAt: observedAt, status: 'broadcast' };
  await atomicWriteJson(PENDING_PATH, pending);
  const requests = mockRpc(t);
  const current = await tick(true);
  assert.equal(current.operation?.status, 'pending');
  assert.deepEqual(requests, ['eth_chainId', 'eth_getTransactionReceipt']);
  assert.deepEqual(await readJson(PENDING_PATH), pending);
  assert.deepEqual(await readJson(CYCLE_PATH), before);
});

test('production tick bounds an approval by the active cycle and rejects expiry at the send boundary', async () => {
  // Mock only the network adapter in a fresh process. Production tick, cycle
  // persistence and dispatch run unchanged against a public disposable key.
  const script = `
    import assert from 'node:assert/strict';
    import { mock } from 'node:test';
    import { privateKeyToAccount } from 'viem/accounts';
    const key = '0x' + '1'.padStart(64, '0');
    process.env.REBALANCE_PRIVATE_KEY = key;
    globalThis.fetch = () => { throw new Error('This test cannot use a network'); };
    const wallet = privateKeyToAccount(key).address;
    let now = 2000000000000;
    const startedAt = now;
    mock.method(Date, 'now', () => now);
    let sends = 0;
    const { evaluatePortfolio } = await import(process.argv[4]);
    const targets = { USDG: 2000, TSLA: 2000, AAPL: 2000, NVDA: 2000, AMZN: 2000 };
    const portfolio = evaluatePortfolio(Object.keys(targets).map(id => ({
      id, symbol: id, decimals: id === 'USDG' ? 6 : 18,
      balance: id === 'USDG' ? 100000000n : 0n, priceUsdE8: 100000000n, targetBps: targets[id],
    })));
    const rpc = {
      getChainId: async () => 4663,
      getTransactionCount: async () => 0,
      estimateGas: async () => 21000n,
      getGasPrice: async () => 1n,
      getBalance: async () => { now = startedAt + 601000; return 1000000000000000000n; },
      sendRawTransaction: async () => { sends += 1; throw new Error('Unexpected test send'); },
    };
    const chain = {
      publicClient: rpc,
      snapshot: async () => ({ portfolio, nativeBalance: 1000000000000000000n, blockNumber: 100n, valuationNote: 'Local fixture' }),
      quote: async () => ({ amountOut: 1n, minimumOut: 1n, fee: 500, blockNumber: 100n }),
      transaction: async () => ({ to: wallet, data: '0x', value: 0n, kind: 'approval' }),
    };
    mock.module(process.argv[2], { namedExports: { createChain: () => chain } });
    const configModule = await import(process.argv[1]);
    const runtime = await import(process.argv[3]);
    const storage = await import(process.argv[5]);
    await storage.atomicWriteJson(configModule.CONFIG_PATH, configModule.validateConfig({
      version: 1, chainId: 4663, wallet, mode: 'private-key', rpcUrl: 'http://blocked-fixture.invalid',
      targets, driftThresholdBps: 500, slippageBps: 50, deadlineSeconds: 120, pollSeconds: 30,
    }));
    const release = await storage.acquireLock(configModule.DATA);
    let state;
    try { state = await runtime.tick(true); } finally { await release(); }
    assert.match(state.error, /deadline expired/);
    assert.equal(sends, 0);
    assert.equal(await storage.readJson(configModule.PENDING_PATH), null);
    const cycle = await storage.readJson(runtime.CYCLE_PATH);
    assert.equal(cycle.startedAt, startedAt);
    assert.equal(cycle.activeUntil, startedAt + 600000);
    assert.equal(cycle.nextEligibleAt, startedAt + 3600000);
    process.stdout.write(JSON.stringify({ status: 'expired-before-send', sends }));
  `;
  const result = await promisify(execFile)(process.execPath,
    ['--experimental-test-module-mocks', '--import', 'tsx', '--input-type=module', '-e', script, '--',
      ...['config', 'chain', 'runtime', 'core', 'storage'].map(name => new URL(`../src/${name}.ts`, import.meta.url).href)],
    { env: { ...process.env, REBALANCE_DATA_DIR: directory }, timeout: 10_000 });
  assert.deepEqual(JSON.parse(result.stdout), { status: 'expired-before-send', sends: 0 });
});

test('recovery preserves the remaining attempt window and does not impose an hourly cooldown without a successful swap', async () => {
  const script = `
    import assert from 'node:assert/strict';
    import { mock } from 'node:test';
    import { keccak256, parseTransaction, TransactionNotFoundError, TransactionReceiptNotFoundError } from 'viem';
    import { privateKeyToAccount } from 'viem/accounts';
    const key = '0x' + '9'.padStart(64, '0');
    process.env.REBALANCE_PRIVATE_KEY = key;
    globalThis.fetch = () => { throw new Error('This fixture cannot access a network'); };
    const wallet = privateKeyToAccount(key).address;
    const originalHash = '0x' + '12'.repeat(32);
    const blockHash = '0x' + '34'.repeat(32);
    const scenario = process.argv[6];
    const targets = { USDG: 2000, TSLA: 2000, AAPL: 2000, NVDA: 2000, AMZN: 2000 };
    const { evaluatePortfolio } = await import(process.argv[4]);
    const portfolio = evaluatePortfolio(Object.keys(targets).map(id => ({
      id, symbol: id, decimals: 6, balance: 20000000n,
      priceUsdE8: 100000000n, targetBps: targets[id],
    })));
    let now = 2000000000000;
    mock.method(Date, 'now', () => now);
    let cancellationHash;
    let ready = false;
    let sends = 0;
    let observations = 0;
    const receipts = new Map();
    const transactions = new Map();
    let storage;
    let configModule;
    const rpc = {
      getChainId: async () => 4663,
      getTransactionReceipt: async ({ hash }) => {
        if (!receipts.has(hash)) throw new TransactionReceiptNotFoundError({ hash });
        return receipts.get(hash);
      },
      getTransaction: async ({ hash }) => {
        if (!transactions.has(hash)) throw new TransactionNotFoundError({ hash });
        return transactions.get(hash);
      },
      getTransactionCount: async () => ready ? 4 : 3,
      getCode: async () => '0x', getGasPrice: async () => 2n, getBalance: async () => 1000000000000000000n,
      getBlock: async () => ({ hash: blockHash }), getBlockNumber: async () => 101n,
      estimateGas: async tx => {
        assert.equal(tx.account, wallet); assert.equal(tx.to, wallet);
        assert.equal(tx.value, 0n); assert.equal(tx.data, '0x');
        return 21000n;
      },
      sendRawTransaction: async ({ serializedTransaction }) => {
        assert.equal(scenario, 'cancelled', 'a mined original revert must never need a cancellation');
        assert.ok(await storage.readJson(configModule.DATA + '/run.lock'));
        assert.ok(await storage.readJson(configModule.DATA + '/config.lock'));
        const parsed = parseTransaction(serializedTransaction);
        assert.equal(parsed.nonce, 3); assert.equal(parsed.chainId, 4663);
        assert.equal(parsed.to.toLowerCase(), wallet.toLowerCase());
        assert.equal(parsed.value ?? 0n, 0n); assert.equal(parsed.data ?? '0x', '0x');
        assert.equal(parsed.gas, 25200n); assert.equal(parsed.gasPrice, 10n);
        cancellationHash = keccak256(serializedTransaction);
        const recorded = await storage.readJson(configModule.DATA + '/recovery.json');
        assert.equal(recorded.cancellation.hash, cancellationHash);
        assert.equal(recorded.cancellation.status, 'prepared');
        assert.equal((await storage.readJson(configModule.PENDING_PATH)).hash, originalHash);
        sends++;
        return cancellationHash;
      },
    };
    mock.module(process.argv[1], { namedExports: { createChain: () => ({ publicClient: rpc,
      snapshot: async () => {
        if (observations === 0) {
          const beforeObservation = await storage.readJson(runtime.CYCLE_PATH);
          assert.equal(beforeObservation.activeUntil, cycle.activeUntil, 'recovery must not close the remaining attempt window');
          assert.equal((await runtime.rebalanceInterval(config)).operation, null, 'further legs could continue in the original window');
        }
        observations++; return { portfolio, nativeBalance: 1000000000000000000n,
          blockNumber: 101n, valuationNote: 'Isolated balanced fixture' };
      },
      quote: async () => { throw new Error('Balanced fixture must not quote'); },
      transaction: async () => { throw new Error('Recovery must never prepare a new trade'); },
    }) } });
    configModule = await import(process.argv[2]);
    const runtime = await import(process.argv[3]);
    storage = await import(process.argv[5]);
    const notifications = await import(process.argv[7]);
    const config = configModule.validateConfig({ version: 1, chainId: 4663, wallet, mode: 'private-key',
      rpcUrl: 'http://blocked-fixture.invalid', targets, driftThresholdBps: 500, slippageBps: 50,
      deadlineSeconds: 120, pollSeconds: 30, rebalanceIntervalSeconds: 3600 });
    await storage.atomicWriteJson(configModule.CONFIG_PATH, config);
    await runtime.beginRebalanceCycle(config);
    const cycle = await storage.readJson(runtime.CYCLE_PATH);
    const original = { chainId: 4663, wallet, hash: originalHash, nonce: 3, kind: 'swap',
      createdAt: new Date(now).toISOString(), status: 'unknown', gas: '25200', gasPrice: '5' };
    await storage.atomicWriteJson(configModule.PENDING_PATH, original);
    now += 360000;
    const release = await storage.acquireLock(configModule.DATA);
    try {
      const inspected = await runtime.tick(false);
      assert.equal(inspected.operation.status, 'unresolved');
      assert.equal(inspected.graph.trace.includes('recover'), false);
      assert.equal(sends, 0); assert.equal(observations, 0);
      assert.equal(await storage.readJson(configModule.DATA + '/recovery.json'), null);
      assert.deepEqual(await storage.readJson(configModule.PENDING_PATH), original);
      assert.deepEqual(await storage.readJson(runtime.CYCLE_PATH), cycle);
      for (const event of await notifications.events()) await notifications.acknowledgeEvent(event.id);
      if (scenario === 'cancelled') {
        const awaiting = await runtime.tick(true);
        assert.equal(awaiting.error, null); assert.equal(awaiting.operation.status, 'unresolved');
        assert.equal(sends, 1); assert.equal(observations, 0);
        assert.deepEqual(await storage.readJson(configModule.PENDING_PATH), original);
        assert.deepEqual(await storage.readJson(runtime.CYCLE_PATH), cycle);
      }
      ready = true;
      const hash = scenario === 'cancelled' ? cancellationHash : originalHash;
      const to = scenario === 'cancelled' ? wallet : '0x0000000000000000000000000000000000000001';
      transactions.set(hash, { hash, from: wallet, to, nonce: 3, value: 0n, input: '0x', chainId: 4663,
        gasPrice: 10n, blockNumber: 100n, blockHash });
      receipts.set(hash, { transactionHash: hash, from: wallet, to,
        status: scenario === 'cancelled' ? 'success' : 'reverted', blockNumber: 100n, blockHash });
      const recovered = await runtime.tick(true);
      assert.equal(recovered.error, null); assert.equal(recovered.operation.status, scenario);
      assert.ok(recovered.graph.trace.includes('recover')); assert.ok(recovered.graph.trace.includes('observe'));
      assert.equal(recovered.graph.trace.includes('execute'), false);
      assert.equal(recovered.proposal, null, 'the fresh balanced fixture closes the window through ordinary planning');
      assert.equal(await storage.readJson(configModule.PENDING_PATH), null);
      const closed = await storage.readJson(runtime.CYCLE_PATH);
      assert.equal(closed.startedAt, cycle.startedAt); assert.equal(closed.activeUntil, now);
      assert.equal(closed.nextEligibleAt, cycle.nextEligibleAt);
      assert.equal(closed.swapConfirmed, false);
      assert.equal(Date.parse(recovered.cycle.nextEligibleAt), cycle.startedAt + 600000);
      const queued = await notifications.events();
      assert.equal(queued.filter(event => event.type === 'rebalance-completed').length, 0);
      const recoveryEvent = queued.filter(event => event.type === 'rebalance-recovered');
      assert.equal(recoveryEvent.length, 1); assert.equal(recoveryEvent[0].hash, hash);
      assert.match(recoveryEvent[0].message, /not a completed rebalance/);
      for (const event of queued) await notifications.acknowledgeEvent(event.id);
      await runtime.tick(true);
      assert.deepEqual(await notifications.events(), []);
      assert.deepEqual(await storage.readJson(runtime.CYCLE_PATH), closed);
      assert.equal(sends, scenario === 'cancelled' ? 1 : 0);
      assert.equal(await storage.readJson(runtime.STOP_PATH), null);
      assert.deepEqual(await storage.readJson(configModule.CONFIG_PATH), config);
      process.stdout.write(JSON.stringify({ scenario, sends, outcome: 'no-hourly-cooldown' }));
    } finally { await release(); }
  `;
  for (const scenario of ['cancelled', 'recovered-revert']) {
    const result = await promisify(execFile)(process.execPath,
      ['--experimental-test-module-mocks', '--import', 'tsx', '--input-type=module', '-e', script, '--',
        ...['chain', 'config', 'runtime', 'core', 'storage'].map(name => new URL(`../src/${name}.ts`, import.meta.url).href),
        scenario, new URL('../src/events.ts', import.meta.url).href],
      { env: { ...process.env, REBALANCE_DATA_DIR: join(directory, scenario) }, timeout: 15_000 });
    assert.deepEqual(JSON.parse(result.stdout), { scenario, sends: scenario === 'cancelled' ? 1 : 0, outcome: 'no-hourly-cooldown' });
  }
});

test('deferred signers never enter automatic recovery for aged unresolved transactions', async t => {
  const pending: PendingTransaction = { chainId: 4663, wallet, hash, nonce: 1,
    kind: 'swap', createdAt: observedAt, status: 'unknown' };
  await atomicWriteJson(PENDING_PATH, pending);
  mockRpc(t);
  for (const mode of ['ledger', 'privy']) {
    await atomicWriteJson(CONFIG_PATH, { ...config, mode });
    const state = await tick(true);
    assert.equal(state.operation?.status, 'unresolved');
    assert.equal(state.graph.trace.includes('recover'), false);
    assert.equal(await readJson(join(directory, 'recovery.json')), null);
    assert.deepEqual(await readJson(PENDING_PATH), pending);
  }
});
