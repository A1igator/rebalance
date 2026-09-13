import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setImmediate as immediate } from 'node:timers/promises';
import { fetchSharpeHistory } from '../src/sharpe-history.js';

const IDS = ['USDG', 'AAPL', 'NVDA', 'MSFT', 'AMD'];
const NOW = new Date('2026-09-13T12:00:00Z');
const DAY = 86_400_000;
// Fixture prices are synthetic test inputs only. This module's tests never
// contact providers, read application state or adopt a portfolio policy.
function fixture(ids = IDS, now = NOW) {
  const today = Date.parse(now.toISOString().slice(0, 10));
  const start = new Date(today); start.setUTCFullYear(start.getUTCFullYear() - 1);
  const days = Array.from({ length: Math.round((today - start.getTime()) / DAY) + 1 }, (_, i) => start.getTime() + i * DAY);
  const dates = days.filter(time => time < today && ![0, 6].includes(new Date(time).getUTCDay()));
  const stock = (symbol: string) => ({ chart: { error: null, result: [{
    meta: { symbol, currency: 'USD', instrumentType: 'EQUITY', exchangeTimezoneName: 'America/New_York', dataGranularity: '1d', range: '1y' },
    timestamp: dates.map(time => (time + 14.5 * 3_600_000) / 1000),
    indicators: { adjclose: [{ adjclose: dates.map((_, i) => 20 + i / 100) }],
      quote: [{ close: dates.map((_, i) => 80 + i / 5) }] },
  }] } });
  const rows = days.map((time, index) => {
    const close = (1 + 0.001 * Math.sin(index)).toFixed(8);
    return [time / 1000, close, close, close, close, close, '10.0', 1];
  });
  const payloads: Record<string, any> = Object.fromEntries(ids.filter(id => id !== 'USDG').map(id => [id, stock(id)]));
  payloads.USDG = { error: [], result: { USDGUSD: rows, last: today / 1000 } };
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input); calls.push({ url, init });
    const parsed = new URL(url);
    const id = parsed.hostname === 'api.kraken.com' ? 'USDG' : parsed.pathname.split('/').at(-1)!;
    return Response.json(payloads[id]);
  };
  return { payloads, dates, days, calls, fetch, now, stock: (id = 'AAPL') => payloads[id].chart.result[0] };
}
function removeStockRow(f: ReturnType<typeof fixture>, id: string, index: number) {
  const data = f.stock(id);
  data.timestamp.splice(index, 1);
  data.indicators.adjclose[0].adjclose.splice(index, 1);
  data.indicators.quote[0].close.splice(index, 1);
}

test('fixed public URLs fetch in parallel without credentials, redirects, retries or caller mutation', async () => {
  const f = fixture();
  const ids = [...IDS];
  const waiters: (() => void)[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const response = await f.fetch(input, init);
    await new Promise<void>(resolve => waiters.push(resolve));
    return response;
  };
  const pending = fetchSharpeHistory(ids, { now: f.now, fetch });
  await immediate();
  assert.equal(f.calls.length, 5); assert.equal(waiters.length, 5);
  ids[1] = 'ETH'; // Public input is captured before the provider wait.
  waiters.forEach(resolve => resolve());
  const result = await pending;
  assert.deepEqual(Object.keys(result.history.observations[0].returns), ['AAPL', 'AMD', 'MSFT', 'NVDA', 'USDG']);
  for (const { url, init } of f.calls) {
    const parsed = new URL(url);
    assert.equal(parsed.protocol, 'https:');
    assert.equal(init?.method, 'GET'); assert.equal(init?.credentials, 'omit');
    assert.equal(init?.redirect, 'error'); assert.equal(init?.cache, 'no-store');
    assert.deepEqual(init?.headers, { accept: 'application/json' });
    if (parsed.hostname === 'query1.finance.yahoo.com') {
      assert.match(parsed.pathname, /^\/v8\/finance\/chart\/(AAPL|AMD|MSFT|NVDA)$/);
      assert.equal(parsed.search, '?range=1y&interval=1d&events=div%2Csplits&includeAdjustedClose=true');
    } else assert.equal(url, 'https://api.kraken.com/0/public/OHLC?pair=USDGUSD&interval=1440');
  }
  assert.equal(new Set(f.calls.map(call => call.url)).size, 5);
});

