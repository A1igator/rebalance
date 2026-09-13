import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { optimizeAllocation, type AllocationPolicy } from '../src/allocation.js';
import { withAllocation } from '../src/allocation-management.js';
import { optimizeSharpeAllocation, type SharpeOptimizeDependencies } from '../src/allocation-sharpe.js';
import type { ReturnHistory } from '../src/allocation-metrics.js';
import { acquireConfigLock } from '../src/config-lock.js';
import { validateConfig, type Config } from '../src/config.js';
import { SharpeHistoryError, type SharpeHistoryFailure, type SharpeHistoryProvenance } from '../src/sharpe-history.js';
import { atomicWriteJson, readJson } from '../src/storage.js';
import { assertTemporaryTestDirectory } from '../src/test-isolation.js';

const now = new Date('2026-09-13T12:00:00.000Z');
const wallet = '0x0000000000000000000000000000000000000001';
const targets = { USDG: 500, AAPL: 2375, NVDA: 2375, MSFT: 2375, AMD: 2375 };
const configuration = () => validateConfig({ version: 1, chainId: 4663, wallet, mode: 'ledger', execution: 'simple7702',
  rpcUrl: 'https://allocation-fixture.invalid', targets, driftThresholdBps: 500, slippageBps: 75,
  deadlineSeconds: 120, pollSeconds: 30, rebalanceIntervalSeconds: 3600, rebalanceFeeTargetUsdE8: '5000000' });
const history = (): ReturnHistory => ({ source: 'Offline adjusted-stock and USDG-price fixture',
  basis: 'underlying-proxy', quoteCurrency: 'USD', interval: 'daily', asOf: '2026-01-21T00:00:00.000Z', benchmarkPeriodReturn: 0,
  observations: Array.from({ length: 20 }, (_, i) => ({ date: `2026-01-${String(i + 1).padStart(2, '0')}`,
    returns: Object.fromEntries(Object.keys(targets).map((id, index) => [id,
      (id === 'USDG' ? 0.00001 : 0.001 * index) + (id === 'USDG' ? 0.0001 : 0.01) * (i % 5 - 2)])) })) });
const provenance = (): SharpeHistoryProvenance => ({ preset: 'stock-usdg-1y', fetchedAt: now.toISOString(),
  firstCloseDate: '2025-12-31', firstReturnDate: '2026-01-01', lastReturnDate: '2026-01-20', observationCount: 20,
  historySha256: 'a'.repeat(64), sources: { stocks: { AAPL: 'https://fixture.invalid/AAPL' }, usdg: 'https://fixture.invalid/USDG' },
  stockPriceBasis: 'Yahoo split/dividend-adjusted underlying share close', cashPriceBasis: 'Kraken USDG/USD daily close',
  dateAlignment: 'Common equity calendar dates; US equity and UTC USDG closes differ; no filling or interpolation' });
function fixedPolicy(objective: AllocationPolicy['objective'] = 'sharpe'): AllocationPolicy {
  return { version: 1, objective, horizonMonths: 60, stepBps: 500, benchmarkReturnBps: 120,
    maxRiskScore: 60, riskDefinition: 'User long-term impairment assessment',
    assets: Object.fromEntries(Object.entries(targets).map(([id, weight]) => [id,
      { minBps: weight, maxBps: weight, riskScore: id === 'USDG' ? 2 : 40, expectedReturnBps: 500, rationale: 'Retain this boundary' }])),
    ...(objective === 'sharpe' ? { history: history() } : {}) };
}
async function fixture(t: TestContext, config = configuration()) {
  const root = await mkdtemp(join(tmpdir(), 'rebalance-sharpe-orchestration-'));
  assertTemporaryTestDirectory(root); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'config.json'); await atomicWriteJson(path, config);
  const calls = { fetch: 0, optimize: 0, lock: 0, write: 0 };
  const deps: SharpeOptimizeDependencies = {
    readConfig: async () => validateConfig(await readJson(path)),
    writeConfig: async next => { calls.write++; assert.equal(existsSync(join(root, 'config.lock')), true); await atomicWriteJson(path, next); },
    lock: async () => { calls.lock++; return acquireConfigLock(root); }, now: () => now,
    fetchHistory: async () => { calls.fetch++; assert.equal(existsSync(join(root, 'config.lock')), false);
      return { history: history(), provenance: provenance() }; },
    optimize: (policy, current) => { calls.optimize++; assert.equal(existsSync(join(root, 'config.lock')), false); return optimizeAllocation(policy, current); },
  };
  return { root, path, calls, deps, bytes: () => readFile(path, 'utf8'), saved: async () => validateConfig(await readJson(path)) };
}

