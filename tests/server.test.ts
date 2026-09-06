import assert from 'node:assert/strict';
import { watch, type FSWatcher } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { get, request, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { runInNewContext } from 'node:vm';
import { serve } from '../src/server.js';
import { atomicWriteJson, readJson } from '../src/storage.js';
import type { Status } from '../src/runtime.js';

const initial: Status = { app: 'Rebalance', chain: { id: 4663, name: 'Robinhood' }, mode: null,
  wallet: null, config: null, cycle: null, portfolio: null, operation: null,
  updatedAt: null, error: null, graph: { node: 'wait', trace: ['wait'] }, armed: false };

async function waitFor(condition: () => boolean, message: string) {
  const deadline = Date.now() + 3_000;
  while (!condition() && Date.now() < deadline) await delay(10);
  assert.ok(condition(), message);
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'rebalance-chart-'));
  const path = (name: string) => join(directory, name);
  await atomicWriteJson(path('status.json'), initial);
  let activeWatchers = 0;
  let reads = 0;
  let gasReads = 0;
  const watchers: FSWatcher[] = [];
  const server = await serve(0, { dataDir: directory,
    readConfig: async () => null,
    readGas: async () => {
      gasReads++;
      return { gasPriceWei: '15000000', ethUsdE8: '400000000000',
        gasObservedAt: '2026-09-06T02:00:00.000Z', usdObservedAt: '2026-09-06T02:00:00.000Z' };
    },
    readStatus: async () => {
      reads++;
      const saved = await readJson<Status>(path('status.json'));
      if (!saved) throw new Error('Fixture status absent');
      return { ...saved, config: await readJson<Status['config']>(path('config.json')),
        cycle: await readJson<Status['cycle']>(path('cycle.json')) };
    },
    watchChanges: (dir, listener) => {
      assert.equal(dir, directory);
      const watcher = watch(dir, listener);
      watchers.push(watcher); activeWatchers++;
      watcher.once('close', () => { activeWatchers--; });
      return watcher;
    },
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await server.closeChart();
    await rm(directory, { recursive: true, force: true });
  });
  return { url, path, server, watchers, get activeWatchers() { return activeWatchers; }, get reads() { return reads; },
    get gasReads() { return gasReads; } };
}

function readResponse(url: string, method = 'GET', headers: Record<string, string> = {}) {
  return new Promise<{ code: number; body: string; headers: IncomingMessage['headers'] }>((resolve, reject) => {
    const req = request(url, { method, headers }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ code: res.statusCode!, body, headers: res.headers }));
      res.on('error', reject);
    });
    req.on('error', reject); req.end();
  });
}

function subscribe(url: string) {
  return new Promise<{ response: IncomingMessage; events: Status[]; close: () => void }>((resolve, reject) => {
    const req = get(`${url}/api/status/events`, response => {
      const events: Status[] = [];
      let buffer = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        buffer += chunk;
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          if (!frame.startsWith('event: status\n')) continue;
          events.push(JSON.parse(frame.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n')));
        }
      });
      response.on('error', () => {});
      resolve({ response, events, close: () => { response.destroy(); req.destroy(); } });
    });
    req.on('error', reject);
  });
}

test('chart HTTP and SSE retain host/origin checks, view-only methods and ordinary HEAD behavior', async t => {
  const f = await fixture(t);
  const read = await readResponse(`${f.url}/api/status`);
  assert.equal(read.code, 200); assert.deepEqual(JSON.parse(read.body), initial);
  assert.match(String(read.headers['content-security-policy']), /connect-src 'self'/);
  const beforeHead = f.reads;
  assert.equal((await readResponse(`${f.url}/api/status`, 'HEAD')).body, '');
  assert.equal(f.reads, beforeHead, 'HEAD does not observe portfolio data');
  assert.equal((await readResponse(`${f.url}/`, 'HEAD')).code, 200);
  const gas = await readResponse(`${f.url}/api/gas`);
  assert.equal(gas.code, 200);
  const gasBody = JSON.parse(gas.body);
  assert.deepEqual({ ...gasBody, reference: undefined, rebalance: undefined }, {
    gasPriceWei: '15000000', ethUsdE8: '400000000000', gasObservedAt: '2026-09-06T02:00:00.000Z',
    usdObservedAt: '2026-09-06T02:00:00.000Z', reference: undefined, rebalance: undefined });
  assert.equal(gasBody.reference.chainId, 4663);
  assert.equal(gasBody.reference.swapGas, '168785');
  assert.equal(gasBody.reference.approvalGas, '57976');
  assert.equal(gasBody.rebalance, null, 'unconfigured fixtures have no invented rebalance estimate');
  const readsBeforeGasHead = f.reads;
  assert.equal((await readResponse(`${f.url}/api/gas`, 'HEAD')).body, '');
  assert.equal(f.gasReads, 1, 'HEAD does not request external gas or USD quotes');
  assert.equal(f.reads, readsBeforeGasHead, 'HEAD does not project portfolio trades');
  for (const endpoint of ['/api/status', '/api/status/events', '/api/gas']) {
    assert.equal((await readResponse(f.url + endpoint, 'POST')).code, 405);
    assert.equal((await readResponse(f.url + endpoint, 'GET', { Host: 'attacker.example' })).code, 403);
    assert.equal((await readResponse(f.url + endpoint, 'GET', { Origin: 'https://attacker.example' })).code, 403);
  }
  const headStream = await readResponse(`${f.url}/api/status/events`, 'HEAD');
  assert.equal(headStream.code, 405); assert.equal(headStream.headers.allow, 'GET');
  assert.equal(f.activeWatchers, 0);
  assert.equal(f.gasReads, 1, 'rejected requests never read quote sources');
  assert.deepEqual(await readJson(f.path('status.json')), initial);
});

