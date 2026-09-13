import { optimizeAllocation, validateAllocationPolicy, type AllocationPolicy, type AllocationResult } from './allocation.js';
import { validateManagedAllocation } from './allocation-management.js';
import { CONFIG_PATH, DATA, loadConfig, validateConfig, withUserRebalanceRequest, type Config } from './config.js';
import { acquireConfigLock } from './config-lock.js';
import { ledgerConfigFingerprint } from './ledger-request.js';
import { fetchSharpeHistory, type SharpeHistoryProvenance } from './sharpe-history.js';
import { atomicWriteJson } from './storage.js';

export type SharpeOptimizeOptions = { preset?: 'stock-usdg-1y'; preview?: boolean };
export type SharpeOptimizeDependencies = {
  readConfig: () => Promise<Config | null>;
  writeConfig: (config: Config) => Promise<void>;
  lock: () => Promise<() => Promise<void>>;
  fetchHistory: typeof fetchSharpeHistory;
  optimize: (policy: AllocationPolicy, targets: Config['targets']) => AllocationResult;
  now: () => Date;
};

const QUESTION = 'Use one year of daily adjusted underlying stock prices and actual USDG/USD prices, a zero-return benchmark and a 1% grid? Existing allocation bounds and risk limits will be retained; otherwise each asset may range from 0% to 100%.';

/** All portfolio scope comes from the routed CLI, never from another wallet's policy. */
export async function optimizeSharpeAllocation(options: SharpeOptimizeOptions = {},
    dependencies: Partial<SharpeOptimizeDependencies> = {}) {
  if (Object.keys(options).some(key => !['preset', 'preview'].includes(key)) ||
      (options.preset !== undefined && options.preset !== 'stock-usdg-1y') ||
      (options.preview !== undefined && typeof options.preview !== 'boolean')) {
    throw new Error('Use allocation optimize sharpe [--preset stock-usdg-1y] [--preview]');
  }
  const deps: SharpeOptimizeDependencies = {
    readConfig: loadConfig, writeConfig: config => atomicWriteJson(CONFIG_PATH, config),
    lock: () => acquireConfigLock(DATA), fetchHistory: fetchSharpeHistory, optimize: optimizeAllocation,
    now: () => new Date(), ...dependencies,
  };
  const loaded = await deps.readConfig();
  if (!loaded) throw new Error('Select and configure a portfolio before optimizing its allocation.');
  const original = structuredClone(validateConfig(loaded));
  const fingerprint = ledgerConfigFingerprint(original);
  const base = { app: 'Rebalance' as const, operation: 'allocation-optimize-sharpe' as const,
    wallet: original.wallet, chainId: original.chainId };
  const prior = original.allocation?.policy;
  if (!options.preset && prior?.objective !== 'sharpe') {
    return { ...base, outcome: 'needs-input' as const, applied: false as const,
      question: QUESTION, preset: 'stock-usdg-1y' as const };
  }
  let policy: AllocationPolicy;
  let provenance: SharpeHistoryProvenance | undefined;
  if (options.preset) {
    const assets = prior?.assets ?? Object.fromEntries(Object.keys(original.targets)
      .map(id => [id, { minBps: 0, maxBps: 10000 }]));
    // An existing bound is authority; the bundled grid cannot round it away.
    if (Object.values(assets).some(asset => asset.minBps !== asset.maxBps &&
        (asset.minBps % 100 !== 0 || asset.maxBps % 100 !== 0))) {
      return { ...base, outcome: 'needs-input' as const, applied: false as const,
        question: 'Saved bounds do not align with the 1% preset grid. Choose compatible bounds or retain a saved Sharpe policy through the bare command.' };
    }
    let fetched: Awaited<ReturnType<typeof fetchSharpeHistory>>;
    try { fetched = await deps.fetchHistory(Object.keys(original.targets), { now: deps.now() }); }
    catch {
      return { ...base, outcome: 'history-unavailable' as const, applied: false as const,
        message: 'The complete stock and USDG history could not be verified. No policy or targets were saved.' };
    }
    provenance = fetched.provenance;
    policy = validateAllocationPolicy({ ...(prior ?? { version: 1, horizonMonths: 12, benchmarkReturnBps: 0 }),
      objective: 'sharpe', stepBps: 100, assets, history: fetched.history }, Object.keys(original.targets));
  } else {
    // A bare request deliberately uses the saved frozen panel, even when old.
    policy = validateAllocationPolicy(prior, Object.keys(original.targets));
  }
  const history = policy.history!;
  const now = deps.now();
  if (history.basis === 'synthetic' || Date.parse(history.asOf) > now.getTime()) {
    throw new Error('Sharpe optimization requires non-synthetic history whose asOf is not in the future.');
  }
  let result: AllocationResult;
  try { result = deps.optimize(structuredClone(policy), structuredClone(original.targets)); }
  catch {
    return { ...base, outcome: 'needs-input' as const, applied: false as const,
      question: 'The selected history and constraints do not yield a finite feasible Sharpe optimum. Review the saved bounds, risk limit or history before retrying.' };
  }
  // Validate the prepared adoption without running the exhaustive solver twice.
  const allocation = validateManagedAllocation({ version: 1, policy, policyHash: result.policyHash,
    computedAt: now.toISOString(), result }, result.targets);
  const prepared = validateConfig({ ...original, allocation, targets: result.targets });
  const summary = { ...base, historySelection: options.preset ? 'refetched-preset' as const : 'saved-frozen' as const,
    ...(options.preset ? { preset: options.preset } : {}),
    history: { source: history.source, basis: history.basis, quoteCurrency: history.quoteCurrency,
      interval: history.interval, asOf: history.asOf, observationCount: history.observations.length,
      firstReturnDate: history.observations[0].date, lastReturnDate: history.observations.at(-1)!.date,
      benchmarkPeriodReturn: history.benchmarkPeriodReturn },
    assumptions: { stepBps: policy.stepBps, horizonMonths: policy.horizonMonths,
      assets: policy.assets, ...(policy.maxRiskScore === undefined ? {} : { maxRiskScore: policy.maxRiskScore }),
      ...(policy.riskDefinition === undefined ? {} : { riskDefinition: policy.riskDefinition }) },
    ...(provenance ? { provenance } : {}), targets: result.targets, score: result.score,
    scoreBasis: result.diagnostics.scoreBasis, annualized: false,
    search: result.diagnostics.search, candidates: result.candidates, policyHash: result.policyHash,
    computedAt: allocation.computedAt,
    interpretation: 'Historical maximum over the declared grid and feasible incumbent; not a forecast or a continuous optimum.' };
  if (options.preview) return { ...summary, outcome: 'preview' as const, applied: false as const };
  const release = await deps.lock();
  try {
    const current = await deps.readConfig();
    if (!current || ledgerConfigFingerprint(current) !== fingerprint) {
      return { ...base, outcome: 'config-changed' as const, applied: false as const,
        message: 'This portfolio changed during calculation. Run the command again against its current settings.' };
    }
    const next = withUserRebalanceRequest(prepared);
    await deps.writeConfig(next);
    return { ...summary, outcome: 'applied' as const, applied: true as const,
      effective: 'One explicit rebalance request; a running portfolio re-evaluates after pending transactions settle. A stopped portfolio stays stopped.' };
  } finally { await release(); }
}
