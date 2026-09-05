import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test, type TestContext } from 'node:test';
import { ASSETS } from '../src/assets.js';
import { evaluatePortfolio } from '../src/core.js';
import { atomicWriteJson, readJson, type PendingTransaction } from '../src/storage.js';

// This suite has its own process/data directory. It never provisions a signer.
const directory = await mkdtemp(join(tmpdir(), 'rebalance-runtime-test-'));
process.env.REBALANCE_DATA_DIR = directory;
delete process.env.REBALANCE_PRIVATE_KEY;
const { CONFIG_PATH, STATE_PATH, PENDING_PATH, LAST_TRANSACTION_PATH, validateConfig } = await import('../src/config.js');
const { initialStatus, monitor, status, tick, STOP_PATH } = await import('../src/runtime.js');
const { events } = await import('../src/events.js');
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
  assert.deepEqual(await events(), []);
});

test('recovery clears an unscoped cached operation instead of reusing it for a later completion', async t => {
  const legacy = { status: 'confirmed', kind: 'swap', hash };
  await saved({ operation: legacy, proposal: null });
  await atomicWriteJson(LAST_TRANSACTION_PATH, legacy);
  mockRpc(t, 1);
  const result = await tick(false);
  assert.equal(result.operation, null);
  assert.deepEqual(await events(), []);
  assert.deepEqual(await readJson(LAST_TRANSACTION_PATH), legacy);
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
  assert.equal((await readJson<{ armed: boolean }>(STATE_PATH))?.armed, false);
});
