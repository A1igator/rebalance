import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluatePortfolio, planRebalance, planAtomicRebalance, planTrade, type Portfolio } from '../src/core.js';

const ids = ['USDG', 'AAPL', 'NVDA', 'MSFT', 'AMD'];
const USD = 100_000_000n;
function portfolio(values: bigint[], targets = [2000, 2000, 2000, 2000, 2000]): Portfolio {
  return evaluatePortfolio(ids.map((id, index) => ({ id, symbol: id, decimals: id === 'USDG' ? 6 : 18,
    balance: values[index]! * 10n ** BigInt(id === 'USDG' ? 6 : 18), priceUsdE8: USD, targetBps: targets[index]! })));
}

test('cash-funded portfolio plans all four buys and preserves the quote allocation', () => {
  const input = portfolio([5n, 0n, 0n, 0n, 0n], [500, 2375, 2375, 2375, 2375]);
  const original = structuredClone(input);
  const plan = planRebalance(input, 'USDG', 500)!;
  assert.equal(plan.trades.length, 4);
  assert.deepEqual(plan.trades.map(t => t.buyAssetId), ['AAPL', 'AMD', 'MSFT', 'NVDA']);
  assert(plan.trades.every(t => t.sellAssetId === 'USDG' && t.amountIn === 1_187_500n));
  assert.equal(plan.trades.reduce((sum, t) => sum + t.amountIn, 0n), 4_750_000n);
  assert.deepEqual(input, original);
  assert.equal(planTrade(input, 'USDG', 500)?.amountIn, 1_187_500n, 'legacy single-leg API stays available');
  assert.deepEqual(planRebalance({ ...input, positions: [...input.positions].reverse() }, 'USDG', 500), plan);
});

test('mixed portfolios sell all overweight stocks before spending newly observed proceeds', () => {
  const input = portfolio([10n, 40n, 30n, 20n, 0n]);
  const sells = planRebalance(input, 'USDG', 500)!;
  assert.deepEqual(sells.trades.map(t => [t.sellAssetId, t.buyAssetId, t.amountIn]), [
    ['AAPL', 'USDG', 20n * 10n ** 18n], ['NVDA', 'USDG', 10n * 10n ** 18n],
  ]);
  assert(sells.trades.every(t => t.buyAssetId === 'USDG'), 'cash shortfall cannot be funded by projected sales');
  const observedAfterSales = portfolio([40n, 20n, 20n, 20n, 0n]);
  const buys = planRebalance(observedAfterSales, 'USDG', 500)!;
  assert.deepEqual(buys.trades.map(t => [t.sellAssetId, t.buyAssetId, t.amountIn]), [['USDG', 'AMD', 20_000_000n]]);
  assert.equal(planRebalance(portfolio([20n, 20n, 20n, 20n, 20n]), 'USDG', 500), null);
});

test('buy apportionment conserves atomic cash units with deterministic ties', () => {
  const input = portfolio([0n, 0n, 0n, 0n, 0n], [0, 2500, 2500, 2500, 2500]);
  input.positions[0]!.balance = 1_000_001n;
  const result = planRebalance(input, 'USDG', 0)!;
  assert.equal(result.trades.reduce((sum, t) => sum + t.amountIn, 0n), 1_000_001n);
  assert.deepEqual(result.trades.map(t => t.amountIn), [250_001n, 250_000n, 250_000n, 250_000n]);
  assert.equal(result.trades[0]!.buyAssetId, 'AAPL');
});

test('rational threshold and current balances determine whether a batch is needed', () => {
  const boundary = portfolio([25n, 20n, 20n, 20n, 15n]);
  assert.equal(planRebalance(boundary, 'USDG', 500), null);
  const changed = structuredClone(boundary);
  changed.positions[0]!.balance += 1n;
  assert(planRebalance(changed, 'USDG', 500), 'stale display weights must not suppress a real threshold crossing');
  assert.equal(planRebalance(portfolio([0n, 0n, 0n, 0n, 0n]), 'USDG', 500), null);
  assert.equal(planRebalance(evaluatePortfolio([]), 'USDG', 500), null);
  assert.throws(() => planRebalance(boundary, 'UNKNOWN', 500), /Unknown quote asset/);
  assert.throws(() => planRebalance(boundary, 'USDG', -1), /Drift threshold/);
});

