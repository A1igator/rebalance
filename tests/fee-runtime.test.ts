import { assertTemporaryTestDirectory } from '../src/test-isolation.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { keccak256, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { evaluatePortfolio } from '../src/core.js';
import { acquireLock, atomicWriteJson, readJson, stringifyJson } from '../src/storage.js';
import { ETH_USD_SPOT_URL } from '../src/gas-display.js';

// Public disposable signer vector. All chain and ETH/USD responses are offline fixtures.
const key = `0x${'1'.padStart(64, '0')}` as const;
const wallet = privateKeyToAccount(key).address;
const dataDir = await mkdtemp(join(tmpdir(), 'rebalance-fee-runtime-'));
assertTemporaryTestDirectory(dataDir);
process.env.REBALANCE_DATA_DIR = dataDir;
process.env.REBALANCE_PRIVATE_KEY = key;
const { DATA, CONFIG_PATH, STATE_PATH, PENDING_PATH, validateConfig } = await import('../src/config.js');
assert.equal(DATA, dataDir, 'captured DATA must belong to this disposable fixture');
for (const path of [CONFIG_PATH, STATE_PATH, PENDING_PATH]) assert.equal(path.startsWith(`${dataDir}/`), true, 'captured file path must belong to this fixture');
const { tick, status, CYCLE_PATH } = await import('../src/runtime.js');
const { LedgerExecution, LEDGER_REQUEST_PATH } = await import('../src/ledger-request.js');
const { events } = await import('../src/events.js');
type Chain = ReturnType<typeof import('../src/chain.js').createChain>;
const targets = { USDG: 500, AAPL: 2375, NVDA: 2375, MSFT: 2375, AMD: 2375 };
const config = validateConfig({ version: 1, chainId: 4663, wallet, mode: 'private-key',
  rpcUrl: 'http://fee-runtime-fixture.invalid', targets, driftThresholdBps: 500, slippageBps: 50,
  deadlineSeconds: 120, pollSeconds: 5, rebalanceFeeTargetUsdE8: '1' });

beforeEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await mkdir(dataDir, { mode: 0o700 });
  await atomicWriteJson(CONFIG_PATH, config);
});
after(() => rm(dataDir, { recursive: true, force: true }));

function fixture() {
  const sent: Hex[] = [];
  let transactions = 0;
  const chain = {
    publicClient: {
      getChainId: async () => 4663,
      getTransactionCount: async () => 0,
      estimateGas: async () => 21_000n,
      getGasPrice: async () => 1_000_000_000n,
      getBalance: async () => 10n ** 18n,
      sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
        sent.push(serializedTransaction); return keccak256(serializedTransaction);
      },
    },
    snapshot: async () => ({ portfolio: evaluatePortfolio(Object.keys(targets).map(id => ({
      id, symbol: id, decimals: 6, balance: id === 'USDG' ? 100_000_000n : 0n,
      priceUsdE8: 100_000_000n, targetBps: targets[id as keyof typeof targets],
    }))), nativeBalance: 10n ** 18n, blockNumber: 100n, valuationNote: 'Offline public fixture' }),
    quote: async () => ({ amountOut: 1n, minimumOut: 1n, fee: 500, blockNumber: 100n }),
    transaction: async () => {
      transactions++; return { to: wallet, data: '0x1234', value: 0n, kind: 'approval' };
    },
  };
  return { chain: chain as unknown as Chain, sent, transactions: () => transactions };
}

for (const quote of ['above-target', 'unavailable'] as const) {
  test(`runtime ${quote} fee result is a local wait without an error or chat attention`, async t => {
    const f = fixture(); let prices = 0;
    t.mock.method(globalThis, 'fetch', async (url: unknown) => {
      assert.equal(url, ETH_USD_SPOT_URL); prices++;
      return quote === 'above-target'
        ? new Response(JSON.stringify({ data: { base: 'ETH', currency: 'USD', amount: '3000' } }))
        : new Response('public-fixture-unavailable', { status: 503 });
    });
    const release = await acquireLock(dataDir);
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const state = await tick(true, () => f.chain);
        assert.equal(state.error, null); assert.equal(state.operation?.status, 'fee-target');
        assert.equal(state.graph.node, 'wait'); assert.ok(!state.graph.trace.includes('error'));
        assert.equal(state.feeCheck?.state, quote);
        assert.equal(state.config?.rebalanceFeeTargetUsdE8, '1');
        assert.equal(f.sent.length, 0); assert.equal(await readJson(PENDING_PATH), null);
        assert.deepEqual(await events(), [], 'normal fee waits must not wake a model or human');
        const saved = await readJson<{ error: unknown; operation: { status: string }; feeCheck: { state: string } }>(STATE_PATH);
        assert.equal(saved?.error, null); assert.equal(saved?.operation.status, 'fee-target');
        assert.equal(saved?.feeCheck.state, quote);
      }
      assert.equal(prices, 2); assert.equal(f.transactions(), 2);
    } finally { await release(); }
  });
}

