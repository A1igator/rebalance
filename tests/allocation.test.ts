import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allocationPolicyHash, optimizeAllocation, validateAllocationPolicy, type AllocationPolicy } from '../src/allocation.js';
import { prepareReturnStatistics, type ReturnHistory } from '../src/allocation-metrics.js';

const current = { A: 5000, B: 5000 };
function policy(): AllocationPolicy {
  return { version: 1, objective: 'user-risk', horizonMonths: 60, stepBps: 500, benchmarkReturnBps: 0,
    assets: {
      A: { riskScore: 80, expectedReturnBps: 2000, minBps: 0, maxBps: 10000 },
      B: { riskScore: 10, expectedReturnBps: 700, minBps: 0, maxBps: 10000 },
    } };
}
function history(series: (index: number) => Record<string, number> = i => ({ A: i % 2 ? .05 : -.03, B: i % 2 ? .01 : .005 })): ReturnHistory {
  return { source: 'Synthetic arithmetic fixture; not market observations', basis: 'synthetic', quoteCurrency: 'USDG', interval: 'daily',
    asOf: '2026-08-20', benchmarkPeriodReturn: 0,
    observations: Array.from({ length: 20 }, (_, i) => ({ date: `2026-08-${String(i + 1).padStart(2, '0')}`, returns: series(i) })) };
}
function assertFinite(value: unknown): void {
  if (typeof value === 'number') assert.ok(Number.isFinite(value));
  else if (Array.isArray(value)) value.forEach(assertFinite);
  else if (value && typeof value === 'object') Object.values(value).forEach(assertFinite);
}

test('subjective risk, horizon forecasts and benchmark determine the labeled user-risk objective', () => {
  const input = policy();
  const before = structuredClone(input);
  const result = optimizeAllocation(input, current);
  assert.deepEqual(result.targets, { A: 0, B: 10000 });
  assert.equal(result.expectedReturnBps, 700); assert.equal(result.subjectiveRiskScore, 10); assert.equal(result.score, 70);
  assert.equal(result.returnBasis, 'user-horizon'); assert.equal(result.diagnostics.scoreBasis, 'horizon-excess-bps-per-user-risk-point');
  assert.equal(result.candidates, 21); assert.equal(result.diagnostics.gridCandidates, 21);
  assert.deepEqual(input, before); assert.deepEqual(current, { A: 5000, B: 5000 });
  input.assets.B.riskScore = 100;
  assert.deepEqual(optimizeAllocation(input, current).targets, { A: 10000, B: 0 });
  input.assets.B.riskScore = 10; input.benchmarkReturnBps = 1000;
  assert.deepEqual(optimizeAllocation(input, current).targets, { A: 10000, B: 0 });
});

test('optional statistics never replace or alter user-defined risk scores and return assumptions', () => {
  const plain = policy();
  const withHistory = { ...plain, history: history() };
  const result = optimizeAllocation(withHistory, current);
  const baseline = optimizeAllocation(plain, current);
  assert.deepEqual(result.targets, baseline.targets); assert.equal(result.score, baseline.score);
  assert.equal(result.subjectiveRiskScore, baseline.subjectiveRiskScore);
  assert.equal(result.diagnostics.history?.basis, 'synthetic');
  assert.equal(result.diagnostics.history?.annualized, false);
  assert.notEqual(result.policyHash, baseline.policyHash);
  assertFinite(result);
});

test('user risk definition and rationale are retained provenance without changing optimization', () => {
  const plain = policy();
  const described = policy();
  described.riskDefinition = 'Permanent loss of capital over five years';
  described.assets.B.rationale = 'My confidence is based on long-term usefulness, not daily volatility.';
  const validated = validateAllocationPolicy(described, ['A', 'B']);
  assert.equal(validated.riskDefinition, described.riskDefinition);
  assert.equal(validated.assets.B.rationale, described.assets.B.rationale);
  assert.deepEqual(optimizeAllocation(described, current).targets, optimizeAllocation(plain, current).targets);
  assert.notEqual(allocationPolicyHash(described), allocationPolicyHash(plain));
  assert.throws(() => validateAllocationPolicy({ ...plain, riskDefinition: 'x'.repeat(1001) }, ['A', 'B']));
  assert.throws(() => validateAllocationPolicy({ ...plain, riskDefinition: 'definition\nwith control' }, ['A', 'B']));
});

