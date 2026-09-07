import { createHash } from 'node:crypto';
import { prepareReturnStatistics, validateReturnHistory, type ReturnHistory } from './allocation-metrics.js';

export type AllocationAssetPolicy = {
  riskScore?: number;
  expectedReturnBps?: number;
  minBps: number;
  maxBps: number;
  rationale?: string;
};
export type AllocationPolicy = {
  version: 1;
  objective: 'user-risk' | 'sharpe';
  horizonMonths: number;
  stepBps: number;
  benchmarkReturnBps: number;
  maxRiskScore?: number;
  riskDefinition?: string;
  assets: Record<string, AllocationAssetPolicy>;
  history?: ReturnHistory;
};
type HistoryMetrics = ReturnType<ReturnType<typeof prepareReturnStatistics>['diagnostics']>;
export type AllocationResult = {
  version: 1;
  solver: 'grid-v1';
  objective: AllocationPolicy['objective'];
  targets: Record<string, number>;
  score: number;
  expectedReturnBps: number;
  returnBasis: 'user-horizon' | 'history-period';
  subjectiveRiskScore: number | null;
  policyHash: string;
  candidates: number;
  stepBps: number;
  diagnostics: {
    search: 'grid+incumbent';
    scoreBasis: 'horizon-excess-bps-per-user-risk-point' | 'historical-period-sharpe';
    horizonMonths: number;
    gridCandidates: number;
    incumbentIncluded: boolean;
    incumbentOffGrid: boolean;
    skippedZeroDenominator: number;
    excludedByRisk: number;
    history?: HistoryMetrics;
  };
};

