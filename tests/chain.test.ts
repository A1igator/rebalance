import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  decodeFunctionData,
  encodeAbiParameters,
  getAddress,
  maxUint256,
  parseAbi,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { ASSETS, QUOTER, ROBINHOOD, ROUTER, createChain, type ChainConfig } from "../src/chain.js";
import type { TradePlan } from "../src/core.js";

// Local protocol fixtures only: no mainnet requests, wallets, or bytecode copies.
// These addresses and the seven-field SwapRouter02 layout are documented in
// docs/ROUTE_CHECK.md and the official interface URLs in src/chain.ts.
const ROUTER_WETH: Address = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const TSLA: Address = "0x322F0929c4625eD5bAd873c95208D54E1c003b2d";
const USDG: Address = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const FACTORY: Address = "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA";
const POOLS: Record<string, Record<number, Address>> = {
  TSLA: { 100: "0x7868622ff2c3b1b6c8acb15fe0bdaebf043dda48", 500: "0xc4f0172d6ac8dd294dd1137d047d5e1893760236", 3000: "0xf4acdaeeb7022862a763c9b1b885e11191c889e3", 10000: "0xb349fb08c2712f3a70bad40a4d006b68d67e888b" },
  AAPL: { 500: "0xaae0d815ee56e4092a5e5c2911e676fea50b2d6d", 3000: "0x783c9bbb765047cfdd2b84b92b2ca9f11d34b7ed", 10000: "0x3714aa8105de1f384481b425788af413748c1837" },
  NVDA: { 100: "0xb75d2d02b0ec3de50d32e40a4f1a8dae8acc4333", 500: "0xd4eb21209c4d6093f80b5b84f5c45cc093ea14a3", 3000: "0xb944cec30bd4175855215d767adc81f39e5f7e2b", 10000: "0xc277560df3689a401ba7dedd7626168b234ceb5e" },
  AMZN: { 100: "0x7b242dfa849419242e3733308d5c91fe2a7dae7e", 3000: "0x8ac92da74ab5f3b1d024dc1943ad7e15dc4179ef", 10000: "0x25967b7ca2d06aa46e47e188231ca78c87ef1fd7" },
};
const ZERO: Address = "0x0000000000000000000000000000000000000000";
const WALLET: Address = "0x0000000000000000000000000000000000000001";
const ETHER = 10n ** 18n;
const USD = 100_000_000n;
const SAMPLE = 10n ** 16n;
const RPC_ABI = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function factory() view returns (address)",
  "function oraclePaused() view returns (bool)",
  "function uiMultiplier() view returns (uint256)",
  "function WETH9() view returns (address)",
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)",
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256, uint160, uint32, uint256)",
]);
const TRANSACTION_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function multicall(uint256 deadline, bytes[] data) payable returns (bytes[])",
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256)",
]);

type RpcRequest = { id: number; method: string; params: unknown[] };

