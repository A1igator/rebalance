import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkRebalanceFee, FeeTargetError, type FeeTargetInput } from '../src/fee-target.js';
import { ETH_USD_SPOT_URL } from '../src/gas-display.js';

const observedAt = Date.parse('2026-09-10T12:00:00.000Z');
const input: FeeTargetInput = { targetUsdE8: '200000000', swaps: 3, kind: 'swap', gas: 180_000n, gasPrice: 500_000_000n };
const response = (amount = '3000', base = 'ETH', currency = 'USD') => new Response(JSON.stringify({ data: { amount, base, currency } }));
const dependencies = { now: () => observedAt, fetch: async () => response() };

test('remaining swaps and conservative approvals use exact buffered gas without double-buffering gas price', async () => {
  const swaps = await checkRebalanceFee(input, dependencies);
  assert.deepEqual(swaps, { targetUsdE8: '200000000', estimatedUsdE8: '108634200', gasPriceWei: '500000000',
    ethUsdE8: '300000000000', observedAt: '2026-09-10T12:00:00.000Z', state: 'within-target' });
  const approval = await checkRebalanceFee({ ...input, kind: 'approval', gas: 70_000n }, dependencies);
  assert.equal(approval.estimatedUsdE8, '122515500');
  const finalSwap = await checkRebalanceFee({ ...input, swaps: 1 }, dependencies);
  assert.equal(finalSwap.estimatedUsdE8, '27000000');
  const finalApproval = await checkRebalanceFee({ ...input, swaps: 1, kind: 'approval', gas: 70_000n }, dependencies);
  assert.equal(finalApproval.estimatedUsdE8, '40881300');
});

test('an exact target boundary passes and one E8 unit below waits', async () => {
  const equal = await checkRebalanceFee({ ...input, targetUsdE8: '108634200' }, dependencies);
  assert.equal(equal.state, 'within-target');
  const below = await checkRebalanceFee({ ...input, targetUsdE8: '108634199' }, dependencies);
  assert.equal(below.state, 'above-target');
  assert.equal(below.estimatedUsdE8, equal.estimatedUsdE8);
});

test('fractional E8 costs round up rather than disappearing, using decimal prices exactly', async () => {
  const smallest = { ...input, swaps: 1, gas: 1n, gasPrice: 1n };
  const one = await checkRebalanceFee({ ...smallest, targetUsdE8: '1' }, { ...dependencies, fetch: async () => response('1') });
  assert.equal(one.estimatedUsdE8, '1'); assert.equal(one.state, 'within-target');
  const zero = await checkRebalanceFee({ ...smallest, targetUsdE8: '0' }, { ...dependencies, fetch: async () => response('1') });
  assert.equal(zero.state, 'above-target');
  const decimal = await checkRebalanceFee({ ...smallest, gasPrice: 10n ** 18n }, { ...dependencies, fetch: async () => response('1.23456789') });
  assert.equal(decimal.ethUsdE8, '123456789'); assert.equal(decimal.estimatedUsdE8, '123456789');
});

test('maximum projection count and large integer amounts retain exact arithmetic', async () => {
  const max = await checkRebalanceFee({ ...input, swaps: 16 }, dependencies);
  const gas = 180_000n + 15n * (202_542n + 69_572n);
  assert.equal(max.estimatedUsdE8, ((gas * 500_000_000n * 300_000_000_000n + 10n ** 18n - 1n) / 10n ** 18n).toString());
  const huge = await checkRebalanceFee({ ...input, swaps: 1, gas: 2n ** 200n, gasPrice: 2n ** 200n, targetUsdE8: ((1n << 256n) - 1n).toString() }, dependencies);
  assert.equal(huge.estimatedUsdE8, ((2n ** 400n * 300_000_000_000n + 10n ** 18n - 1n) / 10n ** 18n).toString());
  assert.equal(huge.state, 'above-target');
});

test('every check fetches the exact public ETH/USD endpoint freshly without credentials or redirects', async () => {
  let calls = 0, now = observedAt;
  const fetch: typeof globalThis.fetch = async (url, init) => {
    calls++;
    assert.equal(url, ETH_USD_SPOT_URL);
    assert.equal(init?.cache, 'no-store'); assert.equal(init?.credentials, 'omit'); assert.equal(init?.redirect, 'error');
    assert.equal(init?.body, undefined); assert.ok(init?.signal instanceof AbortSignal);
    now += 100;
    return response(calls === 1 ? '1000' : '2000');
  };
  const first = await checkRebalanceFee(input, { fetch, now: () => now });
  const second = await checkRebalanceFee(input, { fetch, now: () => now });
  assert.equal(calls, 2); assert.equal(first.ethUsdE8, '100000000000'); assert.equal(second.ethUsdE8, '200000000000');
  assert.equal(first.observedAt, new Date(observedAt + 100).toISOString());
  assert.equal(second.observedAt, new Date(observedAt + 200).toISOString());
});

