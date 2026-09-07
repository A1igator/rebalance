import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { allocationPolicyHash, type AllocationPolicy } from '../src/allocation.js';
import { allocationStatus, allocationSummary, previewAllocation, readAllocationInput,
  validateManagedAllocation, withAllocation, withoutAllocation, type ManagedAllocation } from '../src/allocation-management.js';
import { type ReturnHistory } from '../src/allocation-metrics.js';
import { validateConfig, type Config } from '../src/config.js';

const at = new Date('2026-09-07T12:00:00.000Z');
const targets = { USDG: 500, AAPL: 2375, NVDA: 2375, MSFT: 2375, AMD: 2375 };
function configuration(): Config {
  return { version: 1, chainId: 4663, wallet: '0x0000000000000000000000000000000000000001',
    mode: 'ledger', rpcUrl: 'http://allocation-fixture.invalid', targets: { ...targets },
    driftThresholdBps: 500, slippageBps: 50, deadlineSeconds: 120, pollSeconds: 30,
    rebalanceIntervalSeconds: 3600 };
}
function policy(): AllocationPolicy {
  return { version: 1, objective: 'user-risk', horizonMonths: 60, stepBps: 500, benchmarkReturnBps: 0,
    assets: Object.fromEntries(Object.keys(targets).map((id, index) => [id, id === 'USDG'
      ? { riskScore: 2, expectedReturnBps: 0, minBps: 500, maxBps: 500 }
      : { riskScore: 40, expectedReturnBps: (5 - index) * 500, minBps: 0, maxBps: 4000 }])) };
}
function history(basis: ReturnHistory['basis'] = 'underlying-proxy'): ReturnHistory {
  return { source: 'Explicit isolated historical fixture; no remote provider', basis,
    quoteCurrency: 'USDG', interval: 'daily', asOf: '2026-09-06T00:00:00.000Z', benchmarkPeriodReturn: 0.001,
    observations: Array.from({ length: 20 }, (_, index) => ({
      date: `2026-08-${String(index + 1).padStart(2, '0')}`,
      returns: Object.fromEntries(Object.keys(targets).map((id, asset) => [id,
        id === 'USDG' ? 0 : ((index % 3) - 1) * 0.01 + asset * 0.001])),
    })) };
}
function managed(input = policy()): Config & { allocation: ManagedAllocation } {
  return withAllocation(configuration(), input, at) as Config & { allocation: ManagedAllocation };
}
function rehash(saved: ManagedAllocation): void {
  saved.policyHash = allocationPolicyHash(saved.policy);
  saved.result.policyHash = saved.policyHash;
}

// These use public, fabricated configuration and aligned return fixtures only.
test('preview leaves configuration unchanged and adoption records exact computed targets and assumptions', () => {
  const config = configuration(); const input = policy();
  const before = structuredClone({ config, input });
  const preview = previewAllocation(config, input);
  assert.equal(preview.changesTargets, false);
  assert.equal(preview.mode, 'preview');
  assert.equal(preview.wallet, config.wallet);
  assert.deepEqual({ config, input }, before);
  const adopted = withAllocation(config, input, at);
  assert.deepEqual(adopted.targets, preview.result.targets);
  assert.deepEqual(adopted.allocation?.result, preview.result);
  assert.equal(adopted.allocation?.computedAt, at.toISOString());
  assert.equal(adopted.allocation?.policyHash, allocationPolicyHash(input));
  assert.deepEqual(validateConfig(adopted), adopted);
  assert.deepEqual({ config, input }, before);
});

test('horizon changes provenance without inventing compounded forecasts or changing supplied risk', () => {
  const shorter = policy(); const longer = { ...shorter, horizonMonths: 120 };
  const first = managed(shorter); const second = managed(longer);
  assert.notEqual(first.allocation.policyHash, second.allocation.policyHash);
  assert.deepEqual(first.targets, second.targets);
  assert.equal(first.allocation.result.score, second.allocation.result.score);
  assert.equal(first.allocation.result.expectedReturnBps, second.allocation.result.expectedReturnBps);
  assert.equal(second.allocation.result.returnBasis, 'user-horizon');
  assert.equal(second.allocation.result.diagnostics.horizonMonths, 120);
  assert.deepEqual(second.allocation.policy.assets, first.allocation.policy.assets);
  assert.equal(allocationPolicyHash({ ...shorter, assets: Object.fromEntries(Object.entries(shorter.assets).reverse()) }),
    first.allocation.policyHash);
});