test('bare manual/user-risk portfolios ask for the explicit preset without fetch, solve, lock or write', async t => {
  for (const config of [configuration(), withAllocation(configuration(), fixedPolicy('user-risk'), now)]) {
    const f = await fixture(t, config); const before = await f.bytes();
    const result = await optimizeSharpeAllocation({}, f.deps);
    assert.equal(result.outcome, 'needs-input'); assert.equal(result.applied, false);
    assert.ok('question' in result && result.question.includes('actual USDG/USD'));
    assert.ok('presetRequiresNetwork' in result && result.presetRequiresNetwork === true);
    assert.equal(await f.bytes(), before); assert.deepEqual(f.calls, { fetch: 0, optimize: 0, lock: 0, write: 0 });
  }
});

test('bare saved Sharpe reuses frozen history and constraints without fetching; preview is byte-identical', async t => {
  const f = await fixture(t, withAllocation(configuration(), fixedPolicy(), now)); const before = await f.bytes();
  const result = await optimizeSharpeAllocation({ preview: true }, f.deps);
  assert.equal(result.outcome, 'preview'); assert.equal(result.applied, false);
  assert.ok('history' in result); assert.equal(result.historySelection, 'saved-frozen');
  assert.equal(result.history.asOf, history().asOf); assert.equal(result.history.observationCount, 20);
  assert.equal(result.history.firstReturnDate, '2026-01-01'); assert.equal(result.history.lastReturnDate, '2026-01-20');
  assert.equal(result.assumptions.stepBps, 500); assert.equal(result.assumptions.horizonMonths, 60);
  assert.equal(JSON.stringify(result).includes('observations'), false);
  assert.equal(await f.bytes(), before); assert.deepEqual(f.calls, { fetch: 0, optimize: 1, lock: 0, write: 0 });
});

test('saved-history score labels preserve the observation interval without annualizing', async t => {
  for (const interval of ['daily', 'weekly', 'monthly'] as const) {
    const policy = fixedPolicy(); policy.history!.interval = interval;
    const config = withAllocation(configuration(), policy, now);
    const f = await fixture(t, config); const before = await f.bytes();
    const result = await optimizeSharpeAllocation({ preview: true }, f.deps);
    assert.ok('scoreLabel' in result);
    assert.equal(result.scoreLabel, `${interval} historical Sharpe (not annualized)`);
    assert.equal(result.annualized, false);
    assert.equal(result.pathConvention, 'constant-weight-per-observation');
    assert.equal(result.score, config.allocation!.result.score);
    assert.equal(await f.bytes(), before);
    assert.deepEqual(f.calls, { fetch: 0, optimize: 1, lock: 0, write: 0 });
  }
});

test('explicit preset includes cash in the unconstrained 1% grid and does not infer bounds from manual targets', async t => {
  const f = await fixture(t); const before = await f.bytes();
  const result = await optimizeSharpeAllocation({ preset: 'stock-usdg-1y', preview: true }, f.deps);
  assert.equal(result.outcome, 'preview'); assert.ok('assumptions' in result);
  for (const asset of Object.values(result.assumptions.assets)) assert.deepEqual(asset, { minBps: 0, maxBps: 10000 });
  assert.equal(result.assumptions.stepBps, 100); assert.equal(result.history.benchmarkPeriodReturn, 0);
  assert.equal(result.search, 'grid+incumbent'); assert.equal(result.annualized, false);
  assert.equal(result.scoreLabel, 'daily historical Sharpe (not annualized)');
  assert.equal(result.pathConvention, 'constant-weight-per-observation');
  assert.equal(Object.values(result.targets).reduce((a, b) => a + b, 0), 10000);
  assert.equal(await f.bytes(), before); assert.deepEqual(f.calls, { fetch: 1, optimize: 1, lock: 0, write: 0 });
});

