/** Optional historical diagnostics, not a forecast or a future risk guarantee.
 * Sharpe: https://web.stanford.edu/~wfsharpe/art/sr/SR.htm
 * Downside/Sortino and compounded drawdown conventions:
 * https://cran.r-project.org/web/packages/PerformanceAnalytics/refman/PerformanceAnalytics.html
 * Discrete-tail CVaR, including fractional probability at the cutoff:
 * https://sites.math.washington.edu/~rtr/papers/rtr187-CVaR2.pdf
 */
export type ReturnHistory = {
  source: string;
  basis: 'tradable-token' | 'underlying-proxy' | 'synthetic';
  quoteCurrency: string;
  interval: 'daily' | 'weekly' | 'monthly';
  asOf: string;
  observations: { date: string; returns: Record<string, number> }[];
  benchmarkPeriodReturn: number;
};
export type PortfolioHistoryMetrics = {
  source: string; basis: ReturnHistory['basis']; quoteCurrency: string;
  interval: ReturnHistory['interval']; asOf: string; observationCount: number;
  annualized: false; pathConvention: 'constant-weight-per-observation';
  arithmeticMeanReturn: number; meanDifferentialReturn: number; volatility: number;
  sharpe: number | null; downsideDeviation: number; sortino: number | null;
  maxDrawdown: number; cvar95: number; cvar95TailCount: number;
};
export type ReturnStatistics = {
  assetIds: readonly string[]; meanReturns: readonly number[];
  meanDifferentialReturns: readonly number[]; covariance: readonly (readonly number[])[];
  benchmarkPeriodReturn: number; observationCount: number; varianceEpsilon: number;
  sharpe: (weights: readonly number[]) => number | null;
  diagnostics: (weights: readonly number[]) => PortfolioHistoryMetrics;
};
const invalidHistory = () => new Error('Return history must contain 20 to 2000 aligned, dated simple-return observations with explicit source metadata.');
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) => {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every(key => Object.hasOwn(value, key));
};
const returnValue = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= -1 && value <= 1000;
function dateTime(value: unknown, dayOnly: boolean): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)?$/.test(value)) throw invalidHistory();
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw invalidHistory();
  const canonical = new Date(time).toISOString();
  const day = canonical.slice(0, 10);
  if (value !== day && (dayOnly || (value !== canonical && value !== canonical.replace('.000Z', 'Z')))) throw invalidHistory();
  return dayOnly ? day : canonical;
}

/** Twenty observations is an engineering minimum, not sufficient tail evidence.
 * Inputs must already be aligned: no interpolation, carry-forward, annualization,
 * source substitution or calendar conversion is performed here. Returns are
 * decimal simple returns, bounded at -100% to +100000% per observation.
 * Synthetic histories are permitted for previews/tests; live-policy validation
 * must reject that basis before activation. This module performs no activation.
 */
export function validateReturnHistory(value: unknown, assetIds: readonly string[]): ReturnHistory {
  if (!Array.isArray(assetIds) || assetIds.length === 0 || assetIds.length > 100 ||
      assetIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/.test(id)) || new Set(assetIds).size !== assetIds.length ||
      !object(value) || !exactKeys(value, ['source', 'basis', 'quoteCurrency', 'interval', 'asOf', 'observations', 'benchmarkPeriodReturn']) ||
      typeof value.source !== 'string' || !value.source.trim() || value.source.length > 2000 || /[\0\r\n]/.test(value.source) ||
      !['tradable-token', 'underlying-proxy', 'synthetic'].includes(value.basis as string) ||
      typeof value.quoteCurrency !== 'string' || !/^[A-Z][A-Z0-9_-]{0,15}$/.test(value.quoteCurrency) ||
      !['daily', 'weekly', 'monthly'].includes(value.interval as string) || !returnValue(value.benchmarkPeriodReturn) ||
      !Array.isArray(value.observations) || value.observations.length < 20 || value.observations.length > 2000) throw invalidHistory();
  const asOf = dateTime(value.asOf, false);
  let previous = '';
  const observations = value.observations.map(row => {
    if (!object(row) || !exactKeys(row, ['date', 'returns']) || !object(row.returns) || !exactKeys(row.returns, assetIds)) throw invalidHistory();
    const date = dateTime(row.date, true);
    if (date <= previous || date > asOf.slice(0, 10)) throw invalidHistory();
    previous = date;
    const returns = Object.fromEntries(assetIds.map(id => {
      const item = (row.returns as Record<string, unknown>)[id];
      if (!returnValue(item)) throw invalidHistory();
      return [id, item === 0 ? 0 : item];
    }));
    return { date, returns };
  });
  return { source: value.source.trim(), basis: value.basis as ReturnHistory['basis'], quoteCurrency: value.quoteCurrency,
    interval: value.interval as ReturnHistory['interval'], asOf, observations, benchmarkPeriodReturn: value.benchmarkPeriodReturn === 0 ? 0 : value.benchmarkPeriodReturn };
}

