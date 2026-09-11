import assert from 'node:assert/strict';
import { watch, type FSWatcher } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { request, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { serve } from '../src/server.js';
import type { PortfolioControls, RunnerSummary } from '../src/portfolio-control.js';
import type { Status } from '../src/runtime.js';
import { issueView } from '../src/view-session.js';
import { atomicWriteJson } from '../src/storage.js';

const walletA = `0x${'a'.repeat(40)}`, walletB = `0x${'b'.repeat(40)}`;
const initial: Status = { app: 'Rebalance', chain: { id: 4663, name: 'Robinhood' }, mode: null,
  wallet: null, config: null, cycle: null, portfolio: null, operation: null,
  updatedAt: null, error: null, graph: { node: 'wait', trace: ['wait'] }, armed: false };
type Command = Parameters<PortfolioControls['command']>[0];

async function fixture(t: TestContext, wallet = walletA) {
  const root = await mkdtemp(join(tmpdir(), 'rebalance-server-runner-'));
  const directory = join(root, 'wallets', wallet);
  await atomicWriteJson(join(directory, 'config.json'), { fixture: 'saved configuration' });
  const configBefore = await readFile(join(directory, 'config.json'), 'utf8');
  let summary: RunnerSummary = { wallet, state: 'stopped' };
  let reads = 0, statusReads = 0, extraReads = 0, watchers = 0, failRead = false, failCommand = false;
  const commands: Command[] = [];
  const controls: Pick<PortfolioControls, 'read' | 'command'> = {
    read: async () => { reads++; if (failRead) throw new Error('fixture-sensitive-read-error'); return summary; },
    command: async input => {
      commands.push(structuredClone(input));
      if (failCommand) throw new Error('fixture-sensitive-command-error');
      return { wallet, state: input.action === 'start' ? 'starting' : 'stopping', requestId: input.requestId, outcome: 'fixture-accepted' };
    },
  };
  const unexpected = async (): Promise<never> => { extraReads++; throw new Error('Runner HTTP must not read holdings, gas or signer state'); };
  const server = await serve(0, { rootDir: root, dataDir: directory, portfolioControls: controls,
    readStatus: async () => { statusReads++; return initial; }, readConfig: unexpected, readGas: unexpected,
    watchChanges: (path, listener) => {
      assert.equal(path, directory);
      const watcher: FSWatcher = watch(path, listener); watchers++;
      watcher.once('close', () => { watchers--; }); return watcher;
    },
  });
  const address = server.address(); assert.ok(address && typeof address === 'object');
  t.after(async () => { await server.closeChart(); await rm(root, { recursive: true, force: true }); });
  return { root, directory, url: `http://127.0.0.1:${address.port}`, server, commands,
    get reads() { return reads; }, get statusReads() { return statusReads; }, get watchers() { return watchers; },
    summary: () => summary, update: (next: RunnerSummary) => { summary = next; },
    failRead: () => { failRead = true; }, failCommand: () => { failCommand = true; },
    unchanged: async () => { assert.equal(extraReads, 0); assert.equal(await readFile(join(directory, 'config.json'), 'utf8'), configBefore); },
  };
}

function call(url: string, options: { path?: string; method?: string; body?: unknown; raw?: string; headers?: Record<string, string | undefined> } = {}) {
  return new Promise<{ code: number; body: string; headers: IncomingMessage['headers'] }>((resolve, reject) => {
    const headers = Object.fromEntries(Object.entries({ Origin: url, 'Content-Type': 'application/json', ...options.headers })
      .filter((entry): entry is [string, string] => entry[1] !== undefined));
    const payload = options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
    if (payload !== undefined) headers['Content-Length'] = String(Buffer.byteLength(payload));
    const transportError = (error: Error) => reject(new Error(`Runner fixture ${options.method ?? 'POST'} with ${Buffer.byteLength(payload ?? '')} body bytes failed`, { cause: error }));
    const req = request(`${url}${options.path ?? '/api/runner'}`, { method: options.method ?? 'POST', headers }, response => {
      let body = ''; response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ code: response.statusCode!, body, headers: response.headers }));
      response.on('error', transportError);
    });
    req.on('error', transportError); req.end(payload);
  });
}
async function until(condition: () => boolean, message: string) {
  const deadline = Date.now() + 5000;
  while (!condition() && Date.now() < deadline) await delay(10);
  assert.ok(condition(), message);
}
function subscribe(url: string) {
  return new Promise<{ events: {type: string; data: unknown}[]; response: IncomingMessage; close: () => void }>((resolve, reject) => {
    const req = request(`${url}/api/status/events`, response => {
      if (response.statusCode !== 200) { response.resume(); reject(new Error('Fixture status stream failed')); return; }
      let buffer = ''; const events: {type: string; data: unknown}[] = [];
      response.setEncoding('utf8');
      response.on('data', chunk => {
        buffer += chunk;
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const lines = buffer.slice(0, boundary).split('\n'); buffer = buffer.slice(boundary + 2);
          const type = lines.find(line => line.startsWith('event: '))?.slice(7);
          if (type) events.push({ type, data: JSON.parse(lines.filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n')) });
        }
      });
      response.on('error', () => {});
      resolve({ events, response, close: () => { response.destroy(); req.destroy(); } });
    });
    req.on('error', reject); req.end();
  });
}

test('runner GET projects only the injected portfolio state and retains local host/origin protections', async t => {
  const f = await fixture(t), other = await fixture(t, walletB);
  other.update({ wallet: walletB, state: 'running' });
  for (const fixture of [f, other]) {
    const result = await call(fixture.url, { method: 'GET', headers: { Origin: undefined } });
    assert.equal(result.code, 200); assert.deepEqual(JSON.parse(result.body), fixture.summary());
    assert.equal(result.headers['cache-control'], 'no-store'); assert.equal(result.headers['referrer-policy'], 'no-referrer');
    assert.equal(fixture.statusReads, 0); assert.deepEqual(fixture.commands, []);
  }
  const reads = f.reads;
  const script = await call(f.url, { path: '/portfolio-controls.js', method: 'GET' });
  assert.equal(script.code, 200); assert.match(String(script.headers['content-type']), /javascript/);
  assert.equal(script.body, await readFile(new URL('../ui/portfolio-controls.js', import.meta.url), 'utf8'));
  const share = await call(f.url, { path: '/share-code.js', method: 'GET' });
  assert.equal(share.code, 200); assert.match(String(share.headers['content-type']), /javascript/);
  assert.equal(share.body, await readFile(new URL('../ui/share-code.js', import.meta.url), 'utf8'));
  for (const headers of [{ Host: 'foreign.invalid' }, { Origin: 'https://foreign.invalid' }]) {
    assert.equal((await call(f.url, { method: 'GET', headers })).code, 403);
  }
  assert.equal(f.reads, reads); await f.unchanged(); await other.unchanged();
});

test('runner commands require same-origin JSON, exact fields and a real local view before reaching controls', async t => {
  const f = await fixture(t), { token } = await issueView(f.root, 'claude:runner-http-fixture');
  const body = { token, wallet: walletA, action: 'start', requestId: randomUUID() };
  for (const headers of [{ Origin: undefined }, { Origin: 'https://foreign.invalid' },
    { Host: 'foreign.invalid', Origin: 'http://foreign.invalid' }, { 'Content-Type': 'text/plain' }]) {
    assert.equal((await call(f.url, { body, headers })).code, 403);
  }
  assert.equal((await call(f.url, { method: 'DELETE', body })).code, 405);
  for (const raw of ['{bad-json', 'null', '[]']) assert.equal((await call(f.url, { raw })).code, 400);
  const { wallet: _wallet, ...missingWallet } = body;
  for (const invalid of [missingWallet, { ...body, prompt: 'untrusted extra input' }, { ...body, token: 123 },
    { ...body, wallet: 'invalid-wallet' }, { ...body, action: 'restart' }, { ...body, requestId: '../request' }]) {
    assert.equal((await call(f.url, { body: invalid })).code, 400);
  }
  assert.equal((await call(f.url, { raw: JSON.stringify({ ...body, token: 'x'.repeat(3000) }) })).code, 413);
  for (const invalid of ['f'.repeat(64), '../capability', token.toUpperCase()]) {
    assert.equal((await call(f.url, { body: { ...body, token: invalid } })).code, 403);
  }
  assert.deepEqual(f.commands, []); assert.equal(f.reads, 0); assert.equal(f.statusReads, 0); await f.unchanged();
});

test('authorized start and stop preserve the exact wallet and request identity passed to the deterministic service', async t => {
  const f = await fixture(t), { token } = await issueView(f.root, 'claude:runner-command-fixture');
  for (const action of ['start', 'stop'] as const) {
    const body = { token, wallet: walletA, action, requestId: randomUUID() };
    const response = await call(f.url, { body, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    assert.equal(response.code, 200); assert.deepEqual(f.commands.at(-1), body);
    assert.deepEqual(JSON.parse(response.body), { wallet: walletA, state: action === 'start' ? 'starting' : 'stopping', requestId: body.requestId, outcome: 'fixture-accepted' });
  }
  assert.equal(f.commands.length, 2); assert.equal(f.reads, 0); assert.equal(f.statusReads, 0); await f.unchanged();
});

test('runner service failures remain unavailable without exposing internal error text or trying another command', async t => {
  const f = await fixture(t), { token } = await issueView(f.root, 'claude:runner-failure-fixture');
  f.failCommand();
  const command = await call(f.url, { body: { token, wallet: walletA, action: 'start', requestId: randomUUID() } });
  assert.equal(command.code, 503); assert.doesNotMatch(command.body, /fixture-sensitive-command-error/);
  assert.equal(f.commands.length, 1);
  f.failRead();
  const read = await call(f.url, { method: 'GET' });
  assert.equal(read.code, 503); assert.doesNotMatch(read.body, /fixture-sensitive-read-error/);
  assert.equal(f.commands.length, 1); await f.unchanged();
});

test('status SSE carries independent runner updates for each watched control file without polling or duplicate status frames', { timeout: 10_000 }, async t => {
  const f = await fixture(t), stream = await subscribe(f.url); t.after(stream.close);
  const runner = () => stream.events.filter(event => event.type === 'runner').map(event => event.data);
  await until(() => runner().length === 1 && stream.events.some(event => event.type === 'status'), 'initial status and runner snapshots');
  assert.deepEqual(runner()[0], f.summary()); assert.equal(f.watchers, 1);
  for (const [index, file] of ['run.lock', 'stop.json', 'launch.lock', 'launch-processes.json'].entries()) {
    const summary: RunnerSummary = { wallet: walletA, state: ['running', 'stopping', 'starting', 'stopped'][index] as RunnerSummary['state'], message: `Fixture ${file}` };
    f.update(summary); await atomicWriteJson(join(f.directory, file), { fixture: file });
    await until(() => JSON.stringify(runner().at(-1)) === JSON.stringify(summary), `${file} should refresh runner state`);
  }
  assert.equal(runner().length, 5);
  assert.equal(stream.events.filter(event => event.type === 'status').length, 1, 'runner changes do not repeat the unchanged price snapshot');
  await delay(50); const reads = f.reads;
  await atomicWriteJson(join(f.directory, 'unrelated-fixture.json'), { ignored: true });
  await delay(80); assert.equal(f.reads, reads, 'idle time and unrelated files do not poll controls');
  await atomicWriteJson(join(f.directory, 'launch-processes.json'), { fixture: 'same public state' });
  await until(() => f.reads > reads, 'eligible same-state file still refreshes');
  assert.equal(runner().length, 5, 'unchanged runner state is not resent');
  assert.deepEqual(f.commands, []); await f.unchanged();
  stream.close(); await until(() => f.watchers === 0, 'disconnect closes the shared watcher');
});

test('initial runner state is retained when the status frame encounters backpressure', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  let response: ServerResponse | undefined, blocked = false;
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
  await until(() => blocked && stream.events.some(event => event.type === 'status'), 'status frame reaches the stalled client');
  response!.emit('drain');
  await until(() => stream.events.some(event => event.type === 'runner'), 'runner snapshot survives the drain boundary');
  assert.deepEqual(stream.events.filter(event => event.type === 'runner').map(event => event.data), [f.summary()]);
  assert.deepEqual(f.commands, []); await f.unchanged();
});