test('rounded-zero legs are omitted and neither phase exceeds held input balances', () => {
  const tiny = evaluatePortfolio([
    { id: 'USDG', symbol: 'USDG', decimals: 0, balance: 1n, priceUsdE8: USD, targetBps: 0 },
    { id: 'HIGH', symbol: 'HIGH', decimals: 0, balance: 0n, priceUsdE8: 2n * USD, targetBps: 10000 },
  ]);
  assert.equal(planRebalance(tiny, 'USDG', 0), null, 'zero estimated output cannot create a trade');
  const large = portfolio([1n, 99n, 0n, 0n, 0n]);
  const plan = planRebalance(large, 'USDG', 500)!;
  for (const leg of plan.trades) {
    assert(leg.amountIn > 0n);
    assert(leg.amountIn <= large.positions.find(p => p.id === leg.sellAssetId)!.balance);
  }
});


test('fresh lower sale proceeds fund buys without repeating tolerated residual stock sales', () => {
  const initial = portfolio([10n, 40n, 30n, 20n, 0n]);
  assert.deepEqual(planRebalance(initial, 'USDG', 500)!.trades.map(t => t.sellAssetId), ['AAPL', 'NVDA']);
  // Sales reduced the sold holdings to20 each, but realized29USDG rather than30.
  // The lower total leaves those stocks slightly above their recomputed19.8 targets.
  const observed = portfolio([39n, 20n, 20n, 20n, 0n]);
  const original = structuredClone(observed);
  const buys = planRebalance(observed, 'USDG', 500)!;
  assert.deepEqual(buys.trades.map(t => [t.sellAssetId, t.buyAssetId, t.amountIn]), [['USDG', 'AMD', 19_200_000n]]);
  assert.deepEqual(observed, original, 'planning uses but never mutates the actual observation');
  const settled = structuredClone(observed);
  settled.positions[0]!.balance -= buys.trades[0]!.amountIn;
  settled.positions[4]!.balance += 19_200_000_000_000_000_000n;
  assert.equal(planRebalance(settled, 'USDG', 500), null, 'tolerated residuals do not force a correction cycle');
});

test('stock residuals outside the drift band still take sales priority despite cash surplus', () => {
  const input = portfolio([39n, 26n, 20n, 15n, 0n]);
  const result = planRebalance(input, 'USDG', 500)!;
  assert.deepEqual(result.trades.map(t => [t.sellAssetId, t.buyAssetId, t.amountIn]), [['AAPL', 'USDG', 6n * 10n ** 18n]]);
  const boundary = portfolio([40n, 25n, 20n, 15n, 0n]);
  assert(planRebalance(boundary, 'USDG', 500)!.trades.every(t => t.sellAssetId === 'USDG'), 'exactly at the band remains tolerated');
});

test('without quote surplus tolerated overweight stocks remain available to fund deficits', () => {
  for (const values of [[19n, 23n, 23n, 23n, 12n], [20n, 22n, 22n, 22n, 14n]]) {
    const result = planRebalance(portfolio(values), 'USDG', 500)!;
    assert.equal(result.trades.length, 3);
    assert(result.trades.every(t => t.buyAssetId === 'USDG' && t.sellAssetId !== 'USDG'));
  }
});

test('zero drift threshold still sells every positive residual instead of enlarging the band', () => {
  const observed = portfolio([39n, 20n, 20n, 20n, 0n]);
  const result = planRebalance(observed, 'USDG', 0)!;
  assert.equal(result.trades.length, 3);
  assert(result.trades.every(t => t.buyAssetId === 'USDG' && t.amountIn === 200_000_000_000_000_000n));
});


