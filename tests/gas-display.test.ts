import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createGasDisplayReader, ETH_USD_SPOT_URL, GAS_DISPLAY_CACHE_MS, GAS_DISPLAY_RPC,
  type GasDisplay,
} from '../src/gas-display.js';

const empty: GasDisplay = { gasPriceWei: null, ethUsdE8: null, gasObservedAt: null, usdObservedAt: null };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json' },
});
type Call = { url: string; init: RequestInit; method: string | undefined; id: number | undefined };

function fixture() {
  let time = Date.parse('2026-09-06T02:30:00Z');
  const calls: Call[] = [];
  const good = (call: Call): Response => call.url === ETH_USD_SPOT_URL
    ? json({ data: { base: 'ETH', currency: 'USD', amount: '2467.12345678' } })
    : json({ jsonrpc: '2.0', id: call.id, result: call.method === 'eth_chainId' ? '0x1237' : '0x5f5e100' });
  let reply: (call: Call) => Response | Promise<Response> = good;
  const fetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const body = init.body ? JSON.parse(init.body as string) : {};
    const call = { url: String(url), init, method: body.method, id: body.id };
    calls.push(call);
    return reply(call);
  }) as typeof globalThis.fetch;
  return {
    calls, fetch, good, now: () => time,
    advance: (ms: number) => { time += ms; },
    reply: (handler: typeof reply) => { reply = handler; },
    reader: () => createGasDisplayReader({ fetch, now: () => time }),
  };
}

test('gas display validates Robinhood and returns exact independent decimal prices', async () => {
  const f = fixture();
  const result = await f.reader()();
  assert.deepEqual(result, {
    gasPriceWei: '100000000', ethUsdE8: '246712345678',
    gasObservedAt: '2026-09-06T02:30:00.000Z', usdObservedAt: '2026-09-06T02:30:00.000Z',
  });
  assert.equal(f.calls.length, 3);
  for (const call of f.calls) {
    assert.equal(call.init.credentials, 'omit');
    assert.equal(call.init.redirect, 'error');
    assert.ok(call.init.signal instanceof AbortSignal);
    if (call.url === ETH_USD_SPOT_URL) assert.equal(call.init.body, undefined);
    else {
      assert.equal(call.url, GAS_DISPLAY_RPC);
      assert.equal(call.init.method, 'POST');
      assert.deepEqual(JSON.parse(call.init.body as string).params, []);
      assert.ok(['eth_chainId', 'eth_gasPrice'].includes(call.method!));
    }
  }
});

test('parallel callers share one refresh and receive independent objects', async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.reply(async call => { await gate; return f.good(call); });
  const read = f.reader();
  const pending = Array.from({ length: 20 }, () => read());
  assert.equal(f.calls.length, 3);
  release();
  const results = await Promise.all(pending);
  assert.equal(f.calls.length, 3);
  assert.deepEqual(results[0], results[19]);
  assert.notEqual(results[0], results[19]);
  results[0].gasPriceWei = '999';
  assert.equal((await read()).gasPriceWei, '100000000');
});

test('cache refreshes at exactly thirty seconds and expires after clock rollback', async () => {
  const f = fixture(); const read = f.reader();
  const first = await read();
  f.advance(GAS_DISPLAY_CACHE_MS - 1);
  assert.deepEqual(await read(), first);
  assert.equal(f.calls.length, 3);
  f.advance(1);
  assert.equal((await read()).gasObservedAt, '2026-09-06T02:30:30.000Z');
  assert.equal(f.calls.length, 6);
  f.advance(-1);
  assert.equal((await read()).gasObservedAt, '2026-09-06T02:30:29.999Z');
  assert.equal(f.calls.length, 9);
});

test('failure before first success stays unavailable and does not retry per caller', async () => {
  const f = fixture(); const read = f.reader();
  f.reply(() => { throw new Error('unpublished provider details'); });
  assert.deepEqual(await read(), empty);
  for (let i = 0; i < 10; i++) assert.deepEqual(await read(), empty);
  assert.equal(f.calls.length, 3);
  f.advance(GAS_DISPLAY_CACHE_MS);
  f.reply(f.good);
  assert.equal((await read()).gasPriceWei, '100000000');
  assert.equal(f.calls.length, 6);
});

