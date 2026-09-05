import assert from "node:assert/strict";
import { test } from "node:test";
import {
  evaluatePortfolio,
  planTrade,
  redistributeTargets,
  type AssetPosition,
} from "../src/core.js";

const USD = 100_000_000n;
const ETHER = 10n ** 18n;
const USDC = 10n ** 6n;

function asset(id: string, overrides: Partial<AssetPosition> = {}): AssetPosition {
  return { id, symbol: id.toUpperCase(), decimals: 0, balance: 0n, priceUsdE8: USD, targetBps: 0, ...overrides };
}

test("values different token decimals exactly without changing input", () => {
  const input = [
    asset("eth", { decimals: 18, balance: 2n * ETHER, priceUsdE8: 2_000n * USD, targetBps: 8_000 }),
    asset("usdc", { decimals: 6, balance: 1_000n * USDC, targetBps: 2_000 }),
  ];
  const before = structuredClone(input);
  const portfolio = evaluatePortfolio(input);
  assert.equal(portfolio.totalUsdE8, 5_000n * USD);
  assert.deepEqual(portfolio.positions.map(({ valueUsdE8, weightBps, driftBps }) => ({ valueUsdE8, weightBps, driftBps })), [
    { valueUsdE8: 4_000n * USD, weightBps: 8_000, driftBps: 0 },
    { valueUsdE8: 1_000n * USD, weightBps: 2_000, driftBps: 0 },
  ]);
  assert.deepEqual(input, before);
});

test("weight remainders conserve 10000 bps and break ties by ID, not input order", () => {
  const portfolio = evaluatePortfolio([
    asset("c", { balance: 1n, targetBps: 3_333 }),
    asset("b", { balance: 1n, targetBps: 3_333 }),
    asset("a", { balance: 1n, targetBps: 3_334 }),
  ]);
  assert.deepEqual(portfolio.positions.map(({ id, weightBps }) => [id, weightBps]), [["c", 3_333], ["b", 3_333], ["a", 3_334]]);
  assert.equal(portfolio.positions.reduce((sum, position) => sum + position.weightBps, 0), 10_000);
});

test("USD dust rounds down and balances above Number precision remain exact", () => {
  const huge = 2n ** 100n + 1n;
  const portfolio = evaluatePortfolio([
    asset("huge", { balance: huge, priceUsdE8: 7n, targetBps: 10_000 }),
    asset("dust", { balance: 9n, decimals: 18, priceUsdE8: 1n }),
  ]);
  assert.equal(portfolio.totalUsdE8, huge * 7n);
  assert.equal(portfolio.positions[1]!.valueUsdE8, 0n);
  assert.equal(portfolio.positions[0]!.balance, huge);
  assert.equal(evaluatePortfolio([asset("max", { decimals: 255, balance: 10n ** 255n, targetBps: 10_000 })]).totalUsdE8, USD);
});

test("empty, zero-balance and sub-USD-precision portfolios produce no trade", () => {
  const empty = evaluatePortfolio([]);
  assert.deepEqual(empty, { totalUsdE8: 0n, positions: [] });
  assert.equal(planTrade(empty, "usd", 0), null);
  for (const balance of [0n, 1n]) {
    const portfolio = evaluatePortfolio([
      asset("eth", { balance, decimals: 18, targetBps: 5_000 }),
      asset("usd", { targetBps: 5_000 }),
    ]);
    assert.equal(portfolio.totalUsdE8, 0n);
    assert.ok(portfolio.positions.every(({ weightBps }) => weightBps === 0));
    assert.equal(planTrade(portfolio, "usd", 0), null);
  }
});

test("rejects invalid asset data and incomplete or duplicate allocations", () => {
  for (const patch of [
    { decimals: -1 }, { decimals: 256 }, { decimals: 1.5 }, { decimals: Number.NaN },
    { balance: -1n }, { balance: 1 as unknown as bigint },
    { priceUsdE8: 0n }, { priceUsdE8: -1n }, { priceUsdE8: 1 as unknown as bigint },
    { targetBps: -1 }, { targetBps: 10_001 }, { targetBps: 9_999.5 }, { targetBps: Number.NaN },
    { id: "" }, { id: " eth" }, { symbol: "" },
  ]) {
    assert.throws(() => evaluatePortfolio([asset("eth", { targetBps: 10_000, ...patch })]));
  }
  assert.throws(() => evaluatePortfolio([asset("eth", { targetBps: 9_999 })]), /total 10000/);
  assert.throws(() => evaluatePortfolio([asset("eth", { targetBps: 5_000 }), asset("eth", { targetBps: 5_000 })]), /Duplicate/);
});

