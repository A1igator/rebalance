import { ASSETS, QUOTE_ASSET_ID } from './assets.js';
import { evaluatePortfolio, planTrade, type AssetPosition, type Portfolio } from './core.js';
import type { Config } from './config.js';
import type { Status } from './runtime.js';

export type FeeProjection = {
  swaps: number;
  observedAt: string;
  wallet: string;
  targets: Record<string, number>;
  balances: Record<string, string>;
};

const MAX_AGE_MS = 90_000;
const MAX_SWAPS = 16;
const MAX_UINT256 = (1n << 256n) - 1n;
const usableNodes = new Set(['intent', 'config', 'observe', 'plan', 'interval', 'quote', 'wait']);
const settledOperations = new Set([
  'confirmed', 'cancelled', 'recovered-revert', 'needs-rebalance', 'cooling-down',
  'waiting-ledger', 'waiting-privy', 'stopping',
]);

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function uint256(value: unknown): bigint {
  if (typeof value !== 'bigint' && (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,77})$/.test(value))) {
    throw new Error('Invalid position quantity');
  }
  const parsed = BigInt(value);
  if (parsed < 0n || parsed > MAX_UINT256) throw new Error('Invalid position quantity');
  return parsed;
}

function withinThreshold(portfolio: Portfolio, threshold: number): boolean {
  return portfolio.positions.every(position => {
    const delta = position.valueUsdE8 * 10_000n - portfolio.totalUsdE8 * BigInt(position.targetBps);
    return (delta < 0n ? -delta : delta) <= portfolio.totalUsdE8 * BigInt(threshold);
  });
}

/**
 * Display-only fixed-price projection of the existing planner's sequential legs.
 * This never quotes a route, forecasts slippage/corporate actions, or executes a
 * transaction. Preserve the observation's age and identity for UI invalidation.
 */
export function projectRebalanceFees(snapshot: Status, config: Config | null, now = Date.now()): FeeProjection | null {
  try {
    if (!config || config.version !== 1 || config.chainId !== 4663 ||
        typeof config.wallet !== 'string' || !/^0x[0-9a-f]{40}$/i.test(config.wallet) ||
        !snapshot || snapshot.app !== 'Rebalance' || snapshot.chain?.id !== 4663 ||
        typeof snapshot.wallet !== 'string' || snapshot.wallet.toLowerCase() !== config.wallet.toLowerCase() ||
        snapshot.mode !== config.mode || !['private-key', 'privy', 'ledger'].includes(config.mode) ||
        snapshot.error !== null || !usableNodes.has(snapshot.graph?.node) ||
        !Number.isSafeInteger(now) || typeof snapshot.updatedAt !== 'string') return null;
    const observedAt = Date.parse(snapshot.updatedAt);
    if (!Number.isFinite(observedAt) || observedAt > now || now - observedAt > MAX_AGE_MS) return null;
    if (snapshot.operation !== null && (!record(snapshot.operation) ||
        !settledOperations.has(snapshot.operation.status) || snapshot.operation.sendFailure !== undefined ||
        (snapshot.operation.chainId !== undefined && snapshot.operation.chainId !== 4663) ||
        (snapshot.operation.wallet !== undefined && (typeof snapshot.operation.wallet !== 'string' ||
          snapshot.operation.wallet.toLowerCase() !== config.wallet.toLowerCase())))) return null;
    if (!Number.isInteger(config.driftThresholdBps) || config.driftThresholdBps < 0 || config.driftThresholdBps > 10_000 ||
        !record(config.targets) || !record(snapshot.config?.targets)) return null;
    const ids = Object.keys(config.targets).sort();
    if (ids.length !== 5 || !ids.includes(QUOTE_ASSET_ID) || Object.keys(snapshot.config.targets).length !== ids.length ||
        ids.some(id => !Object.hasOwn(ASSETS, id) || !Object.hasOwn(snapshot.config!.targets, id) ||
          !Number.isInteger(config.targets[id]) || config.targets[id] < 0 || config.targets[id] > 10_000 ||
          config.targets[id] !== snapshot.config!.targets[id])) return null;
    if (!snapshot.portfolio || !Array.isArray(snapshot.portfolio.positions) || snapshot.portfolio.positions.length !== ids.length) return null;
    const positions: AssetPosition[] = snapshot.portfolio.positions.map(position => {
      if (!position || typeof position.id !== 'string' || !Object.hasOwn(config.targets, position.id)) {
        throw new Error('Position is not configured');
      }
      const asset = ASSETS[position.id as keyof typeof ASSETS];
      if (position.decimals !== asset.decimals || position.symbol !== asset.symbol ||
          position.targetBps !== config.targets[position.id]) throw new Error('Position identity differs');
      return {
        id: position.id, symbol: position.symbol, decimals: position.decimals,
        balance: uint256(position.balance), priceUsdE8: uint256(position.priceUsdE8), targetBps: position.targetBps,
      };
    });
    let portfolio = evaluatePortfolio(positions);
    if (portfolio.totalUsdE8 <= 0n) return null;
    const identity = {
      observedAt: snapshot.updatedAt, wallet: config.wallet,
      targets: Object.fromEntries(ids.map(id => [id, config.targets[id]])),
      balances: Object.fromEntries([...positions].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
        .map(position => [position.id, position.balance.toString()])),
    };
    for (let swaps = 0; swaps <= MAX_SWAPS; swaps++) {
      const trade = planTrade(portfolio, QUOTE_ASSET_ID, config.driftThresholdBps);
      if (!trade) return withinThreshold(portfolio, config.driftThresholdBps) ? { swaps, ...identity } : null;
      if (swaps === MAX_SWAPS) return null;
      const sell = positions.find(position => position.id === trade.sellAssetId)!;
      const buy = positions.find(position => position.id === trade.buyAssetId)!;
      if (!sell || !buy || sell === buy || trade.amountIn <= 0n || trade.amountIn > sell.balance) return null;
      const amountOut = trade.amountIn * sell.priceUsdE8 * 10n ** BigInt(buy.decimals) /
        (10n ** BigInt(sell.decimals) * buy.priceUsdE8);
      if (amountOut <= 0n || buy.balance + amountOut > MAX_UINT256) return null;
      sell.balance -= trade.amountIn;
      buy.balance += amountOut;
      portfolio = evaluatePortfolio(positions);
      if (portfolio.totalUsdE8 <= 0n) return null;
    }
  } catch { /* Malformed or nonconverging observations have no useful estimate. */ }
  return null;
}