test('saved policy, result and adopted target mismatches are rejected', async t => {
  const cases: [string, (saved: ManagedAllocation) => void][] = [
    ['policy changed without rehash', saved => { saved.policy.horizonMonths++; }],
    ['policy hash changed', saved => { saved.policyHash = '0'.repeat(64); }],
    ['result hash changed', saved => { saved.result.policyHash = '0'.repeat(64); }],
    ['result objective changed', saved => { saved.result.objective = 'sharpe'; }],
    ['result version changed', saved => { (saved.result as { version: number }).version = 2; }],
    ['nonfinite score', saved => { saved.result.score = Infinity; }],
    ['nonfinite forecast', saved => { saved.result.expectedReturnBps = NaN; }],
    ['return label changed', saved => { saved.result.returnBasis = 'history-period'; }],
    ['grid step changed', saved => { saved.result.stepBps = 1000; }],
    ['invalid computed timestamp', saved => { saved.computedAt = 'not-a-date'; }],
    ['result target changed', saved => { saved.result.targets.USDG++; }],
  ];
  for (const [name, mutate] of cases) await t.test(name, () => {
    const config = managed();
    // The persisted JSON representation has independent target objects.
    const saved = structuredClone(config.allocation);
    mutate(saved);
    assert.throws(() => validateManagedAllocation(saved, config.targets));
    assert.throws(() => validateConfig({ ...config, allocation: saved }));
  });
});

test('changing both copies of targets cannot bypass saved policy bounds', () => {
  const config = managed();
  config.targets = { USDG: 500, AAPL: 4500, NVDA: 2000, MSFT: 1500, AMD: 1500 };
  config.allocation.result.targets = { ...config.targets };
  assert.throws(() => validateManagedAllocation(config.allocation, config.targets), /bounds/);
});

test('changing both target copies within individual bounds cannot bypass the aggregate subjective risk cap', () => {
  const input = policy(); input.maxRiskScore = 40;
  for (const [id, asset] of Object.entries(input.assets)) asset.riskScore = id === 'AAPL' ? 100 : id === 'USDG' ? 2 : 10;
  const config = managed(input);
  assert.ok(config.allocation.result.subjectiveRiskScore! <= 40);
  config.targets = { USDG: 500, AAPL: 4000, NVDA: 2000, MSFT: 2000, AMD: 1500 };
  config.allocation.result.targets = { ...config.targets };
  assert.equal(Object.values(config.targets).reduce((a, b) => a + b, 0), 10000);
  assert.throws(() => validateManagedAllocation(config.allocation, config.targets), /risk limit/);
});

test('absence of a risk cap does not impose an invented limit on an otherwise valid policy', () => {
  const input = policy();
  for (const asset of Object.values(input.assets)) asset.riskScore = 100;
  const config = managed(input);
  assert.equal(config.allocation.result.subjectiveRiskScore, 100);
  assert.deepEqual(validateManagedAllocation(config.allocation, config.targets), config.allocation);
});

test('optional history preserves the subjective objective and adds explicitly historical diagnostics', () => {
  const input = policy(); const plain = managed(input);
  input.history = history(); const observed = managed(input);
  assert.deepEqual(observed.targets, plain.targets);
  assert.equal(observed.allocation.result.score, plain.allocation.result.score);
  assert.equal(observed.allocation.result.returnBasis, 'user-horizon');
  assert.equal(observed.allocation.result.diagnostics.scoreBasis, 'horizon-excess-bps-per-user-risk-point');
  assert.equal(observed.allocation.result.diagnostics.history?.basis, 'underlying-proxy');
  assert.equal(observed.allocation.result.diagnostics.history?.annualized, false);
  assert.notEqual(observed.allocation.policyHash, plain.allocation.policyHash);
});

