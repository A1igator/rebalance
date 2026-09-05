export type AssetPosition = {
  id: string;
  symbol: string;
  decimals: number;
  balance: bigint;
  priceUsdE8: bigint;
  targetBps: number;
};

export type Portfolio = {
  totalUsdE8: bigint;
  positions: (AssetPosition & {
    valueUsdE8: bigint;
    weightBps: number;
    driftBps: number;
  })[];
};

export type TradePlan = {
  sellAssetId: string;
  buyAssetId: string;
  amountIn: bigint;
  reason: string;
};

const BPS = 10_000n;

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function checkId(id: string): void {
  if (typeof id !== "string" || id.length === 0 || id.trim() !== id) {
    throw new Error("Asset IDs must be nonempty strings without surrounding whitespace");
  }
}

function checkBps(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > Number(BPS)) {
    throw new Error(`${name} must be an integer from 0 to 10000 basis points`);
  }
}

function estimatedOutput(amountIn: bigint, from: AssetPosition, to: AssetPosition): bigint {
  return (amountIn * from.priceUsdE8 * 10n ** BigInt(to.decimals)) /
    (10n ** BigInt(from.decimals) * to.priceUsdE8);
}

/** Allocate integer units exactly; equal remainders are resolved by asset ID. */
function apportion(
  units: bigint,
  entries: { id: string; weight: bigint }[],
): Map<string, bigint> {
  const denominator = entries.reduce((sum, entry) => sum + entry.weight, 0n);
  if (denominator === 0n) {
    return new Map(entries.map(({ id }) => [id, 0n]));
  }

  const portions = entries.map(({ id, weight }) => ({
    id,
    amount: (units * weight) / denominator,
    remainder: (units * weight) % denominator,
  }));
  const allocated = portions.reduce((sum, portion) => sum + portion.amount, 0n);
  portions.sort((a, b) =>
    a.remainder === b.remainder
      ? compareIds(a.id, b.id)
      : a.remainder > b.remainder
        ? -1
        : 1,
  );
  // The remaining count is smaller than the number of entries.
  for (let i = 0; i < Number(units - allocated); i += 1) {
    portions[i]!.amount += 1n;
  }
  return new Map(portions.map(({ id, amount }) => [id, amount]));
}

/** USD values round down to 1e-8 USD; displayed weights conserve 10,000 bps. */
export function evaluatePortfolio(positions: AssetPosition[]): Portfolio {
  const ids = new Set<string>();
  let targetTotal = 0n;
  const valued = positions.map((position) => {
    checkId(position.id);
    if (ids.has(position.id)) throw new Error(`Duplicate asset ID: ${position.id}`);
    ids.add(position.id);
    if (typeof position.symbol !== "string" || position.symbol.trim().length === 0) {
      throw new Error(`Asset ${position.id} must have a symbol`);
    }
    if (
      !Number.isInteger(position.decimals) ||
      position.decimals < 0 ||
      position.decimals > 255
    ) {
      throw new Error(`Asset ${position.id} decimals must be an integer from 0 to 255`);
    }
    if (typeof position.balance !== "bigint" || position.balance < 0n) {
      throw new Error(`Asset ${position.id} balance must be a nonnegative bigint`);
    }
    if (typeof position.priceUsdE8 !== "bigint" || position.priceUsdE8 <= 0n) {
      throw new Error(`Asset ${position.id} priceUsdE8 must be a positive bigint`);
    }
    checkBps(position.targetBps, `Asset ${position.id} target`);
    targetTotal += BigInt(position.targetBps);
    return {
      ...position,
      valueUsdE8: (position.balance * position.priceUsdE8) / 10n ** BigInt(position.decimals),
    };
  });
  if (positions.length > 0 && targetTotal !== BPS) {
    throw new Error("Target weights must total 10000 basis points");
  }

  const totalUsdE8 = valued.reduce((sum, position) => sum + position.valueUsdE8, 0n);
  const weights = apportion(
    BPS,
    valued.map(({ id, valueUsdE8 }) => ({ id, weight: valueUsdE8 })),
  );
  return {
    totalUsdE8,
    positions: valued.map((position) => {
      const weightBps = Number(weights.get(position.id)!);
      return { ...position, weightBps, driftBps: weightBps - position.targetBps };
    }),
  };
}