test('deterministic later traversal resumes automatically when its fresh fee estimate meets the target', async t => {
  await atomicWriteJson(CONFIG_PATH, { ...config, rebalanceFeeTargetUsdE8: '200000000' });
  const f = fixture(); let prices = 0;
  t.mock.method(globalThis, 'fetch', async (url: unknown) => {
    assert.equal(url, ETH_USD_SPOT_URL); prices++;
    return new Response(JSON.stringify({ data: { base: 'ETH', currency: 'USD', amount: prices === 1 ? '9000' : '100' } }));
  });
  const release = await acquireLock(dataDir);
  try {
    const waiting = await tick(true, () => f.chain);
    assert.equal(waiting.operation?.status, 'fee-target'); assert.equal(waiting.feeCheck?.state, 'above-target');
    assert.equal(f.sent.length, 0);
    const resumed = await tick(true, () => f.chain);
    assert.equal(resumed.error, null); assert.equal(resumed.operation?.status, 'pending');
    assert.equal(resumed.feeCheck?.state, 'within-target'); assert.equal(resumed.graph.node, 'receipt');
    assert.equal(f.sent.length, 1); assert.ok(await readJson(PENDING_PATH));
    assert.deepEqual(await events(), [], 'resuming an automatic wait is not a notification-worthy outcome');
    assert.equal(prices, 2);
  } finally { await release(); }
});

test('inspection does not load the signer or request execution fee pricing', async t => {
  const f = fixture();
  t.mock.method(globalThis, 'fetch', () => assert.fail('Inspection must not request an execution fee quote'));
  const release = await acquireLock(dataDir);
  try {
    const state = await tick(false, () => f.chain);
    assert.equal(state.error, null); assert.equal(state.operation?.status, 'needs-rebalance');
    assert.equal(state.feeCheck, undefined); assert.equal(f.transactions(), 0); assert.equal(f.sent.length, 0);
    assert.equal(await readJson(PENDING_PATH), null); assert.deepEqual(await events(), []);
  } finally { await release(); }
});


for (const quote of ['above-target', 'unavailable'] as const) {
  for (const connected of [false, true]) {
    test(`inactive Ledger ${quote} stays passive until affordable, with USB ${connected ? 'connected' : 'disconnected'}`, async t => {
      await atomicWriteJson(CONFIG_PATH, { ...config, mode: 'ledger', rebalanceFeeTargetUsdE8: '200000000' });
      const f = fixture(); const ledger = new LedgerExecution();
      const presence = { connected, revision: 1 };
      let affordable = false; let prices = 0;
      t.mock.method(globalThis, 'fetch', async (url: unknown) => {
        assert.equal(url, ETH_USD_SPOT_URL); prices++;
        return !affordable && quote === 'unavailable'
          ? new Response('public-fixture-unavailable', { status: 503 })
          : new Response(JSON.stringify({ data: { base: 'ETH', currency: 'USD', amount: affordable ? '100' : '9000' } }));
      });
      // These guards fail before any signer/device could be reached if passive
      // monitoring accidentally enters the execution branch.
      const readiness = t.mock.method(ledger, 'assertReady', async () => assert.fail('Passive fee checks must not enter signing readiness'));
      const binding = t.mock.method(ledger, 'bindCycle', async () => assert.fail('Passive fee checks must not bind a signing cycle'));
      const nonce = t.mock.method(f.chain.publicClient, 'getTransactionCount', async () => assert.fail('Passive fee checks must not prepare a signing nonce'));
      const balance = t.mock.method(f.chain.publicClient, 'getBalance', async () => assert.fail('Passive fee checks must not enter dispatch balance validation'));
      const backend = t.mock.method(ledger, 'prepareAutomatic', async () => false);
      const assertPassive = async () => {
        assert.equal(ledger.active, false); assert.equal(f.sent.length, 0);
        assert.equal(readiness.mock.callCount(), 0); assert.equal(binding.mock.callCount(), 0);
        assert.equal(nonce.mock.callCount(), 0); assert.equal(balance.mock.callCount(), 0);
        assert.equal(await readJson(PENDING_PATH), null); assert.equal(await readJson(CYCLE_PATH), null);
        assert.equal(await readJson(LEDGER_REQUEST_PATH), null, 'monitoring cannot create signing intent');
      };
      const release = await acquireLock(dataDir);
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          const waiting = await tick(true, () => f.chain, ledger, undefined, presence);
          assert.equal(waiting.error, null); assert.equal(waiting.operation?.status, 'fee-target');
          assert.equal(waiting.feeCheck?.state, quote); assert.equal(waiting.graph.node, 'wait');
          assert.equal(waiting.ledgerRequest, null); assert.equal(waiting.cycle, null);
          assert.deepEqual(await events(), [], 'unaffordable or unavailable fees must not request Ledger attention');
          await assertPassive();
        }
        assert.equal(prices, 2); assert.equal(backend.mock.callCount(), 0); affordable = true;
        const waitingForUser = await tick(true, () => f.chain, ledger, undefined, presence);
        assert.equal(waitingForUser.error, null); assert.equal(waitingForUser.operation?.status, 'waiting-ledger');
        assert.equal(waitingForUser.feeCheck?.state, 'within-target');
        assert.equal(waitingForUser.ledgerRequest, null); assert.equal(waitingForUser.cycle, null);
        const attention = await events();
        assert.equal(attention.length, 0, 'backend-handled Ledger work never wakes a model');
        assert.equal(backend.mock.callCount(), connected ? 1 : 0, 'only affordable connected work reaches backend execution preparation');
        await assertPassive();
        const repeated = await tick(true, () => f.chain, ledger, undefined, presence);
        assert.equal(repeated.operation?.status, 'waiting-ledger');
        assert.equal(repeated.feeCheck?.state, 'within-target');
        assert.deepEqual(await events(), attention, 'the affordable drift condition must not repeat its alert');
        assert.equal(prices, 4); assert.equal(f.transactions(), 4);
        await assertPassive();
      } finally { await release(); }
    });
  }
}