test('atomic rebalancing spends enforced minimum sale proceeds and keeps the rounded target reserve', () => {
  const input = portfolio([20n, 40n, 40n, 0n, 0n]);
  const before = structuredClone(input);
  const plan = planAtomicRebalance(input, 'USDG', 500, [19_900_000n, 19_900_000n])!;
  assert.deepEqual(plan.trades.map(t => [t.sellAssetId, t.buyAssetId, t.amountIn]), [
    ['AAPL', 'USDG', 20n * 10n ** 18n], ['NVDA', 'USDG', 20n * 10n ** 18n],
    ['USDG', 'AMD', 19_920_000n], ['USDG', 'MSFT', 19_920_000n],
  ]);
  const spent = plan.trades.filter(t => t.sellAssetId === 'USDG').reduce((sum, t) => sum + t.amountIn, 0n);
  assert.equal(20_000_000n + 39_800_000n - spent, 19_960_000n);
  assert.deepEqual(input, before, 'guaranteed holdings must not replace the real portfolio');
  const lower = planAtomicRebalance(input, 'USDG', 500, [19_000_000n, 19_000_000n])!;
  assert.equal(lower.trades.filter(t => t.sellAssetId === 'USDG').reduce((sum, t) => sum + t.amountIn, 0n), 38_400_000n);
});

test('atomic purchases can use earlier sale minimums even with zero starting cash', () => {
  const plan = planAtomicRebalance(portfolio([0n, 60n, 40n, 0n, 0n]), 'USDG', 500, [39_800_000n, 19_900_000n])!;
  assert.equal(plan.trades.length, 4);
  assert(plan.trades.slice(0, 2).every(t => t.buyAssetId === 'USDG'));
  assert.equal(plan.trades.slice(2).reduce((sum, t) => sum + t.amountIn, 0n), 39_760_000n);
});

test('atomic funding omits purchases when minimum proceeds cannot cover the target reserve', () => {
  const plan = planAtomicRebalance(portfolio([0n, 100n, 0n, 0n, 0n]), 'USDG', 500, [1_000_000n])!;
  assert.equal(plan.trades.length, 1);
  assert.equal(plan.trades[0]!.buyAssetId, 'USDG');
  assert.equal(plan.trades[0]!.amountIn, 80n * 10n ** 18n);
});

test('minimum output input is bound to deterministic sales and each stock is touched at most once', () => {
  const input = portfolio([20n, 40n, 40n, 0n, 0n]);
  for (const outputs of [[], [1n], [1n, 1n, 1n], [0n, 1n], [-1n, 1n], [(1n << 256n), 1n], [(1n << 256n) - 1n, 1n]]) {
    assert.throws(() => planAtomicRebalance(input, 'USDG', 500, outputs));
  }
  const improved = planAtomicRebalance(input, 'USDG', 500, [30_000_000n, 30_000_000n])!;
  const stocks = improved.trades.map(t => t.sellAssetId === 'USDG' ? t.buyAssetId : t.sellAssetId);
  assert.equal(new Set(stocks).size, stocks.length, 'an improved quote cannot cause an already sold stock to be repurchased');
  const cash = portfolio([5n, 0n, 0n, 0n, 0n]);
  assert.deepEqual(planAtomicRebalance(cash, 'USDG', 500), planRebalance(cash, 'USDG', 500));
  assert.throws(() => planAtomicRebalance(cash, 'USDG', 500, [1n]), /must match/);
});

test('atomic target reserve rounds upward instead of spending a fractional base unit', () => {
  const input = portfolio([20n, 40n, 40n, 0n, 0n]);
  const plan = planAtomicRebalance(input, 'USDG', 500, [19_900_001n, 19_900_001n])!;
  const budget = plan.trades.filter(t => t.sellAssetId === 'USDG').reduce((sum, t) => sum + t.amountIn, 0n);
  assert.equal(59_800_002n - budget, 19_960_001n);
});