test('preset preserves prior user constraints and atomically adopts policy, targets and one request without changing execution state', async t => {
  const original = withAllocation(configuration(), fixedPolicy('user-risk'), now);
  const f = await fixture(t, original);
  const markers = ['stop.json', 'pending.json', 'recovery.json', 'cycle.json', 'runner-preference.json', 'ledger-request.json', 'run.lock'];
  for (const file of markers) await atomicWriteJson(join(f.root, file), { fixture: file });
  const beforeMarkers = await Promise.all(markers.map(file => readFile(join(f.root, file), 'utf8')));
  const result = await optimizeSharpeAllocation({ preset: 'stock-usdg-1y' }, f.deps);
  assert.equal(result.outcome, 'applied'); assert.equal(result.applied, true);
  const saved = await f.saved(); assert.ok(saved.allocation);
  assert.deepEqual(saved.allocation.policy.assets, original.allocation!.policy.assets);
  assert.equal(saved.allocation.policy.maxRiskScore, 60); assert.equal(saved.allocation.policy.riskDefinition, fixedPolicy().riskDefinition);
  assert.equal(saved.allocation.policy.horizonMonths, 60); assert.equal(saved.allocation.policy.stepBps, 100);
  assert.equal(saved.allocation.policy.benchmarkReturnBps, 120); assert.equal(saved.allocation.policy.history!.benchmarkPeriodReturn, 0);
  assert.deepEqual(saved.targets, saved.allocation.result.targets); assert.equal(saved.allocation.policyHash, saved.allocation.result.policyHash);
  assert.match(saved.rebalanceRequestId!, /^[a-f0-9-]{36}$/);
  const { allocation: _a, targets: _t, rebalanceRequestId: _r, ...rest } = saved;
  const { allocation: _old, targets: _oldTargets, ...originalRest } = original;
  assert.deepEqual(rest, originalRest);
  assert.deepEqual(await Promise.all(markers.map(file => readFile(join(f.root, file), 'utf8'))), beforeMarkers);
  assert.deepEqual(f.calls, { fetch: 1, optimize: 1, lock: 1, write: 1 });
  assert.deepEqual((await readdir(f.root)).sort(), ['config.json', ...markers].sort());
});

test('bare applied optimization mints once per explicit invocation, while subsequent preview/status preserve it', async t => {
  const f = await fixture(t, withAllocation(configuration(), fixedPolicy(), now));
  await optimizeSharpeAllocation({}, f.deps); const first = await f.saved();
  await optimizeSharpeAllocation({ preview: true }, f.deps); assert.equal((await f.saved()).rebalanceRequestId, first.rebalanceRequestId);
  await optimizeSharpeAllocation({}, f.deps); assert.notEqual((await f.saved()).rebalanceRequestId, first.rebalanceRequestId);
  assert.equal(f.calls.fetch, 0);
});

test('concurrent setting, target or wallet edits during solving cancel adoption without overwriting the newer config', async t => {
  for (const update of [(c: Config) => ({ ...c, slippageBps: c.slippageBps + 1 }),
    (c: Config) => ({ ...c, targets: { ...c.targets, AAPL: 3000, AMD: 1750 }, allocation: undefined }),
    (c: Config) => ({ ...c, wallet: '0x0000000000000000000000000000000000000002' as const })]) {
    const f = await fixture(t, withAllocation(configuration(), fixedPolicy(), now));
    const originalLock = f.deps.lock;
    f.deps.lock = async () => { await atomicWriteJson(f.path, update(await f.saved())); return originalLock(); };
    const result = await optimizeSharpeAllocation({}, f.deps);
    assert.equal(result.outcome, 'config-changed'); assert.equal(result.applied, false); assert.equal(f.calls.write, 0);
    assert.equal((await f.saved()).rebalanceRequestId, undefined);
  }
});