for (const changed of ['targets', 'drift-threshold'] as const) {
  test(`status clears a saved fee wait after ${changed} changes without querying or rewriting state`, async t => {
    const ledgerConfig = { ...config, mode: 'ledger' as const };
    await atomicWriteJson(CONFIG_PATH, ledgerConfig);
    const f = fixture();
    const price = t.mock.method(globalThis, 'fetch', async (url: unknown) => {
      assert.equal(url, ETH_USD_SPOT_URL);
      return new Response(JSON.stringify({ data: { base: 'ETH', currency: 'USD', amount: '3000' } }));
    });
    const release = await acquireLock(dataDir);
    try {
      const waiting = await tick(true, () => f.chain);
      assert.equal(waiting.operation?.status, 'fee-target'); assert.equal(waiting.feeCheck?.state, 'above-target');
      price.mock.mockImplementation(async () => assert.fail('Status must not request fresh execution pricing'));
      const retained = await status();
      assert.deepEqual(retained.feeCheck, waiting.feeCheck);
      assert.equal(retained.operation?.status, 'fee-target');
      const stateBytes = await readFile(STATE_PATH, 'utf8');
      const next = validateConfig({ ...ledgerConfig, ...(changed === 'targets'
        ? { targets: { ...targets, USDG: 600, AAPL: 2275 } }
        : { driftThresholdBps: 600 }) });
      await atomicWriteJson(CONFIG_PATH, next);
      const current = await status();
      assert.equal(current.error, null); assert.equal(current.operation, null);
      assert.equal(Object.hasOwn(current, 'feeCheck'), false);
      assert.deepEqual(current.config?.targets, next.targets);
      assert.equal(current.config?.driftThresholdBps, next.driftThresholdBps);
      assert.equal(current.config?.rebalanceFeeTargetUsdE8, ledgerConfig.rebalanceFeeTargetUsdE8);
      assert.equal(await readFile(STATE_PATH, 'utf8'), stateBytes, 'display reads must not mutate the runtime journal');
      assert.equal(price.mock.callCount(), 1); assert.equal(f.sent.length, 0);
      assert.equal(await readJson(PENDING_PATH), null); assert.equal(await readJson(CYCLE_PATH), null);
      assert.equal(await readJson(LEDGER_REQUEST_PATH), null); assert.deepEqual(await events(), []);
    } finally { await release(); }
  });
}

