import {
  createPublicClient,
  decodeFunctionResult,
  defineChain,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  http,
  isAddress,
  maxUint256,
  parseAbi,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { evaluatePortfolio, type Portfolio, type TradePlan } from "./core.ts";
import { ASSETS } from "./assets.ts";
export { ASSETS } from "./assets.ts";

export const ROBINHOOD = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
  blockExplorers: { default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" } },
});

export const ROUTER: Address = "0xCaf681a66D020601342297493863E78C959E5cb2";
export const QUOTER: Address = "0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7";
const FACTORY: Address = "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA";
// The upstream router retains its canonical WETH9 identity; WETH is not an allocation.
const ROUTER_WETH: Address = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const FEES = [100, 500, 3000, 10000] as const;

export const VALUATION_NOTE =
  "Estimated in USDG from 0.01 stock-token DEX quotes; USDG is the unit reference. Not a fair-share-price oracle. DEX prices can differ from the underlying market, including while it is closed. Raw token units; ETH is gas only.";

export type ChainConfig = {
  rpcUrl: string;
  wallet: Address;
  targets: Record<string, number>;
  slippageBps: number;
  deadlineSeconds: number;
};

export type RouteQuote = {
  amountOut: bigint;
  minimumOut: bigint;
  fee: number;
  blockNumber: bigint;
};

export type ChainTransaction = {
  to: Address;
  data: Hex;
  value: bigint;
  kind: "approval" | "swap" | "wrap";
  /** Swap or active-cycle deadline; dispatch rechecks it before signing/sending. */
  expiresAt?: bigint;
};

// Official ABI sources:
// https://github.com/Uniswap/v3-periphery/blob/main/contracts/interfaces/IQuoterV2.sol
// https://github.com/Uniswap/swap-router-contracts/blob/main/contracts/interfaces/IV3SwapRouter.sol
// https://github.com/Uniswap/swap-router-contracts/blob/main/contracts/interfaces/IMulticallExtended.sol
const QUOTER_ABI = parseAbi([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);
const ROUTER_ABI = parseAbi([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
  "function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)",
]);
const IDENTITY_ABI = parseAbi([
  "function factory() view returns (address)",
  "function WETH9() view returns (address)",
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)",
]);
const STOCK_ABI = parseAbi([
  "function oraclePaused() view returns (bool)",
  "function uiMultiplier() view returns (uint256)",
]);
type Asset = (typeof ASSETS)[keyof typeof ASSETS];
type Stock = Exclude<Asset, { id: "USDG" }>;
type Header = { number: bigint; timestamp: bigint };

function amount(value: bigint, label: string, allowZero = false): bigint {
  if (typeof value !== "bigint" || value < 0n || (!allowZero && value === 0n) || value > maxUint256) {
    throw new Error(`${label} must be a ${allowZero ? "nonnegative" : "positive"} uint256 bigint`);
  }
  return value;
}

function assetsFor(trade: TradePlan, assetList: Asset[]): { sell: Asset; buy: Asset } {
  const sell = assetList.find(({ id }) => id === trade.sellAssetId);
  const buy = assetList.find(({ id }) => id === trade.buyAssetId);
  if (!sell || !buy || sell.id === buy.id || (sell.id !== "USDG" && buy.id !== "USDG")) {
    throw new Error("Only direct trades between USDG and one configured stock are supported");
  }
  amount(trade.amountIn, "Trade input");
  return { sell, buy };
}

function fresh(header: Header): void {
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (
    typeof header.number !== "bigint" || typeof header.timestamp !== "bigint" ||
    header.number < 0n || header.timestamp < now - 120n || header.timestamp > now + 30n
  ) {
    throw new Error("RPC returned an invalid, stale or future-dated block header");
  }
}