test("20% to 30% proportionally redistributes and preserves the input", () => {
  const original = { eth: 2_000, stock: 4_000, usd: 4_000 };
  assert.deepEqual(redistributeTargets(original, "eth", 3_000), { eth: 3_000, stock: 3_500, usd: 3_500 });
  assert.deepEqual(original, { eth: 2_000, stock: 4_000, usd: 4_000 });
});

test("redistribution uses largest remainders and deterministic ID ties", () => {
  assert.deepEqual(redistributeTargets({ z: 2_500, b: 2_500, a: 2_500, c: 2_500 }, "z", 0), {
    a: 3_334, b: 3_333, c: 3_333, z: 0,
  });
  assert.deepEqual(redistributeTargets({ eth: 3_333, a: 3_333, b: 3_334 }, "eth", 3_334), {
    a: 3_333, b: 3_333, eth: 3_334,
  });
});

test("redistribution handles 100% explicitly and does not invent weights from zero", () => {
  assert.deepEqual(redistributeTargets({ eth: 2_000, usd: 8_000 }, "eth", 10_000), { eth: 10_000, usd: 0 });
  assert.deepEqual(redistributeTargets({ eth: 10_000, usd: 0 }, "eth", 10_000), { eth: 10_000, usd: 0 });
  assert.deepEqual(redistributeTargets({ eth: 10_000 }, "eth", 10_000), { eth: 10_000 });
  assert.throws(() => redistributeTargets({ eth: 10_000, usd: 0 }, "eth", 3_000), /specify complete targets/);
  assert.throws(() => redistributeTargets({ eth: 10_000 }, "eth", 0), /specify complete targets/);
  assert.throws(() => redistributeTargets({ eth: 10_000 }, "missing", 3_000), /Unknown asset/);
  assert.throws(() => redistributeTargets({ eth: 9_999 }, "eth", 3_000), /total 10000/);
  assert.throws(() => redistributeTargets({ eth: 10_000 }, "eth", 0.5), /integer/);
});

test("many target edits conserve all basis points without negative allocations", () => {
  for (const target of [0, 1, 333, 3_333, 3_334, 5_001, 9_999, 10_000]) {
    const result = redistributeTargets({ a: 2_731, b: 4_127, c: 3_142 }, "b", target);
    assert.equal(result.b, target);
    assert.equal(Object.values(result).reduce((sum, value) => sum + value, 0), 10_000);
    assert.ok(Object.values(result).every((value) => Number.isInteger(value) && value >= 0));
    assert.deepEqual(result, redistributeTargets({ c: 3_142, b: 4_127, a: 2_731 }, "b", target));
  }
});

test("threshold must be exceeded; an exact threshold and a balanced portfolio do nothing", () => {
  const portfolio = evaluatePortfolio([
    asset("eth", { decimals: 18, balance: 3n * ETHER, priceUsdE8: 2_000n * USD, targetBps: 5_000 }),
    asset("usd", { decimals: 6, balance: 4_000n * USDC, targetBps: 5_000 }),
  ]);
  assert.equal(planTrade(portfolio, "usd", 1_000), null);
  assert.deepEqual(planTrade(portfolio, "usd", 999), {
    sellAssetId: "eth", buyAssetId: "usd", amountIn: ETHER / 2n, reason: "Sell overweight ETH into USD",
  });
  assert.equal(planTrade(evaluatePortfolio([asset("usd", { balance: 1n, targetBps: 10_000 })]), "usd", 0), null);
});

test("threshold comparison does not mistake rounded display weights for exact drift", () => {
  const portfolio = evaluatePortfolio([
    asset("eth", { balance: 5_100_001n, targetBps: 5_000 }),
    asset("usd", { balance: 4_899_999n, targetBps: 5_000 }),
  ]);
  assert.equal(portfolio.positions[0]!.driftBps, 100);
  assert.equal(planTrade(portfolio, "usd", 100)!.amountIn, 100_001n);
});