function fixture(t: TestContext) {
  const state = {
    now: 1_788_570_000n,
    timestamp: 1_788_570_000n,
    blockNumber: 100n,
    chainId: 4663,
    pending: false,
    omitTimestamp: false,
    allowance: 0n,
    native: ETHER,
    balances: { USDG: 5_000n * 10n ** 6n, TSLA: 2n * ETHER, AAPL: 2n * ETHER, NVDA: 2n * ETHER, AMZN: 2n * ETHER } as Record<string, bigint>,
    decimals: { USDG: 6, TSLA: 18, AAPL: 18, NVDA: 18, AMZN: 18 } as Record<string, number>,
    symbols: { USDG: "USDG", TSLA: "TSLA", AAPL: "AAPL", NVDA: "NVDA", AMZN: "AMZN" } as Record<string, string>,
    paused: new Set<string>(),
    multipliers: { TSLA: ETHER, AAPL: 2n * ETHER, NVDA: ETHER, AMZN: ETHER } as Record<string, bigint>,
    factory: FACTORY,
    poolOverride: undefined as Address | undefined,
    emptyCode: undefined as Address | undefined,
    forward: { 100: 2_000_000n, 500: 1_999_000n, 3000: 1_980_000n, 10000: 1_900_000n } as Record<number, bigint>,
    reverse: { 100: 5n * 10n ** 15n, 500: 4_999n * 10n ** 12n, 3000: 4_980n * 10n ** 12n, 10000: 4_900n * 10n ** 12n } as Record<number, bigint>,
    advanceAfterQuote: 0n,
    requests: [] as RpcRequest[],
  };
  const uint = (value: bigint | number) => encodeAbiParameters([{ type: "uint256" }], [BigInt(value)]);
  const address = (value: Address) => encodeAbiParameters([{ type: "address" }], [value]);
  const canonical = new Set([...Object.values(ASSETS).map(a => a.address), FACTORY, QUOTER, ROUTER, ...Object.values(POOLS).flatMap(p => Object.values(p))].map((a) => a.toLowerCase()));
  t.mock.method(Date, "now", () => Number(state.now) * 1_000);
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, options?: RequestInit) => {
    assert.equal(String(input), "http://chain-fixture.invalid/");
    assert.equal(new Headers(options?.headers).get("User-Agent"), "rebalance-read-only-route-check/0.1");
    assert.equal(typeof options?.body, "string");
    const request: RpcRequest = JSON.parse(options!.body as string);
    assert.equal(Array.isArray(request), false, "RPC batching must stay disabled");
    state.requests.push(request);
    const { id, method, params } = request;
    let result: unknown;
    if (method === "eth_chainId") result = toHex(state.chainId);
    else if (method === "eth_getBlockByNumber") {
      assert.deepEqual(params, ["latest", false]);
      result = {
        number: state.pending ? null : toHex(state.blockNumber),
        timestamp: state.omitTimestamp ? undefined : toHex(state.timestamp),
        hash: "0x" + "11".repeat(32),
        transactions: [],
      };
    } else {
      assert.equal(params.at(-1), toHex(state.blockNumber), "State reads must use the selected block");
      if (method === "eth_getCode") {
        const target = String(params[0]).toLowerCase();
        assert(canonical.has(target), "Only canonical token/router/pool addresses are checked");
        result = target === state.emptyCode?.toLowerCase() ? "0x" : "0x6000";
      } else if (method === "eth_getBalance") {
        assert.equal(getAddress(String(params[0])), WALLET);
        result = toHex(state.native);
      } else if (method === "eth_call") {
        const call = params[0] as { to: Address; data: Hex };
        const target = getAddress(call.to);
        const asset = Object.values(ASSETS).find(a => getAddress(a.address) === target)?.id;
        const decoded = decodeFunctionData({ abi: RPC_ABI, data: call.data });
        switch (decoded.functionName) {
          case "symbol":
            assert(asset);
            result = encodeAbiParameters([{ type: "string" }], [state.symbols[asset]]);
            break;
          case "decimals":
            assert(asset);
            result = uint(state.decimals[asset]);
            break;
          case "balanceOf":
            assert(asset);
            assert.equal(decoded.args[0], WALLET);
            result = uint(state.balances[asset]);
            break;
          case "allowance":
            assert(asset);
            assert.deepEqual(decoded.args, [WALLET, ROUTER]);
            result = uint(state.allowance);
            break;
          case "factory":
            assert([getAddress(QUOTER), getAddress(ROUTER)].includes(target));
            result = address(state.factory);
            break;
          case "WETH9": result = address(ROUTER_WETH); break;
          case "oraclePaused":
            assert(asset && asset !== "USDG");
            result = encodeAbiParameters([{ type: "bool" }], [state.paused.has(asset)]);
            break;
          case "uiMultiplier":
            assert(asset && asset !== "USDG");
            result = uint(state.multipliers[asset]!);
            break;
          case "getPool":
            assert.equal(target, FACTORY);
            assert.equal(decoded.args[1], USDG);
            const stock = Object.values(ASSETS).find(a => a.address === decoded.args[0]);
            assert(stock && stock.id !== "USDG");
            result = address(state.poolOverride ?? POOLS[stock.id]![decoded.args[2]] ?? ZERO);
            break;
          case "quoteExactInputSingle": {
            assert.equal(target, QUOTER);
            const { tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96 } = decoded.args[0];
            assert.equal(sqrtPriceLimitX96, 0n);
            const sellStock = getAddress(tokenIn) !== getAddress(USDG);
            assert.equal(getAddress(sellStock ? tokenOut : tokenIn), getAddress(USDG));
            assert(Object.values(ASSETS).some(a => a.id !== "USDG" && getAddress(a.address) === getAddress(sellStock ? tokenIn : tokenOut)));
            const output = sellStock
              ? (state.forward[fee]! * amountIn) / SAMPLE
              : (state.reverse[fee]! * amountIn) / 10_000_000n;
            result = encodeAbiParameters(
              [{ type: "uint256" }, { type: "uint160" }, { type: "uint32" }, { type: "uint256" }],
              [output, 1n, 0, 90_000n],
            );
            state.now += state.advanceAfterQuote;
            state.advanceAfterQuote = 0n;
            break;
          }
        }
      } else assert.fail(`Unexpected method: ${method}; tests must never sign or broadcast`);
    }
    assert.notEqual(result, undefined);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  });
  const config: ChainConfig = {
    rpcUrl: "http://chain-fixture.invalid", wallet: WALLET,
    targets: { USDG: 2_000, TSLA: 2_000, AAPL: 2_000, NVDA: 2_000, AMZN: 2_000 }, slippageBps: 50, deadlineSeconds: 60,
  };
  return { state, config, chain: createChain(config) };
}