test('synthetic history can be previewed but cannot be adopted or restored as a managed policy', () => {
  const input = policy(); input.history = history('synthetic');
  const config = configuration(); const before = structuredClone(config);
  assert.equal(previewAllocation(config, input).result.diagnostics.history?.basis, 'synthetic');
  assert.throws(() => withAllocation(config, input, at), /Synthetic history/);
  assert.deepEqual(config, before);
  input.history.basis = 'underlying-proxy';
  const saved = managed(input);
  saved.allocation.policy.history!.basis = 'synthetic'; rehash(saved.allocation);
  assert.throws(() => validateManagedAllocation(saved.allocation, saved.targets), /Synthetic history/);
});

test('future dated history cannot be adopted even as optional subjective-objective diagnostics', () => {
  const input = policy(); input.history = history(); input.history.asOf = '2026-09-08T00:00:00.000Z';
  assert.throws(() => withAllocation(configuration(), input, at), /future/);
  input.history.asOf = at.toISOString();
  assert.doesNotThrow(() => withAllocation(configuration(), input, at));
});

test('saved history cannot claim information later than its recorded computation', () => {
  const input = policy(); input.history = history(); const config = managed(input);
  config.allocation.computedAt = '2026-09-05T00:00:00.000Z';
  assert.throws(() => validateManagedAllocation(config.allocation, config.targets), /future|history|History|inconsistent/);
});

test('saved score diagnostics must preserve the objective and investment horizon labels', () => {
  for (const change of [
    (saved: ManagedAllocation) => { saved.result.diagnostics.scoreBasis = 'historical-period-sharpe'; },
    (saved: ManagedAllocation) => { saved.result.diagnostics.horizonMonths = 1; },
  ]) {
    const config = managed(); change(config.allocation);
    assert.throws(() => validateManagedAllocation(config.allocation, config.targets), /inconsistent/);
  }
});

test('status projections do not inspect inputs or recalculate an allocation', () => {
  const config = managed(); const saved = config.allocation;
  const score = saved.result.score;
  // Status uses the recorded decision; touching objective inputs would reveal a
  // hidden attempt to validate history or rerun allocation during a display read.
  Object.defineProperty(saved.policy, 'assets', { get() { throw new Error('status inspected solver inputs'); } });
  Object.defineProperty(saved.policy, 'history', { get() { throw new Error('status inspected historical inputs'); } });
  const status = allocationStatus(config);
  assert.equal(status.mode, 'managed'); assert.equal(status.allocation, saved);
  assert.equal(status.targets, config.targets);
  assert.deepEqual(allocationSummary(config), { objective: 'user-risk', horizonMonths: 60,
    policyHash: saved.policyHash, computedAt: at.toISOString(), score, stepBps: 500 });
});

test('manual mode removes only saved management provenance and preserves adopted targets', () => {
  const config = managed(); const before = structuredClone(config);
  const manual = withoutAllocation(config);
  assert.equal(manual.allocation, undefined);
  assert.deepEqual(manual.targets, config.targets);
  assert.deepEqual(manual, Object.fromEntries(Object.entries(config).filter(([key]) => key !== 'allocation')));
  assert.deepEqual(config, before);
  assert.equal(allocationStatus(manual).mode, 'manual');
  assert.equal(allocationStatus(manual).allocation, null);
  assert.equal(allocationSummary(manual), undefined);
});

test('policy files are parsed as bounded regular-file JSON without executing content', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rebalance-allocation-management-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, 'policy.json');
  const value = { userAssumption: '$(touch never-run); `not code`' };
  const bytes = JSON.stringify(value);
  await writeFile(input, bytes + ' '.repeat(1_048_576 - Buffer.byteLength(bytes)));
  assert.deepEqual(await readAllocationInput(input), value);
  await writeFile(input, bytes + ' '.repeat(1_048_577 - Buffer.byteLength(bytes)));
  await assert.rejects(readAllocationInput(input), /at most 1 MiB/);
  await writeFile(input, '{invalid JSON');
  await assert.rejects(readAllocationInput(input), /valid JSON/);
  await assert.rejects(readAllocationInput(directory), /JSON file/);
  await assert.rejects(readAllocationInput(join(directory, 'missing.json')), /ENOENT/);
});
