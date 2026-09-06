import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Notification } from '@modelcontextprotocol/sdk/types.js';

const directory = await mkdtemp(join(tmpdir(), 'rebalance-channel-test-'));
const previousDirectory = process.env.REBALANCE_DATA_DIR;
process.env.REBALANCE_DATA_DIR = directory;
const { events, publishEvent } = await import('../src/events.js');
const sessions: Client[] = [];

after(async () => {
  for (const client of sessions) await client.close();
  if (previousDirectory === undefined) delete process.env.REBALANCE_DATA_DIR;
  else process.env.REBALANCE_DATA_DIR = previousDirectory;
  await rm(directory, { recursive: true, force: true });
});

async function waitFor(condition: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 6_000;
  while (!condition() && Date.now() < deadline) await delay(20);
  assert.ok(condition(), message);
}

async function openSession() {
  const received: Notification[] = [];
  const errors: Error[] = [];
  const client = new Client({ name: 'rebalance-channel-test', version: '1.0.0' }, { capabilities: {} });
  sessions.push(client);
  client.fallbackNotificationHandler = async notification => { received.push(notification); };
  client.onerror = error => { errors.push(error); };
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', fileURLToPath(new URL('../src/channel.ts', import.meta.url))],
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { REBALANCE_DATA_DIR: directory },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  await client.connect(transport);
  return { client, received, errors, stderr: () => stderr };
}

function eventId(notification: Notification): unknown {
  return (notification.params?.meta as Record<string, unknown> | undefined)?.event_id;
}

test('real MCP stdio sessions deliver queued events, expose only acknowledgement, and retain unacknowledged events across restart', { timeout: 25_000 }, async () => {
  const first = {
    id: 'offline-receipt-one', type: 'rebalance-completed' as const,
    createdAt: '2026-09-04T20:00:00.000Z', message: 'A recorded rebalance receipt is ready.',
    hash: `0x${'1'.repeat(64)}`,
  };
  await publishEvent(first);
  const initial = await openSession();
  const capabilities = initial.client.getServerCapabilities();
  assert.deepEqual(capabilities?.experimental, { 'claude/channel': {} });
  const tools = await initial.client.listTools();
  assert.deepEqual(tools.tools.map(tool => tool.name), ['acknowledge_event']);
  const forbidden = await initial.client.callTool({ name: 'sign_transaction', arguments: {} });
  assert.equal(forbidden.isError, true);
  await waitFor(() => initial.received.length === 1, 'offline event should arrive after the MCP initialization handshake');
  const notification = initial.received[0]!;
  assert.equal(notification.method, 'notifications/claude/channel');
  assert.deepEqual(notification.params, {
    content: first.message,
    meta: { event_id: first.id, event_type: first.type, created_at: first.createdAt, transaction_hash: first.hash },
  });
  assert.equal((await events()).length, 1, 'transport delivery must not automatically acknowledge an event');

  const second = {
    id: 'online-ledger-two', type: 'ledger-rebalance-needed' as const,
    createdAt: '2026-09-04T20:05:00.000Z', message: 'Device confirmation is needed for the recorded condition.',
  };
  const queuedAt = Date.now();
  await publishEvent(second);
  await waitFor(() => initial.received.length === 2, 'a newly queued event should arrive while the same session stays open');
  assert.equal(eventId(initial.received[1]!), second.id);
  assert.ok(Date.now() - queuedAt < 1_500, 'atomic queue replacement should wake delivery without the former two-second sweep');
  await delay(2_200);
  assert.deepEqual(initial.received.map(eventId), [first.id, second.id], 'watch notifications must not resend unacknowledged events in the same session');
  const acknowledgement = await initial.client.callTool({ name: 'acknowledge_event', arguments: { id: first.id } });
  assert.notEqual(acknowledgement.isError, true);
  assert.deepEqual((await events()).map(event => event.id), [second.id]);
  const missing = await initial.client.callTool({ name: 'acknowledge_event', arguments: { id: 'not-in-queue' } });
  assert.equal(missing.isError, true);
  assert.deepEqual(initial.errors, []);
  assert.equal(initial.stderr(), '');
  await initial.client.close();

  const resumed = await openSession();
  await waitFor(() => resumed.received.length === 1, 'a fresh session should replay the unacknowledged event');
  assert.deepEqual(resumed.received.map(eventId), [second.id]);
  await resumed.client.callTool({ name: 'acknowledge_event', arguments: { id: second.id } });
  assert.deepEqual(await events(), []);
  const attention = { id: 'unresolved-transaction-three', type: 'rebalance-attention' as const,
    createdAt: '2026-09-04T20:10:00.000Z', message: 'A recorded transaction needs attention; do not retry the swap.',
    hash: `0x${'3'.repeat(64)}` };
  await publishEvent(attention);
  await waitFor(() => resumed.received.length === 2, 'new attention events should use the existing notification channel');
  assert.deepEqual(resumed.received[1]!.params, { content: attention.message,
    meta: { event_id: attention.id, event_type: attention.type, created_at: attention.createdAt, transaction_hash: attention.hash } });
  assert.deepEqual((await events()).map(event => event.id), [attention.id]);
  await resumed.client.callTool({ name: 'acknowledge_event', arguments: { id: attention.id } });
  const saved = JSON.parse(await readFile(join(directory, 'events.json'), 'utf8')) as { id: string; acknowledgedAt?: string }[];
  assert.equal(saved.length, 3, 'acknowledgement must preserve durable history');
  assert.ok(saved.every(event => typeof event.acknowledgedAt === 'string'));
  assert.deepEqual(resumed.errors, []);
  await resumed.client.close();

  const acknowledged = await openSession();
  await acknowledged.client.listTools();
  await delay(2_200);
  assert.deepEqual(acknowledged.received, [], 'acknowledged events must stay hidden after a new process starts');
  assert.deepEqual(acknowledged.errors, []);
  await acknowledged.client.close();
});


test('a stalled stdio write ends the channel after its deadline and preserves unacknowledged entries', { timeout: 15_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'rebalance-channel-blocked-test-'));
  const data = join(root, '.local'); await mkdir(data);
  const queue = [{ id: 'blocked-first', type: 'rebalance-attention', createdAt: '2026-09-06T00:00:00.000Z', message: 'x'.repeat(4 * 1024 * 1024) },
    { id: 'unsent-second', type: 'rebalance-completed', createdAt: '2026-09-06T00:00:01.000Z', message: 'Still queued.' }];
  await writeFile(join(data, 'events.json'), JSON.stringify(queue));
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../src/channel.ts', import.meta.url))], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), env: { ...process.env, REBALANCE_DATA_DIR: data }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(async () => { child.kill('SIGKILL'); await rm(root, { recursive: true, force: true }); });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const exited = new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  const initialized = new Promise<void>(resolve => {
    let output = '';
    const receive = (chunk: Buffer) => {
      output += chunk.toString();
      if (!output.includes('\n')) return;
      const response = JSON.parse(output.slice(0, output.indexOf('\n'))) as { id: number; result?: unknown };
      assert.equal(response.id, 1); assert.ok(response.result);
      child.stdout.off('data', receive);
      child.stdout.pause();
      resolve();
    };
    child.stdout.on('data', receive);
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'blocked-channel-test', version: '1.0.0' },
  } }) + '\n');
  await initialized;
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  // Stop consuming stdout, forcing the notification write to remain unresolved.
  assert.equal(await exited, 1);
  assert.equal(stderr, 'Rebalance notification transport timed out; queued events retained.\n');
  assert.deepEqual(JSON.parse(await readFile(join(data, 'events.json'), 'utf8')), queue);
});