test('invalid input fails before any public request', async () => {
  let calls = 0;
  const deps = { ...dependencies, fetch: async () => { calls++; return response(); } };
  const bad: unknown[] = [null, { ...input, targetUsdE8: '01' }, { ...input, targetUsdE8: '-1' }, { ...input, targetUsdE8: '1e3' },
    { ...input, targetUsdE8: '1.5' }, { ...input, targetUsdE8: '1'.repeat(79) }, { ...input, targetUsdE8: (1n << 256n).toString() },
    { ...input, swaps: 0 }, { ...input, swaps: 17 }, { ...input, swaps: 1.5 }, { ...input, swaps: NaN },
    { ...input, kind: 'wrap' }, { ...input, gas: 0n }, { ...input, gas: -1n }, { ...input, gas: 1 },
    { ...input, gas: 1n << 256n }, { ...input, gasPrice: 0n }, { ...input, gasPrice: '1' }, { ...input, gasPrice: 1n << 256n }];
  for (const candidate of bad) await assert.rejects(checkRebalanceFee(candidate as FeeTargetInput, deps), /Invalid rebalance fee-target inputs/);
  for (const timeoutMs of [0, -1, Infinity, 4001]) await assert.rejects(checkRebalanceFee(input, { ...deps, timeoutMs }), /dependencies/);
  assert.equal(calls, 0);
});

test('missing or malformed quote, wrong coin identity and unsupported decimals remain unavailable', async () => {
  const bad: unknown[] = [null, [], {}, { data: null }, { data: [] }, { data: { amount: '3000', base: 'BTC', currency: 'USD' } },
    { data: { amount: '3000', base: 'ETH', currency: 'EUR' } }];
  for (const amount of ['0', '-1', 'NaN', 'Infinity', '1e3', ' 3000', '03000', '1.123456789', '1000000000000', 3000]) {
    bad.push({ data: { amount, base: 'ETH', currency: 'USD' } });
  }
  for (const value of bad) {
    const check = await checkRebalanceFee(input, { ...dependencies, fetch: async () => new Response(JSON.stringify(value)) });
    assert.deepEqual(check, { targetUsdE8: input.targetUsdE8, estimatedUsdE8: null, gasPriceWei: input.gasPrice.toString(),
      ethUsdE8: null, observedAt: null, state: 'unavailable' });
  }
});

test('network, HTTP, JSON and encoding errors return a bounded public outcome without source text', async () => {
  const responses = [() => new Response('external-secret', { status: 503 }), () => new Response(null, { status: 204 }),
    () => new Response('external-secret'), () => new Response(new Uint8Array([0xc3, 0x28]))];
  for (const reply of responses) {
    const result = await checkRebalanceFee(input, { ...dependencies, fetch: async () => reply() });
    assert.equal(result.state, 'unavailable'); assert.ok(!JSON.stringify(result).includes('external-secret'));
  }
  const check = await checkRebalanceFee(input, { ...dependencies, fetch: async () => { throw new Error('external-secret'); } });
  const error = new FeeTargetError(check);
  assert.equal(error.name, 'FeeTargetError'); assert.equal(error.check.state, 'unavailable');
  assert.ok(!error.message.includes('external-secret')); assert.ok(Object.isFrozen(error.check));
  const expensive = new FeeTargetError(await checkRebalanceFee({ ...input, targetUsdE8: '1' }, dependencies));
  assert.match(expensive.message, /above the configured target/);
});

test('oversized streamed responses stop reading and cancel the body', async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(16_385)); }, cancel() { cancelled = true; } });
  const result = await checkRebalanceFee(input, { ...dependencies, fetch: async () => new Response(stream) });
  assert.equal(result.state, 'unavailable'); assert.equal(cancelled, true);
});

test('timeout bounds both unavailable fetch and a stalled response body', async () => {
  let signal: AbortSignal | undefined;
  const hung: typeof globalThis.fetch = async (_url, init) => { signal = init?.signal ?? undefined; return new Promise<Response>(() => {}); };
  const first = await checkRebalanceFee(input, { ...dependencies, fetch: hung, timeoutMs: 10 });
  assert.equal(first.state, 'unavailable'); assert.equal(signal?.aborted, true);
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const second = await checkRebalanceFee(input, { ...dependencies, fetch: async () => new Response(stream), timeoutMs: 10 });
  assert.equal(second.state, 'unavailable'); assert.equal(cancelled, true);
});

test('a backward clock, delayed observation or invalid date cannot look like a fresh quote', async () => {
  for (const end of [observedAt - 1, observedAt + 4001, Infinity, 9_000_000_000_000_000]) {
    let calls = 0;
    const check = await checkRebalanceFee(input, { ...dependencies, now: () => calls++ === 0 ? observedAt : end });
    assert.equal(check.state, 'unavailable'); assert.equal(check.observedAt, null);
  }
});