test('five assets conserve exact bps and respect fixed arbitrary cash plus variable grid bounds', () => {
  const input: AllocationPolicy = { ...policy(), stepBps: 1000, assets: {
    USDG: { riskScore: 1, expectedReturnBps: 0, minBps: 500, maxBps: 500 },
    A: { riskScore: 10, expectedReturnBps: 1000, minBps: 0, maxBps: 4000 },
    B: { riskScore: 20, expectedReturnBps: 1000, minBps: 0, maxBps: 4000 },
    C: { riskScore: 30, expectedReturnBps: 1000, minBps: 0, maxBps: 4000 },
    D: { riskScore: 40, expectedReturnBps: 1000, minBps: 0, maxBps: 4000 },
  } };
  const incumbent = { USDG: 500, A: 2375, B: 2375, C: 2375, D: 2375 };
  // A 1000-bps grid cannot fill 9500bps, but the feasible incumbent remains valid.
  const offGrid = optimizeAllocation(input, incumbent);
  assert.deepEqual(offGrid.targets, { A: 2375, B: 2375, C: 2375, D: 2375, USDG: 500 });
  assert.equal(offGrid.diagnostics.gridCandidates, 0); assert.equal(offGrid.candidates, 1);
  assert.equal(offGrid.diagnostics.incumbentOffGrid, true);
  input.stepBps = 500;
  const result = optimizeAllocation(input, incumbent);
  assert.equal(result.targets.USDG, 500);
  assert.equal(Object.values(result.targets).reduce((a, b) => a + b), 10000);
  for (const [id, weight] of Object.entries(result.targets)) {
    assert.ok(weight >= input.assets[id].minBps && weight <= input.assets[id].maxBps);
    assert.equal(weight % 500, 0);
  }
  assert.deepEqual(result.targets, { A: 4000, B: 4000, C: 1500, D: 0, USDG: 500 });
});

test('equal scores prefer the feasible off-grid incumbent, then stable lexical weights when turnover ties', () => {
  const input = policy();
  input.assets.A = { ...input.assets.A, riskScore: 10, expectedReturnBps: 1000 };
  input.assets.B = { ...input.assets.B, riskScore: 10, expectedReturnBps: 1000 };
  const incumbent = { A: 3333, B: 6667 };
  const result = optimizeAllocation(input, incumbent);
  assert.deepEqual(result.targets, incumbent); assert.equal(result.candidates, 22); assert.equal(result.diagnostics.incumbentOffGrid, true);
  const three: AllocationPolicy = { ...input, assets: {
    A: { riskScore: 10, expectedReturnBps: 1000, minBps: 0, maxBps: 10000 },
    B: { riskScore: 10, expectedReturnBps: 1000, minBps: 0, maxBps: 10000 },
    C: { riskScore: 10, expectedReturnBps: 1000, minBps: 0, maxBps: 0 },
  } };
  // Every A/B composition is equally distant from incumbent C=100%; sorted A
  // then B then C weights make the A=0 candidate the stable lexical winner.
  assert.deepEqual(optimizeAllocation(three, { A: 0, B: 0, C: 10000 }).targets, { A: 0, B: 10000, C: 0 });
});

test('hashing and results are independent of object insertion order and repeated calls', () => {
  const a = { ...policy(), history: history() };
  const b = { ...a, assets: { B: { ...a.assets.B }, A: { ...a.assets.A } },
    history: { ...a.history, observations: a.history.observations.map(row => ({ date: row.date, returns: { B: row.returns.B, A: row.returns.A } })) } };
  assert.match(allocationPolicyHash(a), /^[a-f0-9]{64}$/);
  assert.equal(allocationPolicyHash(a), allocationPolicyHash(b));
  assert.deepEqual(optimizeAllocation(a, current), optimizeAllocation(b, { B: 5000, A: 5000 }));
  assert.deepEqual(optimizeAllocation(a, current), optimizeAllocation(a, current));
  b.horizonMonths++;
  assert.notEqual(allocationPolicyHash(a), allocationPolicyHash(b));
});

test('zero subjective risk with positive excess blocks rather than hiding an unbounded candidate', () => {
  const input = policy(); input.assets.B.riskScore = 0;
  assert.throws(() => optimizeAllocation(input, current), /positive-excess.*zero user risk/);
  input.assets.B.expectedReturnBps = 0;
  const result = optimizeAllocation(input, current);
  assert.equal(result.diagnostics.skippedZeroDenominator, 1); assertFinite(result);
  input.assets.A.riskScore = 0; input.assets.A.expectedReturnBps = 0;
  assert.throws(() => optimizeAllocation(input, current), /every feasible objective.*undefined/);
});

test('negative finite excess remains a defined objective and is compared without invented forecasts', () => {
  const input = policy();
  input.assets.A.expectedReturnBps = -2000; input.assets.B.expectedReturnBps = -700;
  const result = optimizeAllocation(input, current);
  assert.deepEqual(result.targets, { A: 10000, B: 0 });
  assert.equal(result.score, -25); assert.equal(result.expectedReturnBps, -2000);
});

test('overall user risk is an exact optional constraint, including a fractional weighted boundary', () => {
  const input = policy();
  input.assets.A.expectedReturnBps = 10000; input.assets.A.riskScore = 100;
  input.assets.B.expectedReturnBps = 100; input.assets.B.riskScore = 1;
  input.maxRiskScore = 50;
  const result = optimizeAllocation(input, current);
  assert.equal(result.targets.A, 4500); assert.equal(result.targets.B, 5500);
  assert.ok(result.subjectiveRiskScore! <= 50); assert.ok(result.diagnostics.excludedByRisk > 0);
  assert.equal(result.diagnostics.incumbentIncluded, false, '50/50 has risk50.5, above the exact limit');
  input.maxRiskScore = 0;
  assert.throws(() => optimizeAllocation(input, current), /No feasible allocation.*risk limit/);
});

