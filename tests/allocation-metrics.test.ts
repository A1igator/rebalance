import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareReturnStatistics, validateReturnHistory, type ReturnHistory } from '../src/allocation-metrics.js';

const date = (index: number) => new Date(Date.UTC(2020, 0, index + 1)).toISOString().slice(0, 10);
const history = (returns: readonly Record<string, number>[], benchmarkPeriodReturn = 0): ReturnHistory => ({
  source: 'Deterministic public mathematical fixture; not market observations', basis: 'synthetic', quoteCurrency: 'USD',
  interval: 'daily', asOf: '2026-09-07', benchmarkPeriodReturn,
  observations: returns.map((returns, index) => ({ date: date(index), returns: { ...returns } })),
});
const repeated = (values: readonly number[], n = 20) => history(Array.from({ length: n }, (_, i) => ({ A: values[i % values.length]! })));
const near = (actual: number | null, expected: number, tolerance = 1e-12) => {
  assert.notEqual(actual, null); assert.ok(Math.abs(actual! - expected) <= tolerance, `${actual} differs from ${expected}`);
};

test('source-aware validation canonicalizes and copies aligned history without replacing its basis', () => {
  const raw = history(Array.from({ length: 20 }, () => ({ A: 0.01, B: -0.01 })));
  raw.source = '  Explicit underlying proxy  '; raw.basis = 'underlying-proxy';
  const validated = validateReturnHistory(raw, ['B', 'A']);
  assert.equal(validated.source, 'Explicit underlying proxy'); assert.equal(validated.basis, 'underlying-proxy');
  assert.equal(validated.asOf, '2026-09-07T00:00:00.000Z');
  assert.deepEqual(Object.keys(validated.observations[0]!.returns), ['B', 'A']);
  raw.observations[0]!.returns.A = 100;
  assert.equal(validated.observations[0]!.returns.A, 0.01);
  assert.equal(validateReturnHistory(repeated([0]), ['A']).basis, 'synthetic', 'preview data keeps its synthetic label for activation checks');
});

test('sample covariance and Sharpe use aligned simple returns and a same-period differential benchmark', () => {
  const rows = Array.from({ length: 20 }, (_, i) => { const A = i % 2 === 0 ? 0.02 : -0.01; return { A, B: 2 * A + 0.001 }; });
  const stats = prepareReturnStatistics(history(rows, 0.002), ['A', 'B']);
  const varianceA = 0.0045 / 19;
  near(stats.meanReturns[0]!, 0.005); near(stats.meanReturns[1]!, 0.011);
  near(stats.meanDifferentialReturns[0]!, 0.003); near(stats.meanDifferentialReturns[1]!, 0.009);
  near(stats.covariance[0]![0]!, varianceA); near(stats.covariance[0]![1]!, 2 * varianceA);
  near(stats.covariance[1]![0]!, 2 * varianceA); near(stats.covariance[1]![1]!, 4 * varianceA);
  near(stats.sharpe([0.25, 0.75]), 0.0075 / (1.75 * Math.sqrt(varianceA)));
  const metrics = stats.diagnostics([0.25, 0.75]);
  near(metrics.arithmeticMeanReturn, 0.0095); near(metrics.meanDifferentialReturn, 0.0075);
  near(metrics.volatility, 1.75 * Math.sqrt(varianceA)); near(metrics.sharpe, stats.sharpe([0.25, 0.75])!);
  assert.equal(metrics.annualized, false); assert.equal(metrics.interval, 'daily');
  assert.equal(metrics.pathConvention, 'constant-weight-per-observation');
  assert.equal(metrics.observationCount, 20); assert.equal(metrics.source, history(rows).source);
});

test('changing the constant benchmark changes ratios and downside target, not covariance', () => {
  const raw = repeated([0.02, -0.01]);
  const zero = prepareReturnStatistics(raw, ['A']);
  const targeted = prepareReturnStatistics({ ...raw, benchmarkPeriodReturn: 0.01 }, ['A']);
  assert.deepEqual(targeted.covariance, zero.covariance);
  const z = zero.diagnostics([1]), t = targeted.diagnostics([1]);
  near(z.downsideDeviation, Math.sqrt(0.00005)); near(z.sortino, 0.005 / Math.sqrt(0.00005));
  near(t.downsideDeviation, Math.sqrt(0.0002)); near(t.sortino, -0.005 / Math.sqrt(0.0002));
  near(t.meanDifferentialReturn, -0.005);
});

test('undefined zero-risk ratios stay unavailable, including positive-return and perfectly hedged candidates', () => {
  for (const constant of [-0.01, 0, 0.01]) {
    const stats = prepareReturnStatistics(repeated([constant]), ['A']);
    assert.equal(stats.sharpe([1]), null);
    const metrics = stats.diagnostics([1]);
    assert.equal(metrics.sharpe, null);
    if (constant >= 0) assert.equal(metrics.sortino, null);
    else near(metrics.sortino, -1);
  }
  const rows = Array.from({ length: 20 }, (_, i) => ({ A: i % 2 ? 0.02 : -0.01, B: i % 2 ? -0.01 : 0.02 }));
  const hedged = prepareReturnStatistics(history(rows), ['A', 'B']);
  assert.ok(hedged.varianceEpsilon >= 1e-18);
  assert.equal(hedged.sharpe([0.5, 0.5]), null, 'a positive-return zero-variance candidate is not a finite Sharpe winner');
  near(hedged.diagnostics([0.5, 0.5]).arithmeticMeanReturn, 0.005);
});