test('SSE publishes initial state and atomic public file changes without periodic status reads', async t => {
  const f = await fixture(t);
  const stream = await subscribe(f.url); t.after(stream.close);
  assert.equal(stream.response.statusCode, 200);
  assert.match(String(stream.response.headers['content-type']), /text\/event-stream/);
  await waitFor(() => stream.events.length === 1, 'initial public snapshot');
  assert.deepEqual(stream.events[0], initial);
  assert.equal(f.activeWatchers, 1);
  const saved = { ...initial, updatedAt: '2026-09-05T23:00:00.000Z', nativeBalance: 23n };
  await atomicWriteJson(f.path('status.json'), saved);
  await waitFor(() => stream.events.length === 2, 'atomic status replacement wakes chart');
  assert.equal(stream.events[1]?.updatedAt, saved.updatedAt);
  assert.equal(stream.events[1]?.nativeBalance, '23');
  const config = { targets: { USDG: 500, AAPL: 2375, NVDA: 2375, MSFT: 2375, AMD: 2375 }, rebalanceIntervalSeconds: 3600 };
  await atomicWriteJson(f.path('config.json'), config);
  await waitFor(() => stream.events.length === 3, 'target replacement wakes chart');
  assert.deepEqual(stream.events[2]?.config, config);
  const cycle = { startedAt: '2026-09-05T23:00:00Z', activeUntil: '2026-09-05T23:10:00Z', nextEligibleAt: '2026-09-06T00:00:00Z' };
  await atomicWriteJson(f.path('cycle.json'), cycle);
  await waitFor(() => stream.events.length === 4, 'cycle replacement wakes chart');
  assert.deepEqual(stream.events[3]?.cycle, cycle);
  await delay(50);
  const stableReads = f.reads;
  await atomicWriteJson(f.path('unrelated-fixture.json'), { ignored: true });
  await delay(80);
  assert.equal(f.reads, stableReads, 'irrelevant files and idle time do not cause status sweeps');
  await atomicWriteJson(f.path('status.json'), saved);
  await waitFor(() => f.reads > stableReads, 'same-state event is read');
  assert.equal(stream.events.length, 4, 'unchanged public state is not sent again');
  stream.close();
  await waitFor(() => f.activeWatchers === 0, 'disconnect closes directory watcher');
});

test('SSE coalesces dirty updates while backpressured and sends the latest state after drain', async t => {
  const f = await fixture(t);
  let response: ServerResponse | undefined;
  let blocked = false;
  f.server.on('request', (req, res) => {
    if (req.url !== '/api/status/events') return;
    response = res;
    const write = res.write.bind(res);
    res.write = ((...args: Parameters<ServerResponse['write']>) => {
      const result = write(...args);
      if (!blocked && String(args[0]).startsWith('event: status')) { blocked = true; return false; }
      return result;
    }) as ServerResponse['write'];
  });
  const stream = await subscribe(f.url); t.after(stream.close);
  await waitFor(() => stream.events.length === 1 && blocked, 'initial frame enters backpressure');
  const reads = f.reads;
  await atomicWriteJson(f.path('status.json'), { ...initial, updatedAt: 'first' });
  await atomicWriteJson(f.path('status.json'), { ...initial, updatedAt: 'latest' });
  await delay(80);
  assert.equal(f.reads, reads, 'no more reads are queued for a stalled consumer');
  response!.emit('drain');
  await waitFor(() => stream.events.length === 2, 'drain releases one coalesced refresh');
  assert.equal(stream.events[1]?.updatedAt, 'latest');
});

