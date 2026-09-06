import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ASSETS } from '../src/assets.js';
import { evaluatePortfolio } from '../src/core.js';
import { projectRebalanceFees } from '../src/fee-projection.js';
import type { Config } from '../src/config.js';
import type { Status } from '../src/runtime.js';

const now = Date.parse('2026-09-06T03:00:00.000Z');
const targets = { USDG: 500, AAPL: 2375, NVDA: 2375, MSFT: 2375, AMD: 2375 };
const wallet = '0x00000000000000000000000000000000000000aB';
function fixture(weights: Record<string, number> = targets) {
  const config: Config = { version: 1, chainId: 4663, wallet, mode: 'private-key',
    rpcUrl: 'https://fixture.invalid', targets: { ...targets }, driftThresholdBps: 500,
    slippageBps: 50, deadlineSeconds: 120, pollSeconds: 5, rebalanceIntervalSeconds: 3600 };
  // $10,000 total and differing stock prices exercise token precision/conversion.
  const prices = { USDG: 1n, AAPL: 25n, NVDA: 5n, MSFT: 125n, AMD: 19n };
  const snapshot: Status = { app: 'Rebalance', chain: { id: 4663, name: 'Robinhood' }, mode: config.mode,
    wallet: wallet.toLowerCase(), config: { targets: { ...targets }, rebalanceIntervalSeconds: 3600 },
    cycle: null, operation: null, updatedAt: new Date(now).toISOString(), error: null,
    graph: { node: 'wait', trace: ['config', 'observe', 'plan', 'wait'] }, armed: true,
    portfolio: evaluatePortfolio(Object.keys(targets).map(id => {
      const asset = ASSETS[id as keyof typeof ASSETS];
      const price = prices[id as keyof typeof prices];
      return { ...asset, balance: BigInt(weights[id] ?? 0) * 10n ** BigInt(asset.decimals) / price,
        priceUsdE8: price * 100_000_000n, targetBps: targets[id as keyof typeof targets] };
    })) };
  return { config, snapshot };
}
const jsonStatus = (snapshot: Status): Status => JSON.parse(JSON.stringify(snapshot,
  (_key, value) => typeof value === 'bigint' ? value.toString() : value));

test('on-target holdings need zero swaps and retain the exact observation identity without mutation', () => {
  const { config, snapshot } = fixture();
  const before = structuredClone({ config, snapshot });
  const result = projectRebalanceFees(snapshot, config, now);
  assert.ok(result);
  assert.equal(result.swaps, 0);
  assert.equal(result.observedAt, snapshot.updatedAt);
  assert.equal(result.wallet, config.wallet);
  assert.deepEqual(result.targets, targets);
  assert.deepEqual(result.balances, Object.fromEntries(snapshot.portfolio!.positions.map(p => [p.id, p.balance.toString()])));
  assert.deepEqual({ config, snapshot }, before);
  result.targets.USDG = 10_000;
  result.balances.USDG = '0';
  assert.deepEqual({ config, snapshot }, before, 'returned identity objects are independent copies');
});

test('a cash-only portfolio projects four buys with mixed decimals and preserves its starting balances', () => {
  const { config, snapshot } = fixture({ USDG: 10_000 });
  const before = structuredClone(snapshot);
  assert.equal(projectRebalanceFees(snapshot, config, now)?.swaps, 4);
  const result = projectRebalanceFees(jsonStatus(snapshot), config, now);
  assert.equal(result?.swaps, 4);
  assert.equal(result?.balances.USDG, '10000000000');
  assert.equal(result?.balances.AAPL, '0');
  assert.deepEqual(snapshot, before);
});

test('a stock-only portfolio rotates through USDG before buying the other three stocks', () => {
  const { config, snapshot } = fixture({ AAPL: 10_000 });
  assert.equal(projectRebalanceFees(snapshot, config, now)?.swaps, 4);
  snapshot.portfolio!.positions.reverse();
  assert.equal(projectRebalanceFees(snapshot, config, now)?.swaps, 4, 'input order does not affect core planning');
});

test('uses the saved threshold exactly instead of rounded drift fields or the default threshold', () => {
  const { config, snapshot } = fixture({ USDG: 500, AAPL: 2500, NVDA: 2250, MSFT: 2375, AMD: 2375 });
  config.driftThresholdBps = 125;
  assert.equal(projectRebalanceFees(snapshot, config, now)?.swaps, 0, 'exact threshold is not exceeded');
  config.driftThresholdBps = 124;
  for (const position of snapshot.portfolio!.positions) { position.weightBps = 0; position.driftBps = 0; position.valueUsdE8 = 0n; }
  snapshot.portfolio!.totalUsdE8 = 0n;
  assert.equal(projectRebalanceFees(snapshot, config, now)?.swaps, 2, 'recompute values from integer balances and prices');
});