test('Sharpe uses aligned historical period returns and optional scores do not become its denominator', () => {
  const input: AllocationPolicy = { ...policy(), objective: 'sharpe', horizonMonths: 120, benchmarkReturnBps: 999,
    history: history(), assets: { A: { minBps: 0, maxBps: 10000 }, B: { minBps: 0, maxBps: 10000 } } };
  const result = optimizeAllocation(input, current);
  assert.deepEqual(result.targets, { A: 0, B: 10000 });
  assert.equal(result.subjectiveRiskScore, null); assert.equal(result.returnBasis, 'history-period');
  assert.ok(Math.abs(result.expectedReturnBps - 75) < 1e-10);
  const stats = prepareReturnStatistics(input.history, ['A', 'B']);
  assert.ok(Math.abs(result.score - stats.sharpe([0, 1])!) < 1e-12);
  assert.equal(result.diagnostics.history?.annualized, false);
  input.assets.A.riskScore = 1; input.assets.B.riskScore = 99;
  assert.deepEqual(optimizeAllocation(input, current).targets, result.targets);
  input.maxRiskScore = 50;
  assert.deepEqual(optimizeAllocation(input, current).targets, { A: 5000, B: 5000 });
  delete input.assets.B.riskScore;
  assert.throws(() => validateAllocationPolicy(input, ['A', 'B']), /requires explicit riskScore for every asset/);
  assertFinite(result);
});

test('zero-variance positive-excess Sharpe candidates cannot be silently discarded', () => {
  const input: AllocationPolicy = { ...policy(), objective: 'sharpe', history: history(i => ({ A: i % 2 ? .05 : -.03, B: .01 })) };
  assert.throws(() => optimizeAllocation(input, current), /positive-excess.*zero historical volatility/);
  input.history = history(i => ({ A: i % 2 ? .05 : -.03, B: 0 }));
  const result = optimizeAllocation(input, current);
  assert.equal(result.diagnostics.skippedZeroDenominator, 1); assertFinite(result);
  input.history = history(() => ({ A: 0, B: 0 }));
  assert.throws(() => optimizeAllocation(input, current), /every feasible objective.*undefined/);
});

test('candidate counting and bounded enumeration agree with an independent small composition count', () => {
  const input: AllocationPolicy = { ...policy(), stepBps: 1000, assets: Object.fromEntries(['A', 'B', 'C', 'D', 'E'].map(id => [id, {
    riskScore: 10, expectedReturnBps: 1000, minBps: 0, maxBps: 10000,
  }])) };
  const result = optimizeAllocation(input, { A: 2000, B: 2000, C: 2000, D: 2000, E: 2000 });
  // Stars and bars: ten units distributed across five assets gives C(14,4).
  assert.equal(result.candidates, 1001); assert.equal(result.diagnostics.gridCandidates, 1001);
  assert.deepEqual(result.targets, { A: 2000, B: 2000, C: 2000, D: 2000, E: 2000 });
});

test('strict validation rejects missing judgments, unsupported constraints, invalid grids and mismatched universes', () => {
  const invalid: unknown[] = [null, {}, { ...policy(), maxDrawdown: .2 }, { ...policy(), maxRiskScore: 101 },
    { ...policy(), horizonMonths: 0 }, { ...policy(), horizonMonths: 1201 }, { ...policy(), stepBps: 50 },
    { ...policy(), stepBps: 333 }, { ...policy(), benchmarkReturnBps: NaN }, { ...policy(), objective: 'volatility' },
    { ...policy(), assets: { ...policy().assets, C: policy().assets.A } },
    { ...policy(), assets: { A: { ...policy().assets.A, riskScore: undefined }, B: policy().assets.B } },
    { ...policy(), assets: { A: { ...policy().assets.A, expectedReturnBps: undefined }, B: policy().assets.B } },
    { ...policy(), assets: { A: { ...policy().assets.A, volatility: .1 }, B: policy().assets.B } },
    { ...policy(), assets: { A: { ...policy().assets.A, minBps: 125 }, B: policy().assets.B } },
    { ...policy(), assets: { A: { ...policy().assets.A, minBps: 10000 }, B: { ...policy().assets.B, minBps: 500 } } },
    { ...policy(), assets: { A: { ...policy().assets.A, maxBps: 1000 }, B: { ...policy().assets.B, maxBps: 1000 } } },
    { ...policy(), objective: 'sharpe' },
    { ...policy(), history: { ...history(), maxDrawdown: .5 } },
  ];
  for (const value of invalid) assert.throws(() => validateAllocationPolicy(value, ['A', 'B']));
  for (const ids of [[], ['A', 'A'], ['A', 'B', 'C', 'D', 'E', 'F'], ['A;execute', 'B']]) assert.throws(() => validateAllocationPolicy(policy(), ids));
  for (const weights of [{ A: 5000 }, { A: 5000, B: 4000 }, { A: -1, B: 10001 }, { A: 5000.5, B: 4999.5 }]) {
    assert.throws(() => optimizeAllocation(policy(), weights as Record<string, number>));
  }
});