for (const change of ['stop', 'configuration'] as const) {
  test(`inactive Ledger preserves ${change} arriving during an affordable fee request without attention`, { timeout: 5_000 }, async t => {
    const ledgerConfig = { ...config, mode: 'ledger' as const, rebalanceFeeTargetUsdE8: '200000000' };
    const changedConfig = { ...ledgerConfig, driftThresholdBps: 600 };
    const stop = { requestId: 'stop-during-passive-fee-fixture' };
    await atomicWriteJson(CONFIG_PATH, ledgerConfig);
    const f = fixture(); const ledger = new LedgerExecution();
    const readiness = t.mock.method(ledger, 'assertReady', async () => assert.fail('A passive control change cannot reach signing readiness'));
    const binding = t.mock.method(ledger, 'bindCycle', async () => assert.fail('A passive control change cannot bind a signing cycle'));
    const nonce = t.mock.method(f.chain.publicClient, 'getTransactionCount', async () => assert.fail('A passive control change cannot prepare a signing nonce'));
    const price = t.mock.method(globalThis, 'fetch', async (url: unknown) => {
      assert.equal(url, ETH_USD_SPOT_URL);
      assert.equal(await readJson(PENDING_PATH), null); assert.equal(await readJson(CYCLE_PATH), null);
      // Persist the newer control revision before this in-flight quote resolves.
      if (change === 'stop') await atomicWriteJson(join(dataDir, 'stop.json'), stop);
      else await atomicWriteJson(CONFIG_PATH, changedConfig);
      return new Response(JSON.stringify({ data: { base: 'ETH', currency: 'USD', amount: '100' } }));
    });
    const release = await acquireLock(dataDir);
    try {
      const state = await tick(true, () => f.chain, ledger, undefined, { connected: true, revision: 1 });
      assert.equal(state.error, null); assert.equal(state.feeCheck?.state, change === 'stop' ? 'within-target' : undefined);
      assert.equal(state.operation?.status, change === 'stop' ? 'stopping' : 'configuration-changed');
      assert.equal(state.ledgerRequest, null); assert.equal(state.cycle, null); assert.equal(ledger.active, false);
      assert.deepEqual(await events(), [], 'a superseded quote must not request Ledger attention');
      assert.equal(readiness.mock.callCount(), 0); assert.equal(binding.mock.callCount(), 0);
      assert.equal(nonce.mock.callCount(), 0); assert.equal(f.sent.length, 0);
      assert.equal(price.mock.callCount(), 1); assert.equal(f.transactions(), 1);
      assert.equal(await readJson(PENDING_PATH), null); assert.equal(await readJson(CYCLE_PATH), null);
      assert.equal(await readJson(LEDGER_REQUEST_PATH), null);
      assert.deepEqual(await readJson(CONFIG_PATH), change === 'stop' ? ledgerConfig : changedConfig);
      assert.deepEqual(await readJson(join(dataDir, 'stop.json')), change === 'stop' ? stop : null);
    } finally { await release(); }
  });
}


test('inactive Ledger transaction-read failures stay local and suppress raw RPC text on repeated checks', { timeout: 5_000 }, async t => {
  await atomicWriteJson(CONFIG_PATH, { ...config, mode: 'ledger' });
  const f = fixture(); const ledger = new LedgerExecution();
  const rawText = 'PASSIVE_RPC_PAYLOAD: allowance request failed at https://provider-fixture.invalid/opaque-body';
  const preparation = t.mock.method(f.chain, 'transaction', async () => { throw new Error(rawText); });
  const readiness = t.mock.method(ledger, 'assertReady', async () => assert.fail('Failed passive preparation cannot enter signing readiness'));
  const binding = t.mock.method(ledger, 'bindCycle', async () => assert.fail('Failed passive preparation cannot bind a signing cycle'));
  const price = t.mock.method(globalThis, 'fetch', async () => assert.fail('Failed preparation has no transaction to price'));
  const release = await acquireLock(dataDir);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const state = await tick(true, () => f.chain, ledger, undefined, { connected: true, revision: 1 });
      assert.equal(state.error, null); assert.equal(state.operation?.status, 'fee-target');
      assert.equal(state.graph.node, 'wait'); assert.ok(!state.graph.trace.includes('error'));
      assert.deepEqual(state.feeCheck, { state: 'unavailable', targetUsdE8: '1', estimatedUsdE8: null,
        gasPriceWei: null, ethUsdE8: null, observedAt: null });
      assert.match(state.operation!.message!, /estimate is unavailable/);
      assert.doesNotMatch(stringifyJson(state), /PASSIVE_RPC_PAYLOAD|provider-fixture/);
      assert.doesNotMatch(await readFile(STATE_PATH, 'utf8'), /PASSIVE_RPC_PAYLOAD|provider-fixture/);
      assert.equal(ledger.active, false); assert.equal(state.ledgerRequest, null); assert.equal(state.cycle, null);
      assert.equal(await readJson(PENDING_PATH), null); assert.equal(await readJson(CYCLE_PATH), null);
      assert.equal(await readJson(LEDGER_REQUEST_PATH), null); assert.deepEqual(await events(), []);
    }
    assert.equal(preparation.mock.callCount(), 2); assert.equal(price.mock.callCount(), 0);
    assert.equal(readiness.mock.callCount(), 0); assert.equal(binding.mock.callCount(), 0);
    assert.equal(f.sent.length, 0);
  } finally { await release(); }
});


