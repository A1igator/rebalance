import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { request, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { connectionPath, type RoutedProfile } from '../scripts/profile-routing.mjs';
import { serve } from '../src/server.js';
import { issueView, pendingViewRequests } from '../src/view-session.js';
import { atomicWriteJson, readJson } from '../src/storage.js';

const walletA = `0x${'a'.repeat(40)}`, walletB = `0x${'b'.repeat(40)}`;
const sessionA = 'claude:http-fixture-a', sessionB = 'claude:http-fixture-b';
const config = (wallet: string) => ({ version: 1, wallet, chainId: 4663, mode: 'ledger', rpcUrl: 'https://fixture.invalid',
  targets: { USDG: 500, AAPL: 2500, NVDA: 2500, MSFT: 2500, AMD: 2000 }, driftThresholdBps: 500,
  slippageBps: 50, deadlineSeconds: 120, pollSeconds: 30, rebalanceIntervalSeconds: 3600 });

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'rebalance-server-view-'));
  const ensured: RoutedProfile[] = [];
  let ensureFailure = false;
  const unexpectedRead = async (): Promise<never> => { throw new Error('View routes must not query chart balances, gas or process-global configuration'); };
  const server = await serve(0, { dataDir: root, rootDir: root,
    ensureChart: async profile => { ensured.push(profile); if (ensureFailure) throw new Error('Fixture chart unavailable'); return { state: 'ready', url: `http://127.0.0.1:${profile.chartPort}/chart` }; },
    readConfig: unexpectedRead, readGas: unexpectedRead, readStatus: unexpectedRead,
  });
  const address = server.address(); assert.ok(address && typeof address === 'object');
  t.after(async () => { await server.closeChart(); await rm(root, { recursive: true, force: true }); });
  return { root, server, url: `http://127.0.0.1:${address.port}`, ensured,
    failEnsure: () => { ensureFailure = true; },
    register: async () => {
      await atomicWriteJson(join(root, 'portfolios.json'), { version: 1, profiles: [
        { wallet: walletA, chainId: 4663, directory: '.', chartPort: 4663 },
        { wallet: walletB, chainId: 4663, directory: `wallets/${walletB}`, chartPort: 4664 },
      ] });
      await atomicWriteJson(join(root, 'config.json'), config(walletA));
      await atomicWriteJson(join(root, 'wallets', walletB, 'config.json'), config(walletB));
    },
  };
}
function call(url: string, path: string, options: { method?: string; body?: unknown; raw?: string; headers?: Record<string, string | undefined> } = {}) {
  return new Promise<{ code: number; body: string; headers: IncomingMessage['headers'] }>((resolve, reject) => {
    const headers = Object.fromEntries(Object.entries({ Origin: url, 'Content-Type': 'application/json', ...options.headers })
      .filter((entry): entry is [string, string] => entry[1] !== undefined));
    const req = request(url + path, { method: options.method ?? 'POST', headers }, response => {
      let body = ''; response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ code: response.statusCode!, body, headers: response.headers }));
      response.on('error', reject);
    });
    req.on('error', reject); req.end(options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body)));
  });
}
async function until(condition: () => boolean, message: string) {
  for (let i = 0; i < 300; i++) { if (condition()) return; await delay(10); }
  assert.fail(message);
}
type ViewUpdate = { connectedWallet: string | null; canSetup: boolean; chartUrl: string | null;
  portfolios: {wallet: string; chartUrl:string}[] };
function subscribe(url: string, token: string) {
  return new Promise<{ events: ViewUpdate[]; close: () => void; response: IncomingMessage }>((resolve, reject) => {
    const req = request(url + '/api/view/events', { method: 'POST', headers: { Origin: url, 'Content-Type': 'application/json' } }, response => {
      if (response.statusCode !== 200) { response.resume(); reject(new Error(`Fixture SSE returned ${response.statusCode}`)); return; }
      const events: ViewUpdate[] = []; let pending = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        pending += chunk;
        let boundary;
        while ((boundary = pending.indexOf('\n\n')) >= 0) {
          const frame = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
          if (frame.startsWith('event: view\n')) events.push(JSON.parse(frame.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n')));
        }
      });
      response.on('error', () => {});
      resolve({ events, response, close: () => { response.destroy(); req.destroy(); } });
    });
    req.on('error', reject); req.end(JSON.stringify({ token }));
  });
}