test('95% CVaR uses fractional tail probability at the cutoff and retains the loss sign', () => {
  const raw = history(Array.from({ length: 21 }, (_, i) => ({ A: i === 0 ? -0.5 : i === 1 ? -0.2 : 0 })));
  const metrics = prepareReturnStatistics(raw, ['A']).diagnostics([1]);
  near(metrics.cvar95TailCount, 1.05); near(metrics.cvar95, (0.5 + 0.05 * 0.2) / 1.05);
  assert.notEqual(metrics.cvar95, 0.35, 'averaging both losses >= empirical VaR is incorrect here');
  const tied = history(Array.from({ length: 40 }, (_, i) => ({ A: i < 3 ? -0.5 : 0 })));
  near(prepareReturnStatistics(tied, ['A']).diagnostics([1]).cvar95, 0.5);
  near(prepareReturnStatistics(repeated([0.02]), ['A']).diagnostics([1]).cvar95, -0.02);
});

test('compounded peak-relative drawdown preserves chronology and includes initial wealth', () => {
  const raw = (first: number[]) => history([...first, ...Array(16).fill(0)].map(A => ({ A })));
  const consecutive = prepareReturnStatistics(raw([0.2, -0.1, -0.1, 0.2]), ['A']);
  const separated = prepareReturnStatistics(raw([-0.1, 0.2, -0.1, 0.2]), ['A']);
  near(consecutive.diagnostics([1]).maxDrawdown, 0.19);
  near(separated.diagnostics([1]).maxDrawdown, 0.1);
  near(consecutive.sharpe([1]), separated.sharpe([1])!);
  near(prepareReturnStatistics(repeated([-0.1], 20), ['A']).diagnostics([1]).maxDrawdown, 1 - 0.9 ** 20);
});

test('drawdown remains finite for long high-return paths and a total loss cannot recover from zero wealth', () => {
  const high = history(Array.from({ length: 2000 }, (_, i) => ({ A: i === 1999 ? -0.5 : 1000 })));
  near(prepareReturnStatistics(high, ['A']).diagnostics([1]).maxDrawdown, 0.5, 1e-10);
  const zero = history(Array.from({ length: 20 }, (_, i) => ({ A: i === 1 ? -1 : 1000 })));
  near(prepareReturnStatistics(zero, ['A']).diagnostics([1]).maxDrawdown, 1);
});

test('prepared statistics stay stable if input history changes, and public arrays cannot be mutated', () => {
  const raw = repeated([0.02, -0.01]);
  const stats = prepareReturnStatistics(raw, ['A']); const before = stats.diagnostics([1]);
  raw.observations[0]!.returns.A = 1000; raw.source = 'changed'; raw.benchmarkPeriodReturn = 100;
  assert.deepEqual(stats.diagnostics([1]), before);
  assert.throws(() => { (stats.meanReturns as number[])[0] = 100; }, TypeError);
  assert.throws(() => { (stats.covariance[0] as number[])[0] = 100; }, TypeError);
});

test('misaligned, missing, nonfinite, future and noncanonical data reject instead of being filled', async t => {
  const mutations: Record<string, (raw: ReturnHistory) => void> = {
    'too short': raw => { raw.observations.pop(); },
    'too long': raw => { raw.observations = history(Array.from({ length: 2001 }, () => ({ A: 0 }))).observations; },
    'duplicate date': raw => { raw.observations[1]!.date = raw.observations[0]!.date; },
    'unsorted dates': raw => { [raw.observations[1], raw.observations[2]] = [raw.observations[2]!, raw.observations[1]!]; },
    'invalid date': raw => { raw.observations[0]!.date = '2020-02-30'; },
    'timestamp observation': raw => { raw.observations[0]!.date = '2020-01-01T00:00:00Z'; },
    'future observation': raw => { raw.asOf = '2020-01-19'; },
    'invalid as-of': raw => { raw.asOf = '2026-02-30'; },
    'missing asset': raw => { delete raw.observations[0]!.returns.A; },
    'unexpected asset': raw => { raw.observations[0]!.returns.B = 0; },
    'infinite return': raw => { raw.observations[0]!.returns.A = Infinity; },
    'NaN return': raw => { raw.observations[0]!.returns.A = NaN; },
    'loss below total': raw => { raw.observations[0]!.returns.A = -1.01; },
    'return outside bound': raw => { raw.observations[0]!.returns.A = 1001; },
    'unknown source': raw => { raw.source = ''; },
    'unknown basis': raw => { raw.basis = 'unknown' as ReturnHistory['basis']; },
    'unsupported interval': raw => { raw.interval = 'minute' as ReturnHistory['interval']; },
    'nonfinite benchmark': raw => { raw.benchmarkPeriodReturn = NaN; },
    'unsupported metadata': raw => { (raw as unknown as Record<string, unknown>).annualized = true; },
  };
  for (const [name, mutate] of Object.entries(mutations)) await t.test(name, () => {
    const raw = repeated([0.02, -0.01]); mutate(raw);
    assert.throws(() => validateReturnHistory(raw, ['A']), /Return history must contain/);
    assert.throws(() => prepareReturnStatistics(raw, ['A']), /Return history must contain/);
  });
  for (const ids of [[], ['A', 'A'], ['B']]) assert.throws(() => validateReturnHistory(repeated([0]), ids), /Return history must contain/);
});

test('invalid portfolio weight vectors cannot produce plausible diagnostics', () => {
  const stats = prepareReturnStatistics(history(Array.from({ length: 20 }, (_, i) => ({ A: i / 100, B: -0.01 }))), ['A', 'B']);
  for (const weights of [[], [1], [0.5, 0.6], [-0.1, 1.1], [NaN, 0], [Infinity, 0]]) {
    assert.throws(() => stats.sharpe(weights), /weights must be/);
    assert.throws(() => stats.diagnostics(weights), /weights must be/);
  }
});