test('freshness is inclusive at ninety seconds and rejects stale, future or missing observations', () => {
  const { config, snapshot } = fixture();
  assert.equal(projectRebalanceFees(snapshot, config, now + 90_000)?.swaps, 0);
  assert.equal(projectRebalanceFees(snapshot, config, now + 90_001), null);
  assert.equal(projectRebalanceFees(snapshot, config, now - 1), null);
  assert.equal(projectRebalanceFees(snapshot, config, Number.NaN), null);
  for (const updatedAt of [null, 'invalid']) assert.equal(projectRebalanceFees({ ...snapshot, updatedAt }, config, now), null);
});

test('active transactions, recovery, errors and unknown operation states have no projection', () => {
  const { config, snapshot } = fixture();
  for (const status of ['pending', 'unresolved', 'reverted', 'confirming', 'recovery-wait', 'recovery-busy', 'unknown', 'prepared', 'broadcast']) {
    assert.equal(projectRebalanceFees({ ...snapshot, operation: { status } }, config, now), null, status);
  }
  for (const node of ['reconcile', 'recover', 'execute', 'receipt', 'error'] as const) {
    assert.equal(projectRebalanceFees({ ...snapshot, graph: { node, trace: [] } }, config, now), null, node);
  }
  assert.equal(projectRebalanceFees({ ...snapshot, error: 'Observation failed' }, config, now), null);
  assert.equal(projectRebalanceFees({ ...snapshot, operation: { status: 'confirmed', sendFailure: 'unknown' } }, config, now), null);
  for (const node of ['config', 'observe', 'wait'] as const) {
    assert.equal(projectRebalanceFees({ ...snapshot, graph: { node, trace: [] } }, config, now)?.swaps, 0, 'fresh cached holdings remain usable');
  }
});

test('confirmed recovery and normal waiting states can project after a fresh observation', () => {
  const { config, snapshot } = fixture();
  for (const status of ['confirmed', 'cancelled', 'recovered-revert', 'needs-rebalance', 'cooling-down', 'waiting-ledger']) {
    assert.equal(projectRebalanceFees({ ...snapshot, operation: { status } }, config, now)?.swaps, 0, status);
  }
});

test('wallet, network, signer and exact configured targets must match the observation', () => {
  const { config, snapshot } = fixture();
  assert.equal(projectRebalanceFees(snapshot, null, now), null);
  assert.equal(projectRebalanceFees({ ...snapshot, wallet: '0x0000000000000000000000000000000000000002' }, config, now), null);
  assert.equal(projectRebalanceFees(snapshot, { ...config, chainId: 1 as 4663 }, now), null);
  assert.equal(projectRebalanceFees({ ...snapshot, chain: { id: 1 as 4663, name: 'Robinhood' } }, config, now), null);
  assert.equal(projectRebalanceFees({ ...snapshot, mode: 'ledger' }, config, now), null);
  assert.equal(projectRebalanceFees({ ...snapshot, operation: { status: 'confirmed', wallet: '0x0000000000000000000000000000000000000002' } }, config, now), null);
  assert.equal(projectRebalanceFees(snapshot, { ...config, targets: { ...targets, USDG: 600, AAPL: 2275 } }, now), null);
  assert.equal(projectRebalanceFees({ ...snapshot, config: { ...snapshot.config!, targets: { ...targets, X: 0 } } }, config, now), null);
  for (const driftThresholdBps of [-1, 10_001, 1.5, Number.NaN]) {
    assert.equal(projectRebalanceFees(snapshot, { ...config, driftThresholdBps }, now), null);
  }
});

test('invalid position data, unfunded balances and nonconverging dust stay unavailable', () => {
  const { config, snapshot } = fixture();
  assert.equal(projectRebalanceFees({ ...snapshot, portfolio: null }, config, now), null);
  assert.equal(projectRebalanceFees(fixture({}).snapshot, config, now), null);
  const mutate = (patch: Record<string, unknown>) => {
    const bad = jsonStatus(snapshot);
    Object.assign(bad.portfolio!.positions[0]!, patch);
    return projectRebalanceFees(bad, config, now);
  };
  for (const balance of [-1n, '-1', '1e3', '01', 100, '1'.repeat(79), (1n << 256n).toString()]) assert.equal(mutate({ balance }), null);
  for (const patch of [
    { priceUsdE8: '0' }, { priceUsdE8: '-1' }, { decimals: 18 }, { symbol: 'OTHER' },
    { targetBps: 501 }, { id: 'missing' },
  ]) assert.equal(mutate(patch), null);
  const duplicate = structuredClone(snapshot);
  duplicate.portfolio!.positions[0] = { ...duplicate.portfolio!.positions[1]! };
  assert.equal(projectRebalanceFees(duplicate, config, now), null);
  const dust = fixture({ USDG: 1 });
  dust.config.driftThresholdBps = 0;
  dust.snapshot.portfolio!.positions.find(position => position.id === 'USDG')!.balance = 1n;
  // One USDG base unit cannot be split across all exact targets.
  assert.equal(projectRebalanceFees(dust.snapshot, dust.config, now), null);
});