test('watch errors close the stream and release resources so a client can reconnect', async t => {
  const f = await fixture(t);
  const first = await subscribe(f.url); t.after(first.close);
  await waitFor(() => first.events.length === 1, 'first stream initialized');
  f.watchers[0]!.emit('error', new Error('fixture watch failure'));
  await waitFor(() => first.response.destroyed && f.activeWatchers === 0, 'failed watch closes the stream');
  const next = await subscribe(f.url); t.after(next.close);
  await waitFor(() => next.events.length === 1, 'reconnected stream sends fresh state');
  assert.equal(f.activeWatchers, 1);
  next.close();
  await waitFor(() => f.activeWatchers === 0, 'reconnected watch cleans up');
});

test('chart shutdown finishes with an active SSE client and closes its watcher', { timeout: 5_000 }, async t => {
  const f = await fixture(t);
  const stream = await subscribe(f.url); t.after(stream.close);
  await waitFor(() => stream.events.length === 1, 'stream remains active before shutdown');
  assert.equal(f.activeWatchers, 1);
  const closing = f.server.closeChart();
  assert.equal(f.server.closeChart(), closing, 'repeated shutdown signals share one close');
  await closing;
  await waitFor(() => stream.response.destroyed && f.activeWatchers === 0, 'shutdown closes the client and file watcher');
  assert.equal(f.server.listening, false);
});

test('chart uses events while connected and one polling fallback only while disconnected', async () => {
  const script = await readFile(new URL('../ui/app.js', import.meta.url), 'utf8');
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let nextTimer = 0;
  let fetches = 0;
  let renders = 0;
  let deferFetch = false;
  let resolveFetch: (() => void) | undefined;
  const lifecycle = new Map<string, () => void>();
  const elements = new Map<string, { textContent: string; replaceChildren: () => void; append: () => void; setAttribute: () => void }>();
  const statusTimers = () => [...timers.values()].filter(timer => timer.ms === 4500 || timer.fn.name === 'refresh');
  class Source {
    static instances: Source[] = [];
    handlers = new Map<string, (event: { data: string }) => void>();
    onerror: (() => void) | undefined;
    closed = false;
    constructor(url: string) { assert.equal(url, '/api/status/events'); Source.instances.push(this); }
    addEventListener(name: string, fn: (event: { data: string }) => void) { this.handlers.set(name, fn); }
    close() { this.closed = true; }
    send(snapshot: Status) { this.handlers.get('status')!({ data: JSON.stringify(snapshot) }); }
  }
  runInNewContext(script, {
    EventSource: Source, AbortController,
    setTimeout: (fn: () => void, ms: number) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id: number) => timers.delete(id),
    fetch: async (url: string) => {
      if (url === '/api/gas') return { ok: true, json: async () => ({ gasPriceWei: null, ethUsdE8: null, gasObservedAt: null, usdObservedAt: null }) };
      fetches++;
      if (deferFetch) await new Promise<void>(resolve => { resolveFetch = resolve; });
      return { ok: true, json: async () => initial };
    },
    window: { addEventListener: (name: string, fn: () => void) => lifecycle.set(name, fn) },
    document: {
      getElementById: (id: string) => {
        if (!elements.has(id)) elements.set(id, { textContent: '', replaceChildren: () => { if (id === 'segments') renders++; }, append: () => {}, setAttribute: () => {} });
        return elements.get(id);
      },
      createElementNS: () => ({ setAttribute: () => {}, textContent: '' }),
    },
  });
  const source = Source.instances[0]!;
  assert.equal(fetches, 0, 'normal connection begins without a polling fetch');
  source.send(initial);
  assert.equal(statusTimers().length, 0, 'valid stream disables the initial fallback deadline');
  assert.equal(renders, 1);
  source.send(initial);
  assert.equal(renders, 1, 'identical events do not redraw the pie');
  source.onerror!(); source.onerror!();
  await delay(0);
  assert.equal(fetches, 1, 'repeated errors share one fallback request');
  assert.equal([...timers.values()].filter(timer => timer.ms === 5000).length, 1);
  source.send({ ...initial, updatedAt: 'fresh' });
  assert.equal(statusTimers().length, 0, 'reconnection cancels the polling timeout');
  assert.equal(fetches, 1); assert.equal(renders, 2);
  deferFetch = true;
  source.onerror!();
  source.send({ ...initial, updatedAt: 'newer' });
  source.onerror!();
  resolveFetch!();
  await delay(0);
  assert.equal(fetches, 2); assert.equal(renders, 3, 'a late fallback cannot overwrite a newer streamed observation');
  source.send({ ...initial, updatedAt: 'newer' });
  lifecycle.get('pagehide')!();
  assert.equal(source.closed, true); assert.equal(timers.size, 0);
  lifecycle.get('pageshow')!();
  assert.equal(Source.instances.length, 2, 'restoring the page reconnects once');
  source.send(initial); source.onerror!();
  assert.equal(renders, 3, 'events from the closed page connection are ignored');
  lifecycle.get('pagehide')!();
});