test('history failure and infeasible/zero-variance solve do not write or acquire a lock', async t => {
  const f = await fixture(t, withAllocation(configuration(), fixedPolicy(), now)); const before = await f.bytes();
  f.deps.fetchHistory = async () => { throw new Error('secret provider payload must not escape'); };
  const failed = await optimizeSharpeAllocation({ preset: 'stock-usdg-1y' }, f.deps);
  assert.equal(failed.outcome, 'history-unavailable'); assert.equal(JSON.stringify(failed).includes('secret'), false);
  f.deps.optimize = () => { throw new Error('no feasible result'); };
  assert.equal((await optimizeSharpeAllocation({}, f.deps)).outcome, 'needs-input');
  assert.equal(await f.bytes(), before); assert.equal(f.calls.lock, 0); assert.equal(f.calls.write, 0);
});

test('incompatible saved variable bounds are preserved and require input before a preset fetch', async t => {
  const policy = fixedPolicy('user-risk'); policy.stepBps = 250;
  policy.assets.AAPL = { ...policy.assets.AAPL!, minBps: 2250, maxBps: 3000 };
  policy.assets.AMD = { ...policy.assets.AMD!, minBps: 1750, maxBps: 2500 };
  const f = await fixture(t, withAllocation(configuration(), policy, now)); const before = await f.bytes();
  const result = await optimizeSharpeAllocation({ preset: 'stock-usdg-1y' }, f.deps);
  assert.equal(result.outcome, 'needs-input'); assert.equal(await f.bytes(), before); assert.equal(f.calls.fetch, 0);
});

test('invalid options and future history fail before adoption', async t => {
  const f = await fixture(t, withAllocation(configuration(), fixedPolicy(), now)); const before = await f.bytes();
  await assert.rejects(optimizeSharpeAllocation({ preset: 'other' } as never, f.deps), /Use allocation/);
  await assert.rejects(optimizeSharpeAllocation({ background: true } as never, f.deps), /Use allocation/);
  f.deps.fetchHistory = async () => ({ history: { ...history(), asOf: '2027-01-01' }, provenance: provenance() });
  await assert.rejects(optimizeSharpeAllocation({ preset: 'stock-usdg-1y' }, f.deps), /not in the future/);
  assert.equal(await f.bytes(), before); assert.equal(f.calls.write, 0);
});


test('sanitized history failure projection leaves configuration byte-identical and never solves or locks', async t => {
  const cases: SharpeHistoryFailure[] = [
    { code: 'network-access-denied' }, { code: 'network-unavailable' }, { code: 'timeout' }, { code: 'invalid-history' },
    { code: 'provider-http', provider: 'yahoo', status: 403 },
    { code: 'provider-http', provider: 'yahoo', status: 429 },
    { code: 'provider-http', provider: 'kraken', status: 503 },
  ];
  for (const failure of cases) await t.test(JSON.stringify(failure), async () => {
    const f = await fixture(t); const before = await f.bytes();
    f.deps.fetchHistory = async () => {
      f.calls.fetch++;
      throw new SharpeHistoryError(failure, 'secret provider payload https://private.invalid');
    };
    const result = await optimizeSharpeAllocation({ preset: 'stock-usdg-1y' }, f.deps);
    assert.equal(result.outcome, 'history-unavailable'); assert.equal(result.applied, false);
    assert.ok('failure' in result); assert.deepEqual(result.failure, failure);
    assert.match(result.message, /No policy or targets were saved/);
    assert.doesNotMatch(JSON.stringify(result), /secret|private.invalid|https:/);
    if (failure.code === 'network-access-denied') assert.match(result.message, /network permissions denied/);
    if (failure.code === 'network-unavailable') assert.match(result.message, /could not be reached/);
    assert.deepEqual(f.calls, { fetch: 1, optimize: 0, lock: 0, write: 0 });
    assert.equal(await f.bytes(), before);
    assert.deepEqual(await readdir(f.root), ['config.json']);
  });
});