for (const boundary of ['snapshot', 'quote', 'transaction'] as const) {
  test(`live configuration edit during ${boundary} discards old work before creating a cycle`, async t => {
    const f = fixture();
    const next = { ...config, driftThresholdBps: 600, rebalanceIntervalSeconds: 7200,
      targets: { ...targets, USDG: 1000, AAPL: 1875 } };
    const original = f.chain[boundary].bind(f.chain) as (...args: unknown[]) => Promise<unknown>;
    t.mock.method(f.chain, boundary, async (...args: unknown[]) => {
      const value = await original(...args);
      await atomicWriteJson(CONFIG_PATH, next);
      return value;
    });
    t.mock.method(globalThis, 'fetch', async () => assert.fail('Stale preparation must not price or sign'));
    const release = await acquireLock(dataDir);
    try {
      const result = await tick(true, () => f.chain);
      assert.equal(result.error, null); assert.equal(result.operation?.status, 'configuration-changed');
      assert.equal(result.graph.node, 'wait'); assert.equal(result.proposal, undefined);
      assert.equal(await readJson(CYCLE_PATH), null); assert.equal(await readJson(PENDING_PATH), null);
      assert.equal(f.sent.length, 0); assert.deepEqual(await events(), []);
      assert.deepEqual((await status()).config?.targets, next.targets);
      assert.deepEqual(await readJson(CONFIG_PATH), next);
    } finally { await release(); }
  });
}

test('an obsolete balanced observation cannot close a successful active cycle or announce completion', async t => {
  const f = fixture();
  const now = Date.now();
  const cycle = { wallet, startedAt: now - 10_000, activeUntil: now + 590_000,
    nextEligibleAt: now + 3_590_000, swapConfirmed: true };
  await atomicWriteJson(CYCLE_PATH, cycle);
  await atomicWriteJson(join(dataDir, 'last-transaction.json'), { status: 'confirmed', kind: 'swap',
    hash: `0x${'a'.repeat(64)}`, wallet, chainId: 4663 });
  const next = { ...config, targets: { ...targets, USDG: 3000, AAPL: 0, NVDA: 2250 } };
  t.mock.method(f.chain, 'snapshot', async () => {
    const portfolio = evaluatePortfolio(Object.entries(targets).map(([id, targetBps]) => ({
      id, symbol: id, decimals: 6, balance: BigInt(targetBps) * 10_000n,
      priceUsdE8: 100_000_000n, targetBps,
    })));
    await atomicWriteJson(CONFIG_PATH, next);
    return { portfolio, nativeBalance: 0n, blockNumber: 100n, valuationNote: 'Offline old-target observation' };
  });
  const release = await acquireLock(dataDir);
  try {
    const result = await tick(true, () => f.chain);
    assert.equal(result.error, null); assert.equal(result.operation?.status, 'configuration-changed');
    assert.deepEqual(await readJson(CYCLE_PATH), cycle);
    assert.equal(await readJson(PENDING_PATH), null); assert.equal(f.sent.length, 0);
    assert.deepEqual(await events(), [], 'An old balanced snapshot cannot announce completion for newly edited targets');
  } finally { await release(); }
});

test('a fee target edited during pricing causes a quiet fresh traversal without a stale send', async t => {
  const generous = { ...config, rebalanceFeeTargetUsdE8: '200000000' };
  await atomicWriteJson(CONFIG_PATH, generous);
  const f = fixture();
  t.mock.method(globalThis, 'fetch', async () => {
    await atomicWriteJson(CONFIG_PATH, config);
    return new Response(JSON.stringify({ data: { base: 'ETH', currency: 'USD', amount: '100' } }));
  });
  const release = await acquireLock(dataDir);
  try {
    const result = await tick(true, () => f.chain);
    assert.equal(result.error, null); assert.equal(result.operation?.status, 'configuration-changed');
    assert.equal(result.graph.node, 'wait'); assert.equal(result.feeCheck, undefined);
    assert.equal(await readJson(PENDING_PATH), null); assert.equal(f.sent.length, 0);
    assert.deepEqual(await events(), []);
    assert.equal((await status()).config?.rebalanceFeeTargetUsdE8, '1');
  } finally { await release(); }
});