const TOTAL = 10_000;
export const ALLOCATION_CANDIDATE_LIMIT = 5_000_000;
export const ALLOCATION_SCORE_TOLERANCE = 1e-12;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function onlyKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).some(key => !keys.includes(key))) throw new Error(`${label} contains an unsupported field or constraint`);
}
function integer(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}`);
  }
  return value === 0 ? 0 : value;
}
function narrative(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 1000 || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`${label} must be bounded plain text`);
  return value.trim();
}
function assetIds(ids: readonly string[]): string[] {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 5 || ids.some(id => typeof id !== 'string' || !idPattern.test(id)) || new Set(ids).size !== ids.length) {
    throw new Error('Allocation requires one to five distinct valid asset IDs');
  }
  return [...ids].sort();
}

/** Bounds are long-only. Variable bounds must align with stepBps; fixed weights
 * may be arbitrary integer bps. No volatility/score/return assumption is filled in. */
export function validateAllocationPolicy(value: unknown, ids: readonly string[]): AllocationPolicy {
  const ordered = assetIds(ids);
  const raw = object(value, 'Allocation policy');
  onlyKeys(raw, ['version', 'objective', 'horizonMonths', 'stepBps', 'benchmarkReturnBps', 'maxRiskScore', 'riskDefinition', 'assets', 'history'], 'Allocation policy');
  if (raw.version !== 1 || (raw.objective !== 'user-risk' && raw.objective !== 'sharpe')) throw new Error('Unsupported allocation policy version or objective');
  const horizonMonths = integer(raw.horizonMonths, 1, 1200, 'Allocation horizonMonths');
  const stepBps = integer(raw.stepBps, 100, 1000, 'Allocation stepBps');
  if (TOTAL % stepBps !== 0) throw new Error('Allocation stepBps must divide 10000');
  const benchmarkReturnBps = integer(raw.benchmarkReturnBps, -TOTAL, 10_000_000, 'Allocation benchmarkReturnBps');
  const inputAssets = object(raw.assets, 'Allocation assets');
  if (Object.keys(inputAssets).length !== ordered.length || ordered.some(id => !Object.hasOwn(inputAssets, id))) throw new Error('Allocation assets must exactly match the portfolio asset IDs');
  const assets = Object.fromEntries(ordered.map(id => {
    const input = object(inputAssets[id], 'Allocation asset');
    onlyKeys(input, ['riskScore', 'expectedReturnBps', 'minBps', 'maxBps', 'rationale'], 'Allocation asset');
    const minBps = integer(input.minBps, 0, TOTAL, 'Allocation minBps');
    const maxBps = integer(input.maxBps, 0, TOTAL, 'Allocation maxBps');
    if (minBps > maxBps) throw new Error('Allocation minimum exceeds maximum');
    if (minBps !== maxBps && (minBps % stepBps !== 0 || maxBps % stepBps !== 0)) throw new Error('Variable allocation bounds must align with stepBps; fixed weights may use any integer bps');
    const asset: AllocationAssetPolicy = { minBps, maxBps };
    if (input.rationale !== undefined) asset.rationale = narrative(input.rationale, 'Allocation rationale');
    if (input.riskScore !== undefined) asset.riskScore = integer(input.riskScore, 0, 100, 'Allocation riskScore');
    if (input.expectedReturnBps !== undefined) asset.expectedReturnBps = integer(input.expectedReturnBps, -TOTAL, 10_000_000, 'Allocation expectedReturnBps');
    if (raw.objective === 'user-risk' && (asset.riskScore === undefined || asset.expectedReturnBps === undefined)) {
      throw new Error('User-risk allocation requires explicit riskScore and horizon expectedReturnBps for every asset, including cash');
    }
    return [id, asset];
  }));
  if (ordered.reduce((sum, id) => sum + assets[id].minBps, 0) > TOTAL || ordered.reduce((sum, id) => sum + assets[id].maxBps, 0) < TOTAL) {
    throw new Error('Allocation bounds cannot sum to 10000 basis points');
  }
  const policy: AllocationPolicy = { version: 1, objective: raw.objective, horizonMonths, stepBps, benchmarkReturnBps, assets };
  if (raw.riskDefinition !== undefined) policy.riskDefinition = narrative(raw.riskDefinition, 'Allocation riskDefinition');
  if (raw.maxRiskScore !== undefined) {
    policy.maxRiskScore = integer(raw.maxRiskScore, 0, 100, 'Allocation maxRiskScore');
    if (ordered.some(id => assets[id].riskScore === undefined)) throw new Error('Allocation maxRiskScore requires explicit riskScore for every asset');
  }
  if (raw.history !== undefined) policy.history = validateReturnHistory(raw.history, ordered);
  if (policy.objective === 'sharpe' && !policy.history) throw new Error('Sharpe allocation requires explicit aligned return history with provenance');
  return policy;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
}
export function allocationPolicyHash(policy: AllocationPolicy): string {
  const validated = validateAllocationPolicy(policy, Object.keys(object(policy.assets, 'Allocation assets')));
  return createHash('sha256').update(canonical(validated)).digest('hex');
}

/** Exhaustive bounded grid search, not a continuous optimum or a return forecast.
 * A feasible incumbent is also evaluated even when off-grid. Zero denominator
 * with positive excess needs input; nonpositive excess is skipped, never infinite. */
export function optimizeAllocation(input: AllocationPolicy, currentTargets: Record<string, number>): AllocationResult {
  const policy = validateAllocationPolicy(input, Object.keys(object(input.assets, 'Allocation assets')));
  const ids = Object.keys(policy.assets);
  const current = object(currentTargets, 'Current allocation targets');
  if (Object.keys(current).length !== ids.length || ids.some(id => !Object.hasOwn(current, id))) throw new Error('Current allocation targets must exactly match policy assets');
  const incumbent = ids.map(id => integer(current[id], 0, TOTAL, 'Current allocation weight'));
  if (incumbent.reduce((sum, weight) => sum + weight, 0) !== TOTAL) throw new Error('Current allocation targets must sum to 10000');
  const assets = ids.map(id => policy.assets[id]);
  const choices = assets.map(asset => asset.minBps === asset.maxBps ? [asset.minBps]
    : Array.from({ length: (asset.maxBps - asset.minBps) / policy.stepBps + 1 }, (_, i) => asset.minBps + i * policy.stepBps));
  const suffixMin = new Array<number>(ids.length + 1).fill(0);
  const suffixMax = new Array<number>(ids.length + 1).fill(0);
  for (let i = ids.length - 1; i >= 0; i--) { suffixMin[i] = suffixMin[i + 1] + assets[i].minBps; suffixMax[i] = suffixMax[i + 1] + assets[i].maxBps; }
  const counts = new Map<string, number>();
  function count(index: number, remaining: number): number {
    if (remaining < suffixMin[index] || remaining > suffixMax[index]) return 0;
    if (index === ids.length) return remaining === 0 ? 1 : 0;
    const key = `${index}:${remaining}`;
    if (counts.has(key)) return counts.get(key)!;
    let total = 0;
    for (const weight of choices[index]) {
      total += count(index + 1, remaining - weight);
      if (total > ALLOCATION_CANDIDATE_LIMIT) { total = ALLOCATION_CANDIDATE_LIMIT + 1; break; }
    }
    counts.set(key, total); return total;
  }
  const gridCandidates = count(0, TOTAL);
  const incumbentIncluded = incumbent.every((weight, i) => weight >= assets[i].minBps && weight <= assets[i].maxBps)
    && (policy.maxRiskScore === undefined || incumbent.reduce((sum, weight, i) => sum + weight * assets[i].riskScore!, 0) <= policy.maxRiskScore * TOTAL);
  const incumbentOffGrid = incumbentIncluded && incumbent.some((weight, i) => !choices[i].includes(weight));
  if (gridCandidates + Number(incumbentOffGrid) > ALLOCATION_CANDIDATE_LIMIT) throw new Error('Allocation search exceeds the bounded candidate limit; increase stepBps or narrow bounds');
  if (gridCandidates === 0 && !incumbentIncluded) throw new Error('No feasible allocation matches the grid or incumbent');
  const stats = policy.history ? prepareReturnStatistics(policy.history, ids) : undefined;
  let best: { weights: number[]; score: number; expectedReturnBps: number; risk: number | null; turnover: number } | undefined;
  let candidates = 0;
  let skippedZeroDenominator = 0;
  let excludedByRisk = 0;
  const hasRisk = assets.every(asset => asset.riskScore !== undefined);
  function visit(weights: readonly number[]): void {
    candidates++;
    let expectedReturnBps = 0;
    const riskNumerator = hasRisk ? weights.reduce((sum, weight, i) => sum + weight * assets[i].riskScore!, 0) : null;
    if (policy.maxRiskScore !== undefined && riskNumerator! > policy.maxRiskScore * TOTAL) { excludedByRisk++; return; }
    const risk = riskNumerator === null ? null : riskNumerator / TOTAL;
    let score: number;
    if (policy.objective === 'user-risk') {
      const forecastNumerator = weights.reduce((sum, weight, i) => sum + weight * assets[i].expectedReturnBps!, 0);
      const excessNumerator = forecastNumerator - policy.benchmarkReturnBps * TOTAL;
      expectedReturnBps = forecastNumerator / TOTAL;
      if (risk === 0) {
        if (excessNumerator > 0) throw new Error('Allocation needs input: a feasible positive-excess allocation has zero user risk; no finite optimum can be reported');
        skippedZeroDenominator++; return;
      }
      score = excessNumerator / TOTAL / risk!;
    } else {
      const fractions = weights.map(weight => weight / TOTAL);
      let mean = 0, excess = 0, variance = 0;
      for (let i = 0; i < ids.length; i++) {
        mean += fractions[i] * stats!.meanReturns[i];
        excess += fractions[i] * stats!.meanDifferentialReturns[i];
        for (let j = 0; j < ids.length; j++) variance += fractions[i] * fractions[j] * stats!.covariance[i][j];
      }
      expectedReturnBps = mean * TOTAL;
      if (variance <= stats!.varianceEpsilon) {
        if (excess > 0) throw new Error('Allocation needs input: a feasible positive-excess allocation has zero historical volatility; no finite Sharpe optimum can be reported');
        skippedZeroDenominator++; return;
      }
      score = excess / Math.sqrt(variance);
    }
    if (!Number.isFinite(score) || !Number.isFinite(expectedReturnBps) || (risk !== null && !Number.isFinite(risk))) throw new Error('Allocation objective is not finite');
    const turnover = weights.reduce((sum, weight, i) => sum + Math.abs(weight - incumbent[i]), 0);
    const tied = best !== undefined && Math.abs(score - best.score) <= ALLOCATION_SCORE_TOLERANCE;
    let lexical = false;
    if (best && tied && turnover === best.turnover) {
      for (let i = 0; i < weights.length; i++) { if (weights[i] !== best.weights[i]) { lexical = weights[i] < best.weights[i]; break; } }
    }
    if (!best || score > best.score + ALLOCATION_SCORE_TOLERANCE || (tied && (turnover < best.turnover || (turnover === best.turnover && lexical)))) {
      best = { weights: [...weights], score, expectedReturnBps, risk, turnover };
    }
  }
  const weights = new Array<number>(ids.length).fill(0);
  function enumerate(index: number, remaining: number): void {
    if (remaining < suffixMin[index] || remaining > suffixMax[index]) return;
    if (index === ids.length - 1) {
      const asset = assets[index];
      if (asset.minBps === asset.maxBps ? remaining === asset.minBps : (remaining - asset.minBps) % policy.stepBps === 0) {
        weights[index] = remaining; visit(weights);
      }
      return;
    }
    for (const weight of choices[index]) {
      if (count(index + 1, remaining - weight) === 0) continue;
      weights[index] = weight; enumerate(index + 1, remaining - weight);
    }
  }
  enumerate(0, TOTAL);
  if (incumbentOffGrid) visit(incumbent);
  if (!best) {
    if (candidates === excludedByRisk) throw new Error('No feasible allocation satisfies the grid and subjective risk limit');
    throw new Error('Allocation needs input: every feasible objective has an undefined zero denominator');
  }
  const selected = best as NonNullable<typeof best>;
  if (selected.weights.some((weight, i) => !Number.isSafeInteger(weight) || weight < assets[i].minBps || weight > assets[i].maxBps)
    || selected.weights.reduce((sum, weight) => sum + weight, 0) !== TOTAL
    || (policy.maxRiskScore !== undefined && selected.weights.reduce((sum, weight, i) => sum + weight * assets[i].riskScore!, 0) > policy.maxRiskScore * TOTAL)
    || candidates !== gridCandidates + Number(incumbentOffGrid)) throw new Error('Allocation solver invariant failed');
  const result: AllocationResult = {
    version: 1, solver: 'grid-v1', objective: policy.objective,
    targets: Object.fromEntries(ids.map((id, i) => [id, selected.weights[i]])), score: selected.score,
    expectedReturnBps: selected.expectedReturnBps, returnBasis: policy.objective === 'user-risk' ? 'user-horizon' : 'history-period',
    subjectiveRiskScore: selected.risk, policyHash: allocationPolicyHash(policy), candidates, stepBps: policy.stepBps,
    diagnostics: {
      search: 'grid+incumbent', scoreBasis: policy.objective === 'user-risk' ? 'horizon-excess-bps-per-user-risk-point' : 'historical-period-sharpe',
      horizonMonths: policy.horizonMonths, gridCandidates, incumbentIncluded, incumbentOffGrid, skippedZeroDenominator, excludedByRisk,
    },
  };
  if (stats) result.diagnostics.history = stats.diagnostics(selected.weights.map(weight => weight / TOTAL));
  return result;
}