test('returns use adjusted shares and observed USDG across the same equity dates with complete provenance', async () => {
  const f = fixture();
  const { history, provenance } = await fetchSharpeHistory(IDS, { now: f.now, fetch: f.fetch });
  assert.equal(history.observations.length, f.dates.length - 1);
  assert.equal(history.observations[0].returns.AAPL, 20.01 / 20 - 1);
  assert.notEqual(history.observations[0].returns.AAPL, 80.2 / 80 - 1);
  const cashRows = f.payloads.USDG.result.USDGUSD;
  const first = cashRows.find((row: any[]) => row[0] * 1000 === f.dates[0]);
  const second = cashRows.find((row: any[]) => row[0] * 1000 === f.dates[1]);
  assert.equal(history.observations[0].returns.USDG, Number(second[4]) / Number(first[4]) - 1);
  assert.ok(history.observations.some(row => row.returns.USDG !== 0));
  const monday = history.observations.find(row => new Date(row.date).getUTCDay() === 1)!;
  const priorFriday = new Date(Date.parse(monday.date) - 3 * DAY).toISOString().slice(0, 10);
  const cashByDay = new Map<string, number>(cashRows.map((row: any[]) => [new Date(row[0] * 1000).toISOString().slice(0, 10), Number(row[4])]));
  assert.equal(monday.returns.USDG, cashByDay.get(monday.date)! / cashByDay.get(priorFriday)! - 1);
  assert.equal(history.basis, 'underlying-proxy'); assert.equal(history.quoteCurrency, 'USD');
  assert.equal(history.interval, 'daily'); assert.equal(history.benchmarkPeriodReturn, 0);
  assert.equal(history.asOf, NOW.toISOString());
  assert.match(history.source, /US equity and UTC USDG closes differ/);
  assert.match(history.source, /no filling or interpolation/);
  assert.match(history.source, /zero return benchmark/);
  assert.equal(provenance.preset, 'stock-usdg-1y');
  assert.equal(provenance.observationCount, history.observations.length);
  assert.equal(provenance.firstCloseDate, new Date(f.dates[0]).toISOString().slice(0, 10));
  assert.equal(provenance.firstReturnDate, history.observations[0].date);
  assert.equal(provenance.lastReturnDate, history.observations.at(-1)!.date);
  assert.equal(provenance.historySha256, createHash('sha256').update(JSON.stringify(history)).digest('hex'));
  assert.equal(provenance.sources.usdg, f.calls.at(-1)!.url);
});

test('other configured manifest stocks use their exact underlying symbols', async () => {
  const ids = ['USDG', 'TSLA', 'AMZN', 'RUN', 'MRNA'];
  const f = fixture(ids);
  const { history, provenance } = await fetchSharpeHistory(ids, { now: f.now, fetch: f.fetch });
  assert.deepEqual(Object.keys(history.observations[0].returns), ['AMZN', 'MRNA', 'RUN', 'TSLA', 'USDG']);
  assert.deepEqual(Object.keys(provenance.sources.stocks), ['AMZN', 'MRNA', 'RUN', 'TSLA']);
});

test('invalid, duplicate, gas-only or missing asset identities reject before fetch', async () => {
  for (const ids of [[], IDS.slice(1), ['USDG', 'ETH', 'NVDA', 'MSFT', 'AMD'],
    ['USDG', 'AAPL', 'AAPL', 'MSFT', 'AMD'], ['USDG', '../AAPL', 'NVDA', 'MSFT', 'AMD'],
    ['USDG', 'aapl', 'NVDA', 'MSFT', 'AMD']]) {
    let calls = 0;
    await assert.rejects(fetchSharpeHistory(ids, { fetch: async () => { calls++; throw new Error(); } }), /manifest stocks/);
    assert.equal(calls, 0);
  }
  const f = fixture();
  await assert.rejects(fetchSharpeHistory(IDS, { now: new Date(NaN), fetch: f.fetch }), /request is invalid/);
  assert.equal(f.calls.length, 0);
});

test('current stock bars and the current Kraken candle cannot enter the sample', async () => {
  const now = new Date('2026-09-14T18:00:00Z');
  const f = fixture(IDS, now);
  for (const id of IDS.filter(id => id !== 'USDG')) {
    const data = f.stock(id);
    data.timestamp.push(Date.parse('2026-09-14T13:30:00Z') / 1000);
    data.indicators.adjclose[0].adjclose.push(null);
    data.indicators.quote[0].close.push(null);
  }
  const last = f.payloads.USDG.result.USDGUSD.at(-1);
  for (let i = 1; i <= 5; i++) last[i] = '50.0';
  const { history } = await fetchSharpeHistory(IDS, { now, fetch: f.fetch });
  assert.equal(history.observations.at(-1)!.date, '2026-09-11');
  assert.ok(history.observations.every(row => Math.abs(row.returns.USDG) < 0.01));
});

