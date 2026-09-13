import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { Agent, request, type ClientRequest, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { serve } from '../src/server.js';
import { issueView } from '../src/view-session.js';
import type { PortfolioControls } from '../src/portfolio-control.js';
import type { Status } from '../src/runtime.js';

const initial: Status = { app: 'Rebalance', chain: { id: 4663, name: 'Robinhood' }, mode: null,
  wallet: null, config: null, cycle: null, portfolio: null, operation: null,
  updatedAt: null, error: null, graph: { node: 'wait', trace: ['wait'] }, armed: false };
const wallet = `0x${'a'.repeat(40)}`;
type Command = Parameters<PortfolioControls['command']>[0];

async function until(condition: () => boolean, message: string) {
  const deadline = Date.now() + 5000;
  while (!condition() && Date.now() < deadline) await delay(10);
  assert.ok(condition(), message);
}

test('live streams yield capacity so another tab can load a document and issue short requests', { timeout: 15_000 }, async t => {
  // Model a bounded same-origin HTTP/1.1 pool explicitly; this does not assert
  // that any particular browser exposes Node’s Agent or the same default limit.
  const root = await mkdtemp(join(tmpdir(), 'rebalance-server-capacity-'));
  const pool = new Agent({ keepAlive: true, maxSockets: 6, maxTotalSockets: 6 });
  const requests: ClientRequest[] = [], streams: IncomingMessage[] = [];
  const streamBodies = new Map<IncomingMessage, string>();
  const commands: Command[] = [], received: string[] = [];
  const unexpected = async (): Promise<never> => { throw new Error('Capacity fixture must not read gas, configuration or a signer'); };
  const server = await serve(0, { rootDir: root, dataDir: root,
    readStatus: async () => initial, readConfig: unexpected, readGas: unexpected,
    portfolioControls: {
      read: async () => ({ wallet, state: 'stopped' }),
      retry: unexpected,
      command: async input => {
        commands.push(structuredClone(input));
        return { wallet, state: 'starting', requestId: input.requestId, outcome: 'fixture-accepted' };
      },
    },
  });
  t.after(async () => {
    for (const response of streams) response.destroy();
    for (const req of requests) req.destroy();
    pool.destroy();
    await server.closeChart();
    await rm(root, { recursive: true, force: true });
  });
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}`;
  server.on('request', req => { if (req.headers['x-fixture-request']) received.push(String(req.headers['x-fixture-request'])); });
  const { token } = await issueView(root, 'claude:connection-capacity-fixture');
  const sockets = () => Object.values(pool.sockets).reduce((sum, entries) => sum + (entries?.length ?? 0), 0);
  const queued = () => Object.values(pool.requests).reduce((sum, entries) => sum + (entries?.length ?? 0), 0);

  function stream(path: '/api/status/events' | '/api/view/events') {
    return new Promise<IncomingMessage>((resolve, reject) => {
      const post = path === '/api/view/events';
      const req = request(url + path, { agent: pool, method: post ? 'POST' : 'GET',
        headers: post ? { Origin: url, 'Content-Type': 'application/json' } : {} }, response => {
        streams.push(response);
        if (response.statusCode !== 200 || !String(response.headers['content-type']).startsWith('text/event-stream')) {
          response.resume(); reject(new Error('Fixture stream was not established')); return;
        }
        // Wait for a complete initial frame so authorization and both server
        // stream implementations have actually run, not merely flushed headers.
        let body = '';
        response.setEncoding('utf8');
        response.on('error', reject);
        response.on('data', chunk => {
          body += chunk; streamBodies.set(response, body);
          const event = post ? 'view' : 'status';
          if (body.split('\n\n').slice(0, -1).some(frame => frame.startsWith(`event: ${event}\n`))) resolve(response);
        });
      });
      requests.push(req); req.on('error', reject);
      req.end(post ? JSON.stringify({ token }) : undefined);
    });
  }
  function call(marker: string, body?: Command, path = '/api/runner') {
    let assigned = false;
    const done = new Promise<{ code: number; body: unknown }>((resolve, reject) => {
      const req = request(url + path, { agent: pool, method: body ? 'POST' : 'GET',
        headers: { Origin: url, 'Content-Type': 'application/json', 'X-Fixture-Request': marker } }, response => {
        let raw = ''; response.setEncoding('utf8');
        response.on('error', reject); response.on('data', chunk => { raw += chunk; });
        response.on('end', () => { try { resolve({ code: response.statusCode!, body: path === '/chart' ? raw : JSON.parse(raw) }); } catch (error) { reject(error); } });
      });
      requests.push(req); req.on('socket', () => { assigned = true; }); req.on('error', reject);
      req.end(body ? JSON.stringify(body) : undefined);
    });
    void done.catch(() => {}); // Cleanup can destroy queued requests after a failed assertion.
    return { done, assigned: () => assigned };
  }

  const pages: IncomingMessage[][] = [];
  for (let index = 0; index < 3; index++) pages.push(await Promise.all([stream('/api/status/events'), stream('/api/view/events')]));
  await until(() => pages[0]!.every(response => response.readableEnded), 'the oldest streams end without requiring their tab to close');
  assert.ok(pages[0]!.every(response => streamBodies.get(response)?.includes('event: rotate\ndata: {}\n\n')), 'both closed stream types announce planned rotation before EOF');
  assert.ok(sockets() <= 6); assert.equal(queued(), 0);
  assert.equal(streams.filter(response => !response.readableEnded && !response.destroyed).length, 4);

  const body: Command = { token, wallet, action: 'start', requestId: randomUUID() };
  const navigation = call('document', undefined, '/chart');
  const control = call('control', body), read = call('read');
  const [documentResult, controlResult, readResult] = await Promise.all([navigation.done, control.done, read.done]);
  assert.equal(documentResult.code, 200); assert.match(String(documentResult.body), /Rebalance/);
  assert.equal(controlResult.code, 200); assert.equal(readResult.code, 200);
  assert.deepEqual(controlResult.body, { wallet, state: 'starting', requestId: body.requestId, outcome: 'fixture-accepted' });
  assert.deepEqual(readResult.body, { wallet, state: 'stopped' });
  assert.deepEqual(commands, [body], 'only the explicit fixture control is dispatched once');
  assert.deepEqual(received.sort(), ['control', 'document', 'read']);
  assert.equal(queued(), 0);
  assert.equal(pages.slice(1).flat().every(response => !response.destroyed), true, 'other pages keep their four streams');
  await stream('/api/view/events');
  await until(() => pages[1]!.some(response => response.readableEnded), 'an older tab can reconnect and yield the next oldest stream');
  assert.equal(streams.filter(response => !response.readableEnded && !response.destroyed).length, 4);
  assert.equal((await call('document-again', undefined, '/chart').done).code, 200);
  assert.equal(commands.length, 1, 'stream rotation never repeats a control');
});