// Stable, fixed-order summation avoids amplification of simple cancellation.
function sum(values: Iterable<number>): number {
  let result = 0, correction = 0;
  for (const value of values) { const next = value - correction; const total = result + next; correction = (total - result) - next; result = total; }
  return result;
}
function validWeights(weights: readonly number[], size: number) {
  if (!Array.isArray(weights) || weights.length !== size || weights.some(w => !Number.isFinite(w) || w < 0 || w > 1) || Math.abs(sum(weights) - 1) > 1e-10) {
    throw new Error('Historical portfolio weights must be finite, nonnegative, aligned and sum to one.');
  }
}

/** Precompute O(assets²) candidate Sharpe scoring. Only winner diagnostics scan
 * the frozen history. Covariance is sample covariance (T-1); the benchmark is
 * constant per period, so subtracting it changes means but not covariance.
 */
export function prepareReturnStatistics(value: unknown, assetIds: readonly string[]): ReturnStatistics {
  const history = validateReturnHistory(value, assetIds);
  const ids = Object.freeze([...assetIds]);
  const rows = history.observations.map(row => ids.map(id => row.returns[id]!));
  const n = rows.length;
  const means = Object.freeze(ids.map((_, i) => sum(rows.map(row => row[i]!)) / n));
  const differentials = Object.freeze(means.map(mean => mean - history.benchmarkPeriodReturn));
  const covariance = ids.map(() => ids.map(() => 0));
  for (let i = 0; i < ids.length; i++) for (let j = i; j < ids.length; j++) {
    const cov = sum(rows.map(row => (row[i]! - means[i]!) * (row[j]! - means[j]!))) / (n - 1);
    covariance[i]![j] = covariance[j]![i] = cov;
  }
  const matrix = Object.freeze(covariance.map(row => Object.freeze(row)));
  const varianceEpsilon = Math.max(1e-18, Math.max(...matrix.map((row, i) => row[i]!)) * Number.EPSILON * 64 * ids.length ** 2);
  const moments = (weights: readonly number[]) => {
    validWeights(weights, ids.length);
    let variance = 0;
    for (let i = 0; i < ids.length; i++) {
      for (let j = 0; j < ids.length; j++) variance += weights[i]! * matrix[i]![j]! * weights[j]!;
    }
    return { mean: sum(weights.map((w, i) => w * means[i]!)),
      differential: sum(weights.map((w, i) => w * differentials[i]!)), variance: Math.max(0, variance) };
  };
  const sharpe = (weights: readonly number[]) => {
    const m = moments(weights);
    return m.variance <= varianceEpsilon ? null : m.differential / Math.sqrt(m.variance);
  };
  const diagnostics = (weights: readonly number[]): PortfolioHistoryMetrics => {
    const m = moments(weights);
    // sum-one floating-point weights can produce -1-epsilon for an all-loss row.
    const returns = rows.map(row => Math.max(-1, sum(weights.map((w, i) => w * row[i]!))));
    const downsideVariance = sum(returns.map(r => Math.max(history.benchmarkPeriodReturn - r, 0) ** 2)) / n;
    const downsideDeviation = Math.sqrt(downsideVariance);
    let logWealth = 0, peakLogWealth = 0, maxDrawdown = 0;
    for (const r of returns) {
      // Log wealth preserves exact compounded-relative-drawdown semantics without
      // overflowing on long high-return paths. A -100% loss stays at zero wealth.
      logWealth += Math.log1p(r);
      peakLogWealth = Math.max(peakLogWealth, logWealth);
      maxDrawdown = Math.max(maxDrawdown, -Math.expm1(logWealth - peakLogWealth));
    }
    const losses = returns.map(r => -r).sort((a, b) => b - a);
    const tailCount = n / 20; // Exactly the worst 5% probability mass, not >= VaR.
    const whole = Math.floor(tailCount), fraction = tailCount - whole;
    const cvar95 = (sum(losses.slice(0, whole)) + (fraction ? fraction * losses[whole]! : 0)) / tailCount;
    return { source: history.source, basis: history.basis, quoteCurrency: history.quoteCurrency,
      interval: history.interval, asOf: history.asOf, observationCount: n, annualized: false,
      pathConvention: 'constant-weight-per-observation', arithmeticMeanReturn: m.mean,
      meanDifferentialReturn: m.differential, volatility: Math.sqrt(m.variance), sharpe: sharpe(weights),
      downsideDeviation, sortino: downsideVariance <= varianceEpsilon ? null : m.differential / downsideDeviation,
      maxDrawdown, cvar95, cvar95TailCount: tailCount };
  };
  return Object.freeze({ assetIds: ids, meanReturns: means, meanDifferentialReturns: differentials, covariance: matrix,
    benchmarkPeriodReturn: history.benchmarkPeriodReturn, observationCount: n, varianceEpsilon, sharpe, diagnostics });
}
