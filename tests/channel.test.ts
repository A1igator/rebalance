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
import { atomicWriteJson } from '../src/storage.js';
import { connectionPath } from '../scripts/profile-routing.mjs';

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

async function openSession(dataDir = directory, env: Record<string, string> = {}) {
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
    env: { REBALANCE_DATA_DIR: dataDir, ...env },
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

test('real MCP stdio sessions deliver queued events, expose scoped acknowledgement and companion setup tools, and retain unacknowledged events across restart', { timeout: 25_000 }, async () => {
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
  assert.deepEqual(tools.tools.map(tool => tool.name), ['acknowledge_event', 'connect_companion_view', 'acknowledge_setup_request']);
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

test('Claude channel never escalates automatic read/quote retries or recovery across process restarts', { timeout: 25_000 }, async t => {
  const readMessage = 'Rebalance needs attention: Fresh portfolio holdings or prices could not be read. No completion is confirmed by this alert. Review the current agent status before recovery.';
  const quoteMessage = 'Rebalance needs attention: A usable swap quote could not be obtained. No completion is confirmed by this alert. Review the current agent status before recovery.';
  for (const fixture of ['missing-state', 'corrupt-state', 'legacy-eligible'] as const) await t.test(fixture, async t => {
    const dataDir = await mkdtemp(join(tmpdir(), 'rebalance-channel-quiet-'));
    t.after(() => rm(dataDir, { recursive: true, force: true }));
    const at = Date.now();
    const old = '2020-01-01T00:00:00.000Z';
    const current = new Date(at).toISOString();
    const observation = (healthy: boolean) => ({ wallet: `0x${'a'.repeat(40)}`, armed: true,
      portfolio: { totalUsdE8: '100', positions: [{ id: 'USDG', balance: '100', priceUsdE8: '100000000', valueUsdE8: '100', weightBps: 10000, targetBps: 10000 }] },
      updatedAt: current, error: healthy ? null : 'Read failed',
      graph: healthy ? { node: 'wait', trace: ['config', 'observe', 'plan', 'wait'] } : { node: 'error', trace: ['config', 'observe', 'error'] },
    });
    const legacyFiles = ['read-notification-state.json', 'quote-notification-state.json'];
    const legacyBefore = new Map<string, string>();
    if (fixture !== 'missing-state') {
      await writeFile(join(dataDir, 'status.json'), fixture === 'corrupt-state' ? '{invalid' : JSON.stringify(observation(false)));
      for (const [index, name] of legacyFiles.entries()) {
        const content = fixture === 'corrupt-state' ? '{invalid' : JSON.stringify({ version: 1, clockAt: at,
          incident: { wallet: `0x${'a'.repeat(40)}`, representativeId: index === 0 ? 'old-read' : 'old-quote',
            firstFailureAt: Date.parse(old), latestFailureAt: at, eligible: true, healthySince: null, lastHealthyAt: null }, suppressed: [] });
        legacyBefore.set(name, content);
        await writeFile(join(dataDir, name), content);
      }
    }
    const retry = (id: string, message: string, createdAt = current) => ({ id, type: 'rebalance-attention', createdAt, message });
    const retained = [
      retry('old-read', readMessage, old), retry('old-quote', quoteMessage, old),
      retry('new-read', readMessage), retry('new-quote', quoteMessage),
      { id: 'quiet-recovery', type: 'rebalance-recovered', createdAt: old, message: 'Automatic recovery confirmed.' },
      { id: 'meaningful-completion', type: 'rebalance-completed', createdAt: current, message: 'A confirmed completion.' },
      { id: 'meaningful-ledger', type: 'ledger-rebalance-needed', createdAt: current, message: 'Physical device confirmation is needed.' },
      { id: 'meaningful-test', type: 'notification-test', createdAt: current, message: 'Requested connection test.' },
      retry('meaningful-failure', 'A signing configuration needs attention.'),
      { ...retry('transaction-bearing-read', readMessage), hash: `0x${'a'.repeat(64)}` },
      retry('unrecognized-read', 'Fresh portfolio holdings or prices could not be read: unfamiliar cause.'),
    ];
    const expected = ['meaningful-completion', 'meaningful-ledger', 'meaningful-test', 'meaningful-failure', 'transaction-bearing-read', 'unrecognized-read'];
    await atomicWriteJson(join(dataDir, 'events.json'), retained);
    const session = await openSession(dataDir); t.after(() => session.client.close());
    await waitFor(() => session.received.length >= expected.length, 'actionable and requested events must pass without status or filter-state prerequisites');
    assert.deepEqual(session.received.map(eventId), expected);

    // A later failing observation and another retry must not promote any old
    // incident. A meaningful sentinel proves the changed queue was consumed.
    await atomicWriteJson(join(dataDir, 'status.json'), observation(true));
    await atomicWriteJson(join(dataDir, 'status.json'), observation(false));
    retained.push(retry('flapping-read', readMessage), retry('flapping-quote', quoteMessage),
      { id: 'latest-test', type: 'notification-test', createdAt: current, message: 'Requested subsequent connection test.' });
    expected.push('latest-test');
    await atomicWriteJson(join(dataDir, 'events.json'), retained);
    await waitFor(() => session.received.length >= expected.length, 'the existing channel must consume the updated event queue');
    assert.deepEqual(session.received.map(eventId), expected);
    assert.deepEqual(session.errors, []); assert.equal(session.stderr(), '');
    await session.client.close();

    // Neither time-based eligibility from the old journal nor a process restart
    // can make the same retained automatic event eligible for model context.
    const reconnect = await openSession(dataDir); t.after(() => reconnect.client.close());
    await waitFor(() => reconnect.received.length >= expected.length, 'unacknowledged meaningful events replay after restart');
    assert.deepEqual(reconnect.received.map(eventId), expected);
    assert.deepEqual(reconnect.errors, []); assert.equal(reconnect.stderr(), '');
    await reconnect.client.close();
    assert.deepEqual(JSON.parse(await readFile(join(dataDir, 'events.json'), 'utf8')), retained,
      'local-only delivery filtering neither deletes nor acknowledges raw events');
    for (const name of legacyFiles) {
      if (legacyBefore.has(name)) assert.equal(await readFile(join(dataDir, name), 'utf8'), legacyBefore.get(name));
      else await assert.rejects(readFile(join(dataDir, name), 'utf8'), { code: 'ENOENT' });
    }
  });
});


test('Claude sessions pin notifications and acknowledgements while a chat attaches to another wallet', { timeout: 12_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'rebalance-channel-profiles-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const walletA = `0x${'a'.repeat(40)}`, walletB = `0x${'b'.repeat(40)}`;
  const dataB = join(root, 'wallets', walletB);
  await mkdir(dataB, { recursive: true }); await mkdir(join(root, 'connections'));
  await atomicWriteJson(join(root, 'config.json'), { wallet: walletA, chainId: 4663 });
  await atomicWriteJson(join(dataB, 'config.json'), { wallet: walletB, chainId: 4663 });
  await atomicWriteJson(join(root, 'portfolios.json'), { version: 1, profiles: [
    { wallet: walletA, chainId: 4663, directory: '.', chartPort: 4663 },
    { wallet: walletB, chainId: 4663, directory: `wallets/${walletB}`, chartPort: 4664 },
  ] });
  const sessionId = 'claude:fixture-profile-session';
  const connect = (wallet: string) => atomicWriteJson(connectionPath(root, sessionId), { version: 1, chainId: 4663, wallet });
  const shared = { id: 'same-event-id', type: 'rebalance-completed', createdAt: '2026-09-07T00:00:00Z', message: 'Completed.' };
  await atomicWriteJson(join(root, 'events.json'), [shared]);
  await atomicWriteJson(join(dataB, 'events.json'), [shared]);
  await connect(walletA);
  const env = { REBALANCE_ROOT_DIR: root, REBALANCE_SESSION_ID: sessionId };
  const first = await openSession(root, env); t.after(() => first.client.close());
  await waitFor(() => first.received.length === 1, 'first wallet should deliver');
  assert.equal(first.received[0]?.params?.content, `Portfolio ${walletA} on Robinhood (4663): Completed.`);
  assert.equal((first.received[0]?.params?.meta as Record<string, string>).portfolio_wallet, walletA);
  assert.ok(first.client.getInstructions()?.includes(`--profile ${walletA} status`));
  await connect(walletB);
  const second = await openSession(root, env); t.after(() => second.client.close());
  await waitFor(() => second.received.length === 1, 'new channel should select the new attachment');
  assert.equal((second.received[0]?.params?.meta as Record<string, string>).portfolio_wallet, walletB);
  assert.ok(second.client.getInstructions()?.includes(`--profile ${walletB} status`));
  assert.notEqual((await first.client.callTool({ name: 'acknowledge_event', arguments: { id: shared.id } })).isError, true);
  assert.ok(JSON.parse(await readFile(join(root, 'events.json'), 'utf8'))[0].acknowledgedAt);
  assert.deepEqual(JSON.parse(await readFile(join(dataB, 'events.json'), 'utf8')), [shared], 'old channel must not acknowledge the newly attached wallet');
  assert.notEqual((await second.client.callTool({ name: 'acknowledge_event', arguments: { id: shared.id } })).isError, true);
  assert.ok(JSON.parse(await readFile(join(dataB, 'events.json'), 'utf8'))[0].acknowledgedAt);
  assert.deepEqual(first.errors, []); assert.deepEqual(second.errors, []);
  await first.client.close(); await second.client.close();
});