const trade: TradePlan = { sellAssetId: "TSLA", buyAssetId: "USDG", amountIn: SAMPLE, reason: "Local test" };

test("local snapshot uses 18/6 decimals, a DEX estimate and separate native gas", async (t) => {
  const { state, chain } = fixture(t);
  assert.equal(ROBINHOOD.id, 4663);
  assert.deepEqual(ASSETS.TSLA, { id: "TSLA", symbol: "TSLA", address: TSLA, decimals: 18 });
  assert.deepEqual(ASSETS.USDG, { id: "USDG", symbol: "USDG", address: USDG, decimals: 6 });
  const snapshot = await chain.snapshot();
  assert.equal(snapshot.blockNumber, state.blockNumber);
  assert.equal(snapshot.blockTimestamp, state.timestamp);
  assert.equal(snapshot.nativeBalance, ETHER);
  assert.match(snapshot.valuationNote, /Estimated in USDG.*Not a fair-share-price oracle/);
  assert.deepEqual(snapshot.portfolio.positions.map(({ id }) => id), ["USDG", "TSLA", "AAPL", "NVDA", "AMZN"]);
  assert.equal(snapshot.portfolio.positions[0]!.valueUsdE8, 5_000n * USD);
  assert.equal(snapshot.portfolio.positions.find(p => p.id === "TSLA")!.priceUsdE8, 200n * USD);
  // AAPL's 2x share multiplier is disclosed, but the actual-token DEX quote is not doubled.
  assert.equal(snapshot.multipliers.AAPL, 2n * ETHER);
  assert.equal(snapshot.portfolio.positions.find(p => p.id === "AAPL")!.priceUsdE8, 199_90000000n);
  assert.equal(snapshot.portfolio.totalUsdE8, 6_599_80000000n);
  const codeReads = state.requests.filter(({ method }) => method === "eth_getCode").length;
  assert.equal(codeReads, 22);
  state.native = 50n * ETHER;
  assert.equal((await chain.snapshot()).portfolio.totalUsdE8, snapshot.portfolio.totalUsdE8);
  assert.equal(state.requests.filter(({ method }) => method === "eth_getCode").length, codeReads);
});