test('provider-declared stock identity, adjustment arrays, chronology and complete prices are required', async t => {
  const mutations: Record<string, (f: ReturnType<typeof fixture>) => void> = {
    'provider error': f => { f.payloads.AAPL.chart.error = { description: 'not a trusted instruction' }; },
    'missing result': f => { f.payloads.AAPL.chart.result = []; },
    'wrong symbol': f => { f.stock().meta.symbol = 'NVDA'; },
    'wrong currency': f => { f.stock().meta.currency = 'CAD'; },
    'wrong instrument': f => { f.stock().meta.instrumentType = 'ETF'; },
    'wrong zone': f => { f.stock().meta.exchangeTimezoneName = 'Europe/London'; },
    'wrong interval': f => { f.stock().meta.dataGranularity = '1wk'; },
    'wrong range': f => { f.stock().meta.range = '1mo'; },
    'missing adjustment': f => { delete f.stock().indicators.adjclose; },
    'short adjustment': f => { f.stock().indicators.adjclose[0].adjclose.pop(); },
    'short quote': f => { f.stock().indicators.quote[0].close.pop(); },
    'missing adjustment price': f => { f.stock().indicators.adjclose[0].adjclose[50] = null; },
    'zero adjustment': f => { f.stock().indicators.adjclose[0].adjclose[50] = 0; },
    'negative quote': f => { f.stock().indicators.quote[0].close[50] = -1; },
    'duplicate timestamp': f => { f.stock().timestamp[50] = f.stock().timestamp[49]; },
    'duplicate date': f => { f.stock().timestamp[50] = f.stock().timestamp[49] + 60; },
    'future timestamp': f => { f.stock().timestamp[f.stock().timestamp.length - 1] = f.now.getTime() / 1000 + DAY / 1000; },
    'too many rows': f => { f.stock().timestamp = Array(2002).fill(1); },
  };
  for (const [name, mutate] of Object.entries(mutations)) await t.test(name, async () => {
    const f = fixture(); mutate(f);
    await assert.rejects(fetchSharpeHistory(IDS, { now: f.now, fetch: f.fetch }), /AAPL adjusted share data/);
  });
});

test('one missing stock session is not hidden by common-calendar intersection', async () => {
  const f = fixture(); removeStockRow(f, 'AAPL', 50);
  await assert.rejects(fetchSharpeHistory(IDS, { now: f.now, fetch: f.fetch }), /stock calendars disagree/);
});

test('short, sparse and stale one-year panels fail rather than being relabelled', async t => {
  for (const [name, range] of Object.entries({ short: [0, 240], sparse: [80, 20], stale: [250, 20] })) await t.test(name, async () => {
    const f = fixture();
    for (const id of IDS.filter(id => id !== 'USDG')) for (let i = 0; i < range[1]; i++) removeStockRow(f, id, range[0]);
    await assert.rejects(fetchSharpeHistory(IDS, { now: f.now, fetch: f.fetch }), /missing or malformed|incomplete, sparse or stale/);
  });
});

test('identical weekly or alternate-session calendars cannot masquerade as daily one-year history', async t => {
  for (const mode of ['weekly', 'alternate'] as const) await t.test(mode, async () => {
    const f = fixture();
    for (const id of IDS.filter(id => id !== 'USDG')) {
      for (let i = f.dates.length - 1; i >= 0; i--) {
        const keep = mode === 'weekly' ? new Date(f.dates[i]).getUTCDay() === 1 : i % 2 === 0;
        if (!keep) removeStockRow(f, id, i);
      }
    }
    const times: number[] = f.stock().timestamp;
    // These cover the full year, remain fresh and contain no gap above seven
    // calendar days. Only the annual session-count guard rejects them.
    assert.ok(times.length >= 21 && times.length < 200);
    assert.ok(times.every((time, i) => i === 0 || time - times[i - 1] <= 7 * DAY / 1000));
    await assert.rejects(fetchSharpeHistory(IDS, { now: f.now, fetch: f.fetch }), /incomplete, sparse or stale/);
  });
});