test('view HTTP routes reject foreign origin/host, missing origin, non-JSON and oversized or unexpected input', async t => {
  const f = await fixture(t), { token } = await issueView(f.root, sessionA);
  for (const path of ['/api/view', '/api/connect', '/api/setup', '/api/view/events']) {
    assert.equal((await call(f.url, path, { method: 'GET' })).code, 405);
    for (const headers of [
      { Origin: undefined }, { Origin: 'https://foreign.invalid' },
      { Host: 'foreign.invalid', Origin: 'http://foreign.invalid' },
      { 'Content-Type': 'text/plain' },
    ]) assert.equal((await call(f.url, path, { headers, body: { token } })).code, 403);
  }
  assert.equal((await call(f.url, '/api/view', { raw: '{bad-json' })).code, 400);
  assert.equal((await call(f.url, '/api/view', { body: [] })).code, 400);
  assert.equal((await call(f.url, '/api/view', { body: { token, sessionId: sessionB } })).code, 400);
  assert.equal((await call(f.url, '/api/setup', { body: { token, mode: 'ledger', requestId: randomUUID(), prompt: 'untrusted browser prompt' } })).code, 400);
  assert.equal((await call(f.url, '/api/view', { raw: JSON.stringify({ token: 'x'.repeat(3000) }) })).code, 413);
  for (const invalid of ['../capability', 'f'.repeat(64), token.toUpperCase()]) {
    assert.equal((await call(f.url, '/api/view', { body: { token: invalid } })).code, 403);
  }
  assert.equal(f.ensured.length, 0); assert.deepEqual(await pendingViewRequests(f.root, sessionA), []);
  const state = await call(f.url, '/api/view', { body: { token }, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  assert.equal(state.code, 200); assert.deepEqual(JSON.parse(state.body), { connectedWallet: null, canSetup: true });
  assert.equal(state.headers['cache-control'], 'no-store'); assert.equal(state.headers['referrer-policy'], 'no-referrer');
  assert.match(String(state.headers['content-security-policy']), /frame-ancestors 'none'/);
});

test('public selector metadata works empty and isolates one damaged portfolio', async t => {
  const f = await fixture(t);
  const empty = await call(f.url, '/api/portfolios', { method: 'GET' });
  assert.equal(empty.code, 200); assert.deepEqual(JSON.parse(empty.body), { portfolios: [] });
  await f.register();
  await atomicWriteJson(join(f.root, 'wallets', walletB, 'config.json'), { broken: true });
  const listed = await call(f.url, '/api/portfolios', { method: 'GET' });
  assert.equal(listed.code, 200);
  const entries = JSON.parse(listed.body).portfolios;
  assert.equal(entries.length, 2); assert.equal(entries[0].mode, 'ledger'); assert.equal(entries[0].error, undefined);
  assert.equal(entries[1].mode, null); assert.match(entries[1].error, /configuration is unavailable/);
  assert.equal(entries[0].chartUrl, 'http://127.0.0.1:4663/chart');
  assert.equal(entries[1].chartUrl, 'http://127.0.0.1:4664/chart');
  assert.equal(f.ensured.length, 0);
});

test('connect HTTP requests bind the capability conversation only after its chart is available', async t => {
  const f = await fixture(t); await f.register();
  const a = await issueView(f.root, sessionA), b = await issueView(f.root, sessionB);
  const protectedFiles = ['config.json', 'pending.json', 'recovery.json', 'cycle.json', 'stop.json'];
  const preserved = new Map<string, string>();
  for (const name of protectedFiles) {
    if (name !== 'config.json') await atomicWriteJson(join(f.root, name), { fixture: name });
    preserved.set(name, await readFile(join(f.root, name), 'utf8'));
  }
  const connect = await call(f.url, '/api/connect', { body: { token: a.token, wallet: walletB } });
  assert.equal(connect.code, 200); assert.deepEqual(JSON.parse(connect.body), { wallet: '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB', chartUrl: 'http://127.0.0.1:4664/chart', tradingChanged: false });
  assert.deepEqual(f.ensured.map(profile => profile.wallet), [walletB]);
  assert.equal((await readJson<{wallet:string}>(connectionPath(f.root, sessionA)))?.wallet, walletB);
  assert.equal(await readJson(connectionPath(f.root, sessionB)), null);
  assert.deepEqual(JSON.parse((await call(f.url, '/api/view', { body: { token: b.token } })).body), { connectedWallet: null, canSetup: true });
  assert.notEqual((await call(f.url, '/api/connect', { body: { token: a.token, wallet: `0x${'c'.repeat(40)}` } })).code, 200);
  f.failEnsure();
  assert.equal((await call(f.url, '/api/connect', { body: { token: a.token, wallet: walletA } })).code, 503);
  assert.equal((await readJson<{wallet:string}>(connectionPath(f.root, sessionA)))?.wallet, walletB, 'a failed chart check cannot claim the conversation connected');
  for (const name of protectedFiles) assert.equal(await readFile(join(f.root, name), 'utf8'), preserved.get(name));
});

test('setup HTTP accepts only a fixed signer intent and retains a Claude request offline without executing setup', async t => {
  const f = await fixture(t), { token } = await issueView(f.root, sessionA), requestId = randomUUID();
  const body = { token, mode: 'ledger', requestId };
  const first = await call(f.url, '/api/setup', { body });
  assert.equal(first.code, 200); assert.equal(JSON.parse(first.body).state, 'pending');
  assert.match(JSON.parse(first.body).message, /waiting for this conversation’s Claude channel/);
  assert.deepEqual(JSON.parse((await call(f.url, '/api/setup', { body })).body), JSON.parse(first.body));
  assert.notEqual((await call(f.url, '/api/setup', { body: { ...body, mode: 'privy' } })).code, 200);
  assert.notEqual((await call(f.url, '/api/setup', { body: { ...body, mode: 'unknown', requestId: randomUUID() } })).code, 200);
  assert.notEqual((await call(f.url, '/api/setup', { body: { ...body, requestId: '../arbitrary' } })).code, 200);
  const pending = await pendingViewRequests(f.root, sessionA);
  assert.equal(pending.length, 1); assert.equal(pending[0].mode, 'ledger'); assert.equal(pending[0].requestId, requestId);
  assert.deepEqual(await pendingViewRequests(f.root, sessionB), []);
  assert.equal(f.ensured.length, 0); assert.equal(await readJson(join(f.root, 'config.json')), null);
  assert.equal(await readJson(connectionPath(f.root, sessionA)), null, 'request acceptance does not claim wallet creation or connection');
});

test('view SSE reports session-scoped connection changes without leaking its token or following another chat', { timeout: 10_000 }, async t => {
  const f = await fixture(t); await f.register();
  const a = await issueView(f.root, sessionA), b = await issueView(f.root, sessionB);
  const first = await subscribe(f.url, a.token), second = await subscribe(f.url, b.token);
  t.after(() => { first.close(); second.close(); });
  await until(() => first.events.length === 1 && second.events.length === 1, 'both conversations should get initial view metadata');
  assert.equal(first.response.headers['content-type'], 'text/event-stream; charset=utf-8');
  assert.equal(first.events[0].connectedWallet, null); assert.equal(second.events[0].connectedWallet, null);
  assert.equal(first.events[0].portfolios.length, 2); assert.equal(first.events[0].canSetup, true);
  assert.equal((await call(f.url, '/api/connect', { body: { token: a.token, wallet: walletB } })).code, 200);
  await until(() => first.events.at(-1)?.connectedWallet === walletB, 'an atomic connection replacement should update its view');
  assert.equal(first.events.at(-1)?.chartUrl, 'http://127.0.0.1:4664/chart');
  await delay(100); assert.equal(second.events.length, 1, 'another chat connection must not redirect or emit an unrelated view update');
  await atomicWriteJson(connectionPath(f.root, sessionB), { version: 1, chainId: 4663, wallet: walletA });
  await until(() => second.events.at(-1)?.connectedWallet === walletA, 'direct agent attachment changes should also reach that session view');
  assert.equal(first.events.at(-1)?.connectedWallet, walletB);
  const payload = JSON.stringify([first.events, second.events]);
  for (const privateContext of [a.token, b.token, sessionA, sessionB, f.root]) assert.ok(!payload.includes(privateContext));
  first.close(); second.close();
});