test("canonical checks reject missing code, wrong decimals, factory and pool", async (t) => {
  const cases: [string, (state: ReturnType<typeof fixture>["state"]) => void, RegExp][] = [
    ["missing code", (s) => { s.emptyCode = QUOTER; }, /no code/],
    ["wrong USDG decimals", (s) => { s.decimals.USDG = 18; }, /Unexpected USDG metadata/],
    ["wrong TSLA symbol", (s) => { s.symbols.TSLA = "ETH"; }, /Unexpected TSLA metadata/],
    ["wrong factory", (s) => { s.factory = WALLET; }, /Unexpected Uniswap factory/],
    ["missing pools", (s) => { s.poolOverride = ZERO; }, /No Uniswap v3 TSLA\/USDG pool/],
  ];
  for (const [name, change, expected] of cases) {
    await t.test(name, async (child) => {
      const { state, chain } = fixture(child);
      change(state);
      await assert.rejects(chain.snapshot(), expected);
    });
  }
});

test("quotes select actual output across fees and reject zero output or rounded-zero minimum", async (t) => {
  const { state, chain } = fixture(t);
  assert.deepEqual(await chain.quote(trade), { amountOut: 2_000_000n, minimumOut: 1_990_000n, fee: 100, blockNumber: 100n });
  state.forward[100] = 0n;
  state.forward[3000] = 2_001_000n;
  assert.equal((await chain.quote(trade)).fee, 3000);
  const reverse = await chain.quote({ ...trade, sellAssetId: "USDG", buyAssetId: "TSLA", amountIn: 10_000_000n });
  assert.equal(reverse.amountOut, 5n * 10n ** 15n);
  for (const fee of Object.keys(state.forward)) state.forward[Number(fee)] = 0n;
  await assert.rejects(chain.quote(trade), /No positive TSLA\/USDG quote/);
  state.forward[100] = 1n;
  await assert.rejects(chain.quote(trade), /Minimum output after slippage/);
});

test("approval is exact; the next cycle requotes and encodes the actual SwapRouter02 deadline layout", async (t) => {
  const { state, chain } = fixture(t);
  const initial = await chain.quote(trade);
  state.allowance = trade.amountIn - 1n;
  const approval = await chain.transaction(trade, initial);
  assert.equal(approval.kind, "approval");
  assert.equal(approval.to, TSLA);
  assert.equal(approval.value, 0n);
  assert.equal(approval.expiresAt, undefined);
  const decodedApproval = decodeFunctionData({ abi: TRANSACTION_ABI, data: approval.data });
  assert.equal(decodedApproval.functionName, "approve");
  assert.deepEqual(decodedApproval.args, [ROUTER, trade.amountIn]);

  // Model a confirmed approval, a new block, and a changed best route.
  state.allowance = trade.amountIn;
  state.blockNumber += 1n;
  state.timestamp += 12n;
  state.now += 12n;
  state.forward[500] = 2_100_000n;
  const swap = await chain.transaction(trade, initial);
  assert.equal(swap.kind, "swap");
  assert.equal(swap.to, ROUTER);
  assert.equal(swap.value, 0n);
  const outer = decodeFunctionData({ abi: TRANSACTION_ABI, data: swap.data });
  assert.equal(outer.functionName, "multicall");
  if (outer.functionName !== "multicall") assert.fail("Expected deadline multicall");
  assert.equal(outer.args[0], state.timestamp + 60n);
  assert.equal(swap.expiresAt, outer.args[0]);
  assert.equal(outer.args[1].length, 1);
  const inner = decodeFunctionData({ abi: TRANSACTION_ABI, data: outer.args[1][0]! });
  assert.equal(inner.functionName, "exactInputSingle");
  if (inner.functionName !== "exactInputSingle") assert.fail("Expected v3 swap");
  assert.deepEqual(inner.args[0], {
    tokenIn: TSLA, tokenOut: USDG, fee: 500, recipient: WALLET,
    amountIn: trade.amountIn, amountOutMinimum: 2_089_500n, sqrtPriceLimitX96: 0n,
  });
  assert.equal(Object.hasOwn(inner.args[0], "deadline"), false);
  assert.notEqual(inner.args[0].amountOutMinimum, initial.minimumOut);
});