test('Kraken pair, daily boundaries, complete prices and continuous coverage are required', async t => {
  const mutations: Record<string, (f: ReturnType<typeof fixture>) => void> = {
    'provider error': f => { f.payloads.USDG.error = ['untrusted provider message']; },
    'wrong pair': f => { f.payloads.USDG.result.USDCUSD = f.payloads.USDG.result.USDGUSD; delete f.payloads.USDG.result.USDGUSD; },
    'extra pair': f => { f.payloads.USDG.result.USDCUSD = []; },
    'missing cursor': f => { delete f.payloads.USDG.result.last; },
    'future cursor': f => { f.payloads.USDG.result.last = f.now.getTime() / 1000 + 100; },
    'duplicate candle': f => { f.payloads.USDG.result.USDGUSD[50][0] = f.payloads.USDG.result.USDGUSD[49][0]; },
    'missing candle': f => { f.payloads.USDG.result.USDGUSD.splice(50, 1); },
    'non-daily candle': f => { f.payloads.USDG.result.USDGUSD[50][0]++; },
    'negative price': f => { f.payloads.USDG.result.USDGUSD[50][4] = '-1'; },
    'zero price': f => { f.payloads.USDG.result.USDGUSD[50][4] = '0'; },
    'not numeric': f => { f.payloads.USDG.result.USDGUSD[50][4] = '0x01'; },
    'invalid range': f => { f.payloads.USDG.result.USDGUSD[50][4] = '10'; },
    'missing field': f => { f.payloads.USDG.result.USDGUSD[50].pop(); },
    'stale current candle': f => { f.payloads.USDG.result.USDGUSD.pop(); },
    'over provider limit': f => { f.payloads.USDG.result.USDGUSD = Array(721).fill([]); },
  };
  for (const [name, mutate] of Object.entries(mutations)) await t.test(name, async () => {
    const f = fixture(); mutate(f);
    await assert.rejects(fetchSharpeHistory(IDS, { now: f.now, fetch: f.fetch }), /USDG/);
  });
  const f = fixture(); f.payloads.USDG.result.USDGUSD.splice(0, 20);
  await assert.rejects(fetchSharpeHistory(IDS, { now: f.now, fetch: f.fetch }), /cover every selected equity session/);
});

test('HTTP failure, unexpected destinations and malformed bodies fail without echoing remote text', async t => {
  const cases: Record<string, () => Response> = {
    'HTTP error': () => new Response('provider-secret', { status: 503 }),
    'not JSON': () => new Response('provider-secret'),
    'bad JSON': () => new Response('provider-secret', { headers: { 'content-type': 'application/json' } }),
    'body error': () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('provider-secret')); } }), { headers: { 'content-type': 'application/json' } }),
    'invalid UTF8': () => new Response(new Uint8Array([0xc3, 0x28]), { headers: { 'content-type': 'application/json' } }),
    'redirected': () => { const r = Response.json({}); Object.defineProperty(r, 'redirected', { value: true }); return r; },
    'wrong URL': () => { const r = Response.json({}); Object.defineProperty(r, 'url', { value: 'https://attacker.invalid' }); return r; },
    'excessive size header': () => new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '2097153' } }),
  };
  for (const [name, response] of Object.entries(cases)) await t.test(name, async () => {
    let calls = 0;
    await assert.rejects(fetchSharpeHistory(IDS, { now: NOW, fetch: async () => { calls++; return response(); } }), error => {
      assert.match(String(error), /Sharpe history unavailable/); assert.doesNotMatch(String(error), /provider-secret|attacker/); return true;
    });
    assert.equal(calls, 5);
  });
});

test('actual streamed byte limit cancels oversized responses even without content-length', async () => {
  let cancellations = 0;
  const fetch: typeof globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); }, cancel() { cancellations++; },
  }), { headers: { 'content-type': 'application/json' } });
  await assert.rejects(fetchSharpeHistory(IDS, { now: NOW, fetch }), /size limit/);
  assert.equal(cancellations, 5);
});

test('deadline covers ignored-abort fetches; late responses cannot succeed or retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); const waiters: ((response: Response) => void)[] = [];
  const signals: AbortSignal[] = [];
  const pending = fetchSharpeHistory(IDS, { now: NOW, fetch: async (_input, init) => {
    signals.push(init!.signal!); return new Promise<Response>(resolve => waiters.push(resolve));
  } });
  const rejection = assert.rejects(pending, /timed out/);
  assert.equal(waiters.length, 5);
  t.mock.timers.tick(15_000); await rejection;
  assert.ok(signals.every(signal => signal.aborted));
  waiters.forEach(resolve => resolve(Response.json(f.payloads.USDG)));
  await immediate(); assert.equal(waiters.length, 5);
});

test('deadline also bounds a body that never finishes and cancels all readers', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let cancellations = 0;
  const pending = fetchSharpeHistory(IDS, { now: NOW, fetch: async () => new Response(new ReadableStream<Uint8Array>({
    cancel() { cancellations++; },
  }), { headers: { 'content-type': 'application/json' } }) });
  const rejection = assert.rejects(pending, /timed out/);
  await immediate(); t.mock.timers.tick(15_000); await rejection;
  assert.equal(cancellations, 5);
});