test("sells non-quote surplus before buying deficits and resolves equal deviations by ID", () => {
  const portfolio = evaluatePortfolio([
    asset("b", { balance: 40n, targetBps: 3_000 }),
    asset("usd", { balance: 20n, targetBps: 4_000 }),
    asset("a", { balance: 40n, targetBps: 3_000 }),
  ]);
  assert.deepEqual(planTrade(portfolio, "usd", 1_500), {
    sellAssetId: "a", buyAssetId: "usd", amountIn: 10n, reason: "Sell overweight A into USD",
  });
  const reversed = evaluatePortfolio([...portfolio.positions].reverse());
  assert.deepEqual(planTrade(reversed, "usd", 1_500), planTrade(portfolio, "usd", 1_500));
});

test("buys the largest deficit with quote surplus while retaining the quote target", () => {
  const portfolio = evaluatePortfolio([
    asset("eth", { decimals: 18, balance: ETHER, priceUsdE8: 2_000n * USD, targetBps: 5_000 }),
    asset("usd", { decimals: 6, balance: 8_000n * USDC, targetBps: 5_000 }),
  ]);
  const trade = planTrade(portfolio, "usd", 100)!;
  assert.deepEqual(trade, {
    sellAssetId: "usd", buyAssetId: "eth", amountIn: 3_000n * USDC, reason: "Buy underweight ETH with excess USD",
  });
  assert.equal(portfolio.positions[1]!.balance - trade.amountIn, 5_000n * USDC);
});

test("quote amounts use the quote asset's own price and decimals", () => {
  const portfolio = evaluatePortfolio([
    asset("stock", { targetBps: 5_000 }),
    asset("quote", { decimals: 1, balance: 100n, priceUsdE8: 2n * USD, targetBps: 5_000 }),
  ]);
  assert.deepEqual(planTrade(portfolio, "quote", 0), {
    sellAssetId: "quote", buyAssetId: "stock", amountIn: 50n, reason: "Buy underweight STOCK with excess QUOTE",
  });
});

test("skips dust trades whose estimated output is less than one base unit", () => {
  const dustSale = evaluatePortfolio([
    asset("dust", { decimals: 8, balance: 1n }),
    asset("usd", { decimals: 6, balance: USDC, targetBps: 10_000 }),
  ]);
  assert.equal(planTrade(dustSale, "usd", 0), null);
  const indivisiblePurchase = evaluatePortfolio([
    asset("stock", { priceUsdE8: 100n * USD, targetBps: 5_000 }),
    asset("usd", { decimals: 6, balance: 10n * USDC, targetBps: 5_000 }),
  ]);
  assert.equal(planTrade(indivisiblePurchase, "usd", 0), null);
});

test("amounts round down to base units and never spend an asset's full target reserve", () => {
  const portfolio = evaluatePortfolio([
    asset("a", { balance: 2n, priceUsdE8: 3n * USD, targetBps: 5_000 }),
    asset("usd", { balance: 2n, targetBps: 5_000 }),
  ]);
  // The desired sale is $2, less than one indivisible $3 token.
  assert.equal(planTrade(portfolio, "usd", 0), null);
  const precise = evaluatePortfolio([
    asset("a", { decimals: 2, balance: 200n, priceUsdE8: 3n * USD, targetBps: 5_000 }),
    asset("usd", { balance: 2n, targetBps: 5_000 }),
  ]);
  assert.equal(planTrade(precise, "usd", 0)!.amountIn, 66n);
});

test("skips an indivisible overweight asset when another corrective sale is possible", () => {
  const portfolio = evaluatePortfolio([
    asset("large", { balance: 1n, priceUsdE8: 100n * USD, targetBps: 7_000 }),
    asset("small", { balance: 10n, targetBps: 500 }),
    asset("usd", { targetBps: 2_500 }),
  ]);
  assert.deepEqual(planTrade(portfolio, "usd", 100), {
    sellAssetId: "small", buyAssetId: "usd", amountIn: 4n, reason: "Sell overweight SMALL into USD",
  });
});

test("planning rejects invalid thresholds and unknown quote assets", () => {
  const portfolio = evaluatePortfolio([asset("usd", { targetBps: 10_000 })]);
  for (const threshold of [-1, 10_001, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => planTrade(portfolio, "usd", threshold), /Drift threshold/);
  }
  assert.throws(() => planTrade(portfolio, "other", 0), /Unknown quote/);
});