test("a quote cannot renew a deadline that expired during transaction construction", async (t) => {
  const { state, chain } = fixture(t);
  const initial = await chain.quote(trade);
  state.allowance = trade.amountIn;
  state.advanceAfterQuote = 61n;
  await assert.rejects(chain.transaction(trade, initial), /deadline elapsed/);
});

test("wrong chain, stale/future timestamps and pending headers fail before state use", async (t) => {
  const { state, chain } = fixture(t);
  state.chainId = 1;
  await assert.rejects(chain.snapshot(), /Wrong RPC chain ID/);
  state.chainId = 4663;
  state.timestamp = state.now - 121n;
  await assert.rejects(chain.snapshot(), /stale/);
  state.timestamp = state.now + 31n;
  await assert.rejects(chain.snapshot(), /future/);
  state.timestamp = state.now;
  state.omitTimestamp = true;
  await assert.rejects(chain.snapshot(), /invalid, stale or future-dated/);
  state.omitTimestamp = false;
  state.pending = true;
  await assert.rejects(chain.snapshot(), /pending block/);
  assert(state.requests.every(({ method }) => ["eth_chainId", "eth_getBlockByNumber"].includes(method)));
});

test("invalid pairs, zero/overflow inputs and overspending are rejected", async (t) => {
  const { state, chain } = fixture(t);
  for (const pair of [
    { sellAssetId: "ETH", buyAssetId: "USDG" },
    { sellAssetId: "TSLA", buyAssetId: "TSLA" },
    { sellAssetId: "TSLA", buyAssetId: "USDC" },
  ]) await assert.rejects(chain.quote({ ...trade, ...pair }), /Only direct trades/);
  for (const amountIn of [0n, -1n, maxUint256 + 1n]) {
    await assert.rejects(chain.quote({ ...trade, amountIn }), /positive uint256/);
  }
  assert.equal(state.requests.length, 0);
  state.balances.TSLA = trade.amountIn - 1n;
  await assert.rejects(chain.quote(trade), /Insufficient TSLA balance/);
  const fabricatedQuote = { amountOut: 1n, minimumOut: 1n, fee: 100, blockNumber: 100n };
  await assert.rejects(chain.transaction(trade, fabricatedQuote), /Insufficient TSLA balance/);
});

test("corporate-action pause blocks observations, quotes and approvals in either direction", async (t) => {
  const { state, chain } = fixture(t);
  const initial = await chain.quote(trade);
  state.paused.add("TSLA");
  await assert.rejects(chain.snapshot(), /paused for a corporate action: TSLA/);
  await assert.rejects(chain.quote(trade), /paused for a corporate action: TSLA/);
  await assert.rejects(chain.quote({ ...trade, sellAssetId: "USDG", buyAssetId: "TSLA", amountIn: 10_000_000n }), /paused for a corporate action: TSLA/);
  await assert.rejects(chain.transaction(trade, initial), /paused for a corporate action: TSLA/);
  state.paused.clear();
  assert.equal((await chain.transaction(trade, initial)).kind, "approval");
});

test("configuration requires all five assets and offers no WETH wrap feature", (t) => {
  const { chain, config } = fixture(t);
  assert.equal(Object.hasOwn(chain, "wrapTransaction"), false);
  assert.equal(Object.hasOwn(ASSETS, "WETH"), false);
  assert.throws(() => createChain({ ...config, targets: { WETH: 5_000, USDG: 5_000 } }), /Targets/);
  assert.throws(() => createChain({ ...config, targets: { ...config.targets, TSLA: 2_001 } }), /Targets/);
  assert.throws(() => createChain({ ...config, slippageBps: 10_000 }), /Slippage/);
  assert.throws(() => createChain({ ...config, slippageBps: 0.5 }), /Slippage/);
  assert.throws(() => createChain({ ...config, deadlineSeconds: 0 }), /Deadline/);
  assert.throws(() => createChain({ ...config, wallet: ZERO }), /Wallet/);
});
