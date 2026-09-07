import { open } from 'node:fs/promises';
import { allocationPolicyHash, optimizeAllocation, validateAllocationPolicy, type AllocationPolicy, type AllocationResult } from './allocation.js';
import type { Config } from './config.js';

export type ManagedAllocation = {
  version: 1;
  policy: AllocationPolicy;
  policyHash: string;
  computedAt: string;
  result: AllocationResult;
};

const equalTargets = (a: Record<string, number>, b: Record<string, number>) =>
  Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(id => a[id] === b[id]);

/** Validate persisted provenance cheaply; never run the solver on a display/market tick. */
export function validateManagedAllocation(value: unknown, targets: Record<string, number>): ManagedAllocation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid saved allocation policy');
  const saved = value as ManagedAllocation;
  const policy = validateAllocationPolicy(saved.policy, Object.keys(targets));
  const hash = allocationPolicyHash(policy);
  if (policy.history?.basis === 'synthetic') throw new Error('Synthetic history is preview-only; it cannot be a saved allocation policy');
  if (saved.version !== 1 || saved.policyHash !== hash || typeof saved.computedAt !== 'string' ||
      !Number.isFinite(Date.parse(saved.computedAt)) || !saved.result || saved.result.version !== 1 ||
      saved.result.solver !== 'grid-v1' || saved.result.policyHash !== hash || saved.result.objective !== policy.objective ||
      typeof saved.result.score !== 'number' || !Number.isFinite(saved.result.score) ||
      !Number.isFinite(saved.result.expectedReturnBps) || saved.result.stepBps !== policy.stepBps ||
      saved.result.returnBasis !== (policy.objective === 'user-risk' ? 'user-horizon' : 'history-period') ||
      !saved.result.diagnostics || saved.result.diagnostics.horizonMonths !== policy.horizonMonths ||
      saved.result.diagnostics.scoreBasis !== (policy.objective === 'user-risk'
        ? 'horizon-excess-bps-per-user-risk-point' : 'historical-period-sharpe') ||
      (policy.history !== undefined && Date.parse(policy.history.asOf) > Date.parse(saved.computedAt)) ||
      !saved.result.targets || !equalTargets(saved.result.targets, targets)) {
    throw new Error('Saved allocation policy and targets are inconsistent');
  }
  for (const [id, weight] of Object.entries(targets)) {
    if (weight < policy.assets[id]!.minBps || weight > policy.assets[id]!.maxBps) {
      throw new Error('Saved targets violate allocation bounds');
    }
  }
  if (policy.maxRiskScore !== undefined && Object.entries(targets).reduce((sum, [id, weight]) =>
      sum + weight * policy.assets[id]!.riskScore!, 0) > policy.maxRiskScore * 10000) {
    throw new Error('Saved targets violate the subjective risk limit');
  }
  return { ...saved, policy };
}

export function withoutAllocation(config: Config): Config {
  const { allocation: _allocation, ...manual } = config;
  return manual;
}

export function previewAllocation(config: Config, input: unknown) {
  const policy = validateAllocationPolicy(input, Object.keys(config.targets));
  const result = optimizeAllocation(policy, config.targets);
  return { mode: 'preview' as const, wallet: config.wallet, policy, result, changesTargets: false };
}

/** Call under config.lock; policy and adopted targets become one atomic revision. */
export function withAllocation(config: Config, input: unknown, now = new Date()): Config {
  const preview = previewAllocation(config, input);
  if (preview.policy.history?.basis === 'synthetic') throw new Error('Synthetic history is preview-only; it cannot set portfolio targets');
  if (preview.policy.history && Date.parse(preview.policy.history.asOf) > now.getTime()) {
    throw new Error('History asOf cannot be in the future');
  }
  return { ...config, targets: preview.result.targets, allocation: {
    version: 1, policy: preview.policy, policyHash: preview.result.policyHash,
    computedAt: now.toISOString(), result: preview.result,
  } };
}

export function allocationStatus(config: Config) {
  return { mode: config.allocation ? 'managed' as const : 'manual' as const,
    wallet: config.wallet, targets: config.targets, allocation: config.allocation ?? null };
}

/** Policy input is bounded JSON supplied through the agent, never a program or remote URL. */
export async function readAllocationInput(path: string): Promise<unknown> {
  const file = await open(path, 'r');
  try {
    const maximum = 1_048_576;
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maximum) throw new Error('Allocation policy must be a JSON file of at most 1 MiB');
    const bytes = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maximum) throw new Error('Allocation policy must be at most 1 MiB');
    try { return JSON.parse(bytes.subarray(0, length).toString('utf8')); }
    catch { throw new Error('Allocation policy must contain valid JSON'); }
  } finally { await file.close(); }
}

/** Small public status projection; full assumptions remain available through allocation status. */
export function allocationSummary(config: Config) {
  const managed = config.allocation;
  const history = managed?.result.diagnostics.history;
  return managed ? { objective: managed.policy.objective, horizonMonths: managed.policy.horizonMonths,
    policyHash: managed.policyHash, computedAt: managed.computedAt, score: managed.result.score,
    stepBps: managed.policy.stepBps, subjectiveRiskScore: managed.result.subjectiveRiskScore,
    expectedReturnBps: managed.result.expectedReturnBps, returnBasis: managed.result.returnBasis,
    // The policy benchmark shares the user's horizon, never a historical period.
    benchmarkReturnBps: managed.result.returnBasis === 'user-horizon' ? managed.policy.benchmarkReturnBps : null,
    ...(history ? { history: { interval: history.interval, basis: history.basis,
      asOf: history.asOf, quoteCurrency: history.quoteCurrency } } : {}) } : undefined;
}