/** Proportionally redistribute the other targets, without mutating the input. */
export function redistributeTargets(
  targets: Record<string, number>,
  assetId: string,
  targetBps: number,
): Record<string, number> {
  if (targets === null || typeof targets !== "object" || Array.isArray(targets)) {
    throw new Error("Targets must be an object keyed by asset ID");
  }
  checkId(assetId);
  checkBps(targetBps, "New target");
  const entries = Object.entries(targets).sort(([a], [b]) => compareIds(a, b));
  let total = 0n;
  for (const [id, weight] of entries) {
    checkId(id);
    checkBps(weight, `Asset ${id} target`);
    total += BigInt(weight);
  }
  if (total !== BPS) throw new Error("Target weights must total 10000 basis points");
  if (!Object.hasOwn(targets, assetId)) throw new Error(`Unknown asset ID: ${assetId}`);

  const others = entries
    .filter(([id]) => id !== assetId)
    .map(([id, weight]) => ({ id, weight: BigInt(weight) }));
  const remaining = BPS - BigInt(targetBps);
  if (remaining > 0n && others.every(({ weight }) => weight === 0n)) {
    throw new Error(
      "Cannot proportionally redistribute a 100% allocation: specify complete targets for the other assets",
    );
  }
  const redistributed = apportion(remaining, others);
  return Object.fromEntries(
    entries.map(([id]) => [id, id === assetId ? targetBps : Number(redistributed.get(id)!)]),
  );
}

/**
 * Plan one exact-input leg via the quote asset. Threshold checks use rational
 * USD deviations, so display rounding cannot create or suppress a trade.
 * Fees, live route quotes, slippage, and native gas are the execution layer's job.
 */
export function planTrade(
  portfolio: Portfolio,
  quoteAssetId: string,
  driftThresholdBps: number,
): TradePlan | null {
  checkBps(driftThresholdBps, "Drift threshold");
  checkId(quoteAssetId);
  // Use the same arithmetic even if a caller passes cached display fields.
  const current = evaluatePortfolio(portfolio.positions);
  if (current.positions.length === 0) return null;
  const quote = current.positions.find(({ id }) => id === quoteAssetId);
  if (!quote) throw new Error(`Unknown quote asset ID: ${quoteAssetId}`);
  if (current.totalUsdE8 === 0n) return null;

  const deviations = current.positions.map((position) => ({
    position,
    delta: position.valueUsdE8 * BPS - current.totalUsdE8 * BigInt(position.targetBps),
  }));
  const threshold = current.totalUsdE8 * BigInt(driftThresholdBps);
  if (!deviations.some(({ delta }) => (delta < 0n ? -delta : delta) > threshold)) {
    return null;
  }

  const largestFirst = (a: { position: AssetPosition; delta: bigint }, b: typeof a): number => {
    const magnitudeA = a.delta < 0n ? -a.delta : a.delta;
    const magnitudeB = b.delta < 0n ? -b.delta : b.delta;
    return magnitudeA === magnitudeB
      ? compareIds(a.position.id, b.position.id)
      : magnitudeA > magnitudeB
        ? -1
        : 1;
  };
  const sells = deviations
    .filter(({ position, delta }) => position.id !== quoteAssetId && delta > 0n)
    .sort(largestFirst);
  for (const { position, delta } of sells) {
    const correction = (delta * 10n ** BigInt(position.decimals)) / (BPS * position.priceUsdE8);
    const amountIn = correction < position.balance ? correction : position.balance;
    if (amountIn === 0n || estimatedOutput(amountIn, position, quote) === 0n) continue;
    return {
      sellAssetId: position.id,
      buyAssetId: quoteAssetId,
      amountIn,
      reason: `Sell overweight ${position.symbol} into ${quote.symbol}`,
    };
  }

  const quoteSurplus = deviations.find(({ position }) => position.id === quoteAssetId)!.delta;
  if (quoteSurplus <= 0n) return null;
  const buys = deviations
    .filter(({ position, delta }) => position.id !== quoteAssetId && delta < 0n)
    .sort(largestFirst);
  for (const { position, delta } of buys) {
    const deficit = -delta;
    const correction = deficit < quoteSurplus ? deficit : quoteSurplus;
    const proposedAmount = (correction * 10n ** BigInt(quote.decimals)) / (BPS * quote.priceUsdE8);
    const amountIn = proposedAmount < quote.balance ? proposedAmount : quote.balance;
    if (amountIn === 0n || estimatedOutput(amountIn, quote, position) === 0n) continue;
    return {
      sellAssetId: quoteAssetId,
      buyAssetId: position.id,
      amountIn,
      reason: `Buy underweight ${position.symbol} with excess ${quote.symbol}`,
    };
  }
  return null;
}