export function createChain(config: ChainConfig) {
  const url = new URL(config.rpcUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("RPC must use HTTP or HTTPS");
  if (!isAddress(config.wallet) || getAddress(config.wallet) === zeroAddress) {
    throw new Error("Wallet must be a valid nonzero EVM address");
  }
  if (!Number.isSafeInteger(config.slippageBps) || config.slippageBps < 0 || config.slippageBps >= 10_000) {
    throw new Error("Slippage must be an integer from 0 to 9999 basis points");
  }
  if (!Number.isSafeInteger(config.deadlineSeconds) || config.deadlineSeconds <= 0) {
    throw new Error("Deadline duration must be a positive integer number of seconds");
  }
  const targets = { ...config.targets };
  if (
    Object.keys(targets).length !== 5 || !Object.hasOwn(targets, "USDG") ||
    Object.keys(targets).some(id => !Object.hasOwn(ASSETS, id)) ||
    Object.values(targets).some(weight => !Number.isInteger(weight) || weight < 0 || weight > 10_000) ||
    Object.values(targets).reduce((sum, target) => sum + target, 0) !== 10_000
  ) {
    throw new Error("Targets must select USDG plus four supported stocks and total 10000 integer basis points");
  }
  const assetList = Object.values(ASSETS).filter(asset => Object.hasOwn(targets, asset.id));
  const stockList = assetList.filter((asset): asset is Stock => asset.id !== "USDG");
  const wallet = getAddress(config.wallet);
  const slippageBps = BigInt(config.slippageBps);
  const deadlineSeconds = BigInt(config.deadlineSeconds);
  const publicClient = createPublicClient({
    chain: ROBINHOOD,
    batch: { multicall: false },
    cacheTime: 0,
    transport: http(url.toString(), {
      batch: false,
      timeout: 20_000,
      fetchOptions: { headers: { "User-Agent": "rebalance-read-only-route-check/0.1" } },
    }),
  });

  let identityCheck: Promise<void> | undefined;
  const pools = new Map<string, { fee: number; address: Address }[]>();
  async function verifyIdentity(blockNumber: bigint): Promise<void> {
    identityCheck ??= (async () => {
      await Promise.all(
        [...assetList.map(({ address }) => address), FACTORY, QUOTER, ROUTER].map(async (address) => {
          const code = await publicClient.getCode({ address, blockNumber });
          if (!code || code === "0x") throw new Error(`Expected mainnet contract has no code: ${address}`);
        }),
      );
      for (const asset of assetList) {
        const [symbol, decimals] = await Promise.all([
          publicClient.readContract({ address: asset.address, abi: erc20Abi, functionName: "symbol", blockNumber }),
          publicClient.readContract({ address: asset.address, abi: erc20Abi, functionName: "decimals", blockNumber }),
        ]);
        if (symbol !== asset.symbol || decimals !== asset.decimals) throw new Error(`Unexpected ${asset.id} metadata`);
      }
      for (const address of [QUOTER, ROUTER]) {
        const [factory, weth] = await Promise.all([
          publicClient.readContract({ address, abi: IDENTITY_ABI, functionName: "factory", blockNumber }),
          publicClient.readContract({ address, abi: IDENTITY_ABI, functionName: "WETH9", blockNumber }),
        ]);
        if (getAddress(factory) !== getAddress(FACTORY) || getAddress(weth) !== getAddress(ROUTER_WETH)) {
          throw new Error(`Unexpected Uniswap factory or WETH9: ${address}`);
        }
      }
      for (const stock of stockList) {
        const discovered: { fee: number; address: Address }[] = [];
        for (const fee of FEES) {
          const address = await publicClient.readContract({
            address: FACTORY, abi: IDENTITY_ABI, functionName: "getPool",
            args: [stock.address, ASSETS.USDG.address, fee], blockNumber,
          });
          if (getAddress(address) === zeroAddress) continue;
          const code = await publicClient.getCode({ address, blockNumber });
          if (!code || code === "0x") throw new Error(`Factory returned a pool without code: ${address}`);
          discovered.push({ fee, address });
        }
        if (discovered.length === 0) throw new Error(`No Uniswap v3 ${stock.id}/USDG pool exists`);
        pools.set(stock.id, discovered);
      }
    })().catch((error: unknown) => {
      identityCheck = undefined;
      throw error;
    });
    await identityCheck;
  }

  async function header(): Promise<Header> {
    const [chainId, block] = await Promise.all([
      publicClient.getChainId(),
      publicClient.getBlock({ blockTag: "latest" }),
    ]);
    if (chainId !== ROBINHOOD.id) throw new Error(`Wrong RPC chain ID: expected 4663, received ${chainId}`);
    if (block.number === null) throw new Error("RPC returned a pending block instead of a mined block");
    fresh(block);
    await verifyIdentity(block.number);
    fresh(block);
    return block;
  }

  async function tokenBalance(asset: Asset, blockNumber: bigint): Promise<bigint> {
    return amount(await publicClient.readContract({
      address: asset.address, abi: erc20Abi, functionName: "balanceOf", args: [wallet], blockNumber,
    }), `${asset.id} balance`, true);
  }

  async function requireBalance(trade: TradePlan, blockNumber: bigint): Promise<void> {
    const { sell } = assetsFor(trade, assetList);
    if (trade.amountIn > await tokenBalance(sell, blockNumber)) throw new Error(`Insufficient ${sell.id} balance`);
  }

  async function stockState(stock: Stock, blockNumber: bigint): Promise<bigint> {
    const [paused, multiplier] = await Promise.all([
      publicClient.readContract({ address: stock.address, abi: STOCK_ABI, functionName: "oraclePaused", blockNumber }),
      publicClient.readContract({ address: stock.address, abi: STOCK_ABI, functionName: "uiMultiplier", blockNumber }),
    ]);
    if (paused) throw new Error(`Stock token oracle is paused for a corporate action: ${stock.id}; no new trade will be sent`);
    return amount(multiplier, `${stock.id} UI multiplier`);
  }

  async function requireTradable(trade: TradePlan, blockNumber: bigint): Promise<void> {
    const { sell, buy } = assetsFor(trade, assetList);
    const stock = stockList.find(({ id }) => id === (sell.id === "USDG" ? buy.id : sell.id))!;
    await stockState(stock, blockNumber);
  }

  async function quoteAt(trade: TradePlan, block: Header): Promise<RouteQuote> {
    const { sell, buy } = assetsFor(trade, assetList);
    const stockId = sell.id === "USDG" ? buy.id : sell.id;
    const available = pools.get(stockId);
    if (!available?.length) throw new Error(`No verified ${stockId}/USDG route`);
    const results = await Promise.allSettled(available.map(async ({ fee }) => {
      // QuoterV2 is non-view because its simulation intentionally reverts internally.
      // Calling through eth_call here never submits or persists a transaction.
      const response = await publicClient.call({
        to: QUOTER,
        blockNumber: block.number,
        data: encodeFunctionData({
          abi: QUOTER_ABI, functionName: "quoteExactInputSingle",
          args: [{ tokenIn: sell.address, tokenOut: buy.address, amountIn: trade.amountIn, fee, sqrtPriceLimitX96: 0n }],
        }),
      });
      if (!response.data) throw new Error(`Empty quote for fee ${fee}`);
      const [amountOut] = decodeFunctionResult({ abi: QUOTER_ABI, functionName: "quoteExactInputSingle", data: response.data });
      amount(amountOut, "Quoted output");
      return { amountOut, fee };
    }));
    let best: { amountOut: bigint; fee: number } | undefined;
    const failures: unknown[] = [];
    for (const result of results) {
      if (result.status === "rejected") failures.push(result.reason);
      else if (!best || result.value.amountOut > best.amountOut) best = result.value;
    }
    if (!best) throw new AggregateError(failures, `No positive ${stockId}/USDG quote from any discovered Uniswap v3 pool`);
    fresh(block);
    const minimumOut = (best.amountOut * (10_000n - slippageBps)) / 10_000n;
    amount(minimumOut, "Minimum output after slippage");
    return { ...best, minimumOut, blockNumber: block.number };
  }

  async function snapshot(): Promise<{
    portfolio: Portfolio;
    blockNumber: bigint;
    blockTimestamp: bigint;
    nativeBalance: bigint;
    valuationNote: string;
    multipliers: Record<string, bigint>;
  }> {
    const block = await header();
    const multipliers = await Promise.all(stockList.map(async (stock) => [stock.id, await stockState(stock, block.number)] as const));
    const [balances, native, valuations] = await Promise.all([
      Promise.all(assetList.map((asset) => tokenBalance(asset, block.number))),
      publicClient.getBalance({ address: wallet, blockNumber: block.number }),
      Promise.all(stockList.map(async (stock) => {
        const valuation = await quoteAt({ sellAssetId: stock.id, buyAssetId: "USDG", amountIn: 10n ** 16n, reason: "DEX token valuation estimate" }, block);
        // The actual ERC20 amount is quoted directly. Do not apply uiMultiplier again.
        const price = (valuation.amountOut * 100_000_000n * 10n ** BigInt(stock.decimals)) / (10n ** BigInt(ASSETS.USDG.decimals) * 10n ** 16n);
        return [stock.id, amount(price, `Estimated ${stock.id} token price`)] as const;
      })),
    ]);
    const prices = new Map<string, bigint>(valuations);
    fresh(block);
    return {
      portfolio: evaluatePortfolio(assetList.map((asset, index) => ({
        id: asset.id, symbol: asset.symbol, decimals: asset.decimals,
        balance: balances[index]!, priceUsdE8: asset.id === "USDG" ? 100_000_000n : prices.get(asset.id)!,
        targetBps: targets[asset.id]!,
      }))),
      blockNumber: block.number,
      blockTimestamp: block.timestamp,
      nativeBalance: amount(native, "Native ETH balance", true),
      valuationNote: VALUATION_NOTE,
      multipliers: Object.fromEntries(multipliers),
    };
  }

  async function quote(trade: TradePlan): Promise<RouteQuote> {
    trade = { ...trade };
    assetsFor(trade, assetList);
    const block = await header();
    await requireBalance(trade, block.number);
    await requireTradable(trade, block.number);
    return quoteAt(trade, block);
  }

  async function transaction(trade: TradePlan, _previousQuote: RouteQuote): Promise<ChainTransaction> {
    trade = { ...trade };
    const { sell, buy } = assetsFor(trade, assetList);
    const block = await header();
    await requireBalance(trade, block.number);
    await requireTradable(trade, block.number);
    const allowance = amount(await publicClient.readContract({
      address: sell.address, abi: erc20Abi, functionName: "allowance", args: [wallet, ROUTER], blockNumber: block.number,
    }), "Router allowance", true);
    if (allowance < trade.amountIn) {
      fresh(block);
      // The caller waits for this receipt, then reconstructs the plan and quote.
      return {
        to: sell.address, value: 0n, kind: "approval",
        data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [ROUTER, trade.amountIn] }),
      };
    }
    // Always requote the actual amount. An earlier quote never renews stale pricing.
    const current = await quoteAt(trade, block);
    const deadline = block.timestamp + deadlineSeconds;
    if (deadline <= BigInt(Math.floor(Date.now() / 1000))) throw new Error("Swap deadline elapsed while quoting; retry from a fresh block");
    const swap = encodeFunctionData({
      abi: ROUTER_ABI, functionName: "exactInputSingle",
      args: [{
        tokenIn: sell.address, tokenOut: buy.address, fee: current.fee, recipient: wallet,
        amountIn: trade.amountIn, amountOutMinimum: current.minimumOut, sqrtPriceLimitX96: 0n,
      }],
    });
    return {
      to: ROUTER, value: 0n, kind: "swap", expiresAt: deadline,
      data: encodeFunctionData({ abi: ROUTER_ABI, functionName: "multicall", args: [deadline, [swap]] }),
    };
  }

  return { publicClient, snapshot, quote, transaction };
}