test('each failed source preserves its last good value and observation time independently', async () => {
  const f = fixture(); const read = f.reader();
  const first = await read();
  f.advance(GAS_DISPLAY_CACHE_MS);
  f.reply(call => call.url === ETH_USD_SPOT_URL ? new Response('unavailable', { status: 503 }) : f.good(call));
  const gasOnly = await read();
  assert.equal(gasOnly.gasObservedAt, '2026-09-06T02:30:30.000Z');
  assert.equal(gasOnly.usdObservedAt, first.usdObservedAt);
  assert.equal(gasOnly.ethUsdE8, first.ethUsdE8);
  f.advance(GAS_DISPLAY_CACHE_MS);
  f.reply(call => call.url === ETH_USD_SPOT_URL
    ? json({ data: { base: 'ETH', currency: 'USD', amount: '2500' } })
    : new Response('unavailable', { status: 429 }));
  const usdOnly = await read();
  assert.equal(usdOnly.gasObservedAt, gasOnly.gasObservedAt);
  assert.equal(usdOnly.gasPriceWei, gasOnly.gasPriceWei);
  assert.equal(usdOnly.usdObservedAt, '2026-09-06T02:31:00.000Z');
  assert.equal(usdOnly.ethUsdE8, '250000000000');
  f.advance(300_000);
  f.reply(() => new Response('unavailable', { status: 503 }));
  assert.deepEqual(await read(), usdOnly, 'stale data retains original timestamps; it is not re-dated');
});

test('USD parsing accepts one satoshi-dollar precision without floating point', async () => {
  const f = fixture();
  f.reply(call => call.url === ETH_USD_SPOT_URL
    ? json({ data: { base: 'ETH', currency: 'USD', amount: '0.00000001' } }) : f.good(call));
  assert.equal((await f.reader()()).ethUsdE8, '1');
});

test('malformed, wrong-currency and nonpositive USD values never become prices', async t => {
  const cases: unknown[] = [
    null, [], { data: [] }, { data: { currency: 'USD', amount: '2467' } },
    { data: { base: 'BTC', currency: 'USD', amount: '2467' } },
    { data: { base: 'ETH', currency: 'EUR', amount: '2467' } },
    ...['0', '0.00000000', '-1', '+1', '1e3', '1.123456789', '01.2', 'NaN', 'Infinity', '1000000000000', 2467]
      .map(amount => ({ data: { base: 'ETH', currency: 'USD', amount } })),
  ];
  for (const [index, value] of cases.entries()) await t.test(String(index), async () => {
    const f = fixture();
    f.reply(call => call.url === ETH_USD_SPOT_URL ? json(value) : f.good(call));
    const result = await f.reader()();
    assert.equal(result.ethUsdE8, null);
    assert.equal(result.usdObservedAt, null);
    assert.equal(result.gasPriceWei, '100000000');
  });
});

test('RPC identity, response envelope and positive uint256 quantities are required', async t => {
  const replacements: ((call: Call) => Response)[] = [
    call => json({ jsonrpc: '2.0', id: call.id, result: '0x1' }),
    call => json({ jsonrpc: '2.0', id: 999, result: '0x1237' }),
    call => json({ jsonrpc: '1.0', id: call.id, result: '0x1237' }),
    call => json({ jsonrpc: '2.0', id: call.id, error: { code: -1 }, result: '0x1237' }),
    ...['0x0', '0x01', '0x', '-1', '12345', `0x1${'0'.repeat(64)}`, 123]
      .map(result => (call: Call) => call.method === 'eth_gasPrice'
        ? json({ jsonrpc: '2.0', id: call.id, result })
        : json({ jsonrpc: '2.0', id: call.id, result: '0x1237' })),
  ];
  for (const [index, replacement] of replacements.entries()) await t.test(String(index), async () => {
    const f = fixture();
    f.reply(call => call.url === ETH_USD_SPOT_URL ? f.good(call) : replacement(call));
    const result = await f.reader()();
    assert.equal(result.gasPriceWei, null);
    assert.equal(result.gasObservedAt, null);
    assert.equal(result.ethUsdE8, '246712345678');
  });
});

test('invalid JSON and oversized bodies are rejected without overwriting another source', async t => {
  for (const body of ['not JSON', ' '.repeat(16_385)]) await t.test(String(body.length), async () => {
    const f = fixture();
    f.reply(call => call.url === ETH_USD_SPOT_URL ? new Response(body) : f.good(call));
    const result = await f.reader()();
    assert.equal(result.ethUsdE8, null);
    assert.equal(result.gasPriceWei, '100000000');
  });
});

test('a stalled source has one bounded attempt and aborts without delaying the healthy quote forever', async () => {
  const f = fixture();
  f.reply(call => call.url === ETH_USD_SPOT_URL ? new Promise<Response>(() => {}) : f.good(call));
  const read = createGasDisplayReader({ fetch: f.fetch, now: f.now, timeoutMs: 15 });
  const result = await read();
  assert.equal(result.ethUsdE8, null);
  assert.equal(result.gasPriceWei, '100000000');
  assert.ok(f.calls.every(call => call.init.signal!.aborted));
  assert.deepEqual(await read(), result);
  assert.equal(f.calls.length, 3);
});
