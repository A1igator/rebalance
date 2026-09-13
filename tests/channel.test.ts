import { assertTemporaryTestDirectory } from '../src/test-isolation.js';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Notification } from '@modelcontextprotocol/sdk/types.js';
import { atomicWriteJson, readJson } from '../src/storage.js';
import { connectionPath } from '../scripts/profile-routing.mjs';

const directory = await mkdtemp(join(tmpdir(), 'rebalance-channel-test-'));
const previousDirectory = process.env.REBALANCE_DATA_DIR;
assertTemporaryTestDirectory(directory);
process.env.REBALANCE_DATA_DIR = directory;
const { events, publishEvent } = await import('../src/events.js');
assert.equal((await import('../src/config.js')).DATA, directory, 'captured DATA must belong to this disposable fixture');
const sessions: Client[] = [];

after(async () => {
  for (const client of sessions) await client.close();
  if (previousDirectory === undefined) delete process.env.REBALANCE_DATA_DIR;
  else process.env.REBALANCE_DATA_DIR = previousDirectory;
  await rm(directory, { recursive: true, force: true });
});

async function waitFor(condition: () => boolean | Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 6_000;
  while (Date.now() < deadline) {if (await condition()) return; await delay(20);}
  assert.ok(await condition(), message);
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

const defaultWallet = `0x${'a'.repeat(40)}`;
const defaultSession = 'claude:fixture-channel';
const bindingPath = (data: string, session: string) => join(data, `claude-notification-${createHash('sha256').update(session).digest('hex')}.json`);
async function preparePortfolio(data: string, nativeSession = defaultSession, wallet = defaultWallet, existing = true) {
  await atomicWriteJson(join(data, 'portfolios.json'), {version: 1, profiles: [{wallet, chainId: 4663, directory: '.', chartPort: 4663}]});
  await atomicWriteJson(join(data, 'config.json'), {wallet, chainId: 4663, mode: 'ledger'});
  await atomicWriteJson(join(data, 'status.json'), {app: 'Rebalance', wallet, chain: {id: 4663}, mode: 'ledger', armed: true});
  await atomicWriteJson(join(data, 'run.lock'), {pid: process.pid, createdAt: new Date().toISOString(), token: 'fixture-owned-runner'});
  await atomicWriteJson(connectionPath(data, nativeSession), {version: 1, wallet, chainId: 4663});
  if (existing) await atomicWriteJson(bindingPath(data, nativeSession), {version: 1, wallet,
    sessionDigest: createHash('sha256').update(nativeSession).digest('hex'), ignoredEventIds: []});
}
const selectedEnv = (root: string, session = defaultSession) => ({REBALANCE_ROOT_DIR: root, REBALANCE_SESSION_ID: session});
function expectedEvent(event: {id: string; type: string; createdAt: string; message: string; hash?: string}, wallet = defaultWallet) {
  return {content: `Portfolio ${wallet} on Robinhood (4663): ${event.message}`, meta: {
    event_id: event.id, event_type: event.type, created_at: event.createdAt,
    portfolio_wallet: wallet, chain_id: '4663', ...(event.hash ? {transaction_hash: event.hash} : {}),
  }};
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
  await preparePortfolio(directory);
  await publishEvent(first);
  const initial = await openSession(directory, selectedEnv(directory));
  const capabilities = initial.client.getServerCapabilities();
  assert.deepEqual(capabilities?.experimental, { 'claude/channel': {} });
  const tools = await initial.client.listTools();
  assert.deepEqual(tools.tools.map(tool => tool.name), ['acknowledge_event', 'connect_companion_view', 'acknowledge_setup_request']);
  const forbidden = await initial.client.callTool({ name: 'sign_transaction', arguments: {} });
  assert.equal(forbidden.isError, true);
  await waitFor(() => initial.received.length === 1, 'offline event should arrive after the MCP initialization handshake');
  const notification = initial.received[0]!;
  assert.equal(notification.method, 'notifications/claude/channel');
  assert.deepEqual(notification.params, expectedEvent(first));
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

  const resumed = await openSession(directory, selectedEnv(directory));
  await waitFor(() => resumed.received.length === 1, 'a fresh session should replay the unacknowledged event');
  assert.deepEqual(resumed.received.map(eventId), [second.id]);
  await resumed.client.callTool({ name: 'acknowledge_event', arguments: { id: second.id } });
  assert.deepEqual(await events(), []);
  const attention = { id: 'unresolved-transaction-three', type: 'rebalance-attention' as const,
    createdAt: '2026-09-04T20:10:00.000Z', message: 'A recorded transaction needs attention; do not retry the swap.',
    hash: `0x${'3'.repeat(64)}` };
  await publishEvent(attention);
  await waitFor(() => resumed.received.length === 2, 'new attention events should use the existing notification channel');
  assert.deepEqual(resumed.received[1]!.params, expectedEvent(attention));
  assert.deepEqual((await events()).map(event => event.id), [attention.id]);
  await resumed.client.callTool({ name: 'acknowledge_event', arguments: { id: attention.id } });
  const saved = JSON.parse(await readFile(join(directory, 'events.json'), 'utf8')) as { id: string; acknowledgedAt?: string }[];
  assert.equal(saved.length, 3, 'acknowledgement must preserve durable history');
  assert.ok(saved.every(event => typeof event.acknowledgedAt === 'string'));
  assert.deepEqual(resumed.errors, []);
  await resumed.client.close();

  const acknowledged = await openSession(directory, selectedEnv(directory));
  await acknowledged.client.listTools();
  await delay(2_200);
  assert.deepEqual(acknowledged.received, [], 'acknowledged events must stay hidden after a new process starts');
  assert.deepEqual(acknowledged.errors, []);
  await acknowledged.client.close();
});


test('a stalled stdio write ends the channel after its deadline and preserves unacknowledged entries', { timeout: 15_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'rebalance-channel-blocked-test-'));
  const data = join(root, '.local'); await mkdir(data);
  await preparePortfolio(data);
  const queue = [{ id: 'blocked-first', type: 'rebalance-attention', createdAt: '2026-09-06T00:00:00.000Z', message: 'x'.repeat(4 * 1024 * 1024) },
    { id: 'unsent-second', type: 'rebalance-completed', createdAt: '2026-09-06T00:00:01.000Z', message: 'Still queued.' }];
  await writeFile(join(data, 'events.json'), JSON.stringify(queue));
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../src/channel.ts', import.meta.url))], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), env: { ...process.env, REBALANCE_ROOT_DIR: data, REBALANCE_DATA_DIR: data, REBALANCE_SESSION_ID: defaultSession }, stdio: ['pipe', 'pipe', 'pipe'],
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
    await preparePortfolio(dataDir);
    const at = Date.now();
    const old = '2020-01-01T00:00:00.000Z';
    const current = new Date(at).toISOString();
    const observation = (healthy: boolean) => ({ app: 'Rebalance', chain: {id: 4663}, mode: 'ledger', wallet: defaultWallet, armed: true,
      portfolio: { totalUsdE8: '100', positions: [{ id: 'USDG', balance: '100', priceUsdE8: '100000000', valueUsdE8: '100', weightBps: 10000, targetBps: 10000 }] },
      updatedAt: current, error: healthy ? null : 'Read failed',
      graph: healthy ? { node: 'wait', trace: ['config', 'observe', 'plan', 'wait'] } : { node: 'error', trace: ['config', 'observe', 'error'] },
    });
    const legacyFiles = ['read-notification-state.json', 'quote-notification-state.json'];
    const legacyBefore = new Map<string, string>();
    if (fixture !== 'missing-state') {
      await atomicWriteJson(join(dataDir, 'status.json'), observation(false));
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
    const session = await openSession(dataDir, selectedEnv(dataDir)); t.after(() => session.client.close());
    await waitFor(() => session.received.length >= expected.length, 'selected running portfolio events pass independently of legacy retry-filter journals');
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
    const reconnect = await openSession(dataDir, selectedEnv(dataDir)); t.after(() => reconnect.client.close());
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
  await atomicWriteJson(join(root, 'config.json'), { wallet: walletA, chainId: 4663, mode: 'ledger' });
  await atomicWriteJson(join(dataB, 'config.json'), { wallet: walletB, chainId: 4663, mode: 'ledger' });
  await atomicWriteJson(join(root, 'portfolios.json'), { version: 1, profiles: [
    { wallet: walletA, chainId: 4663, directory: '.', chartPort: 4663 },
    { wallet: walletB, chainId: 4663, directory: `wallets/${walletB}`, chartPort: 4664 },
  ] });
  const sessionId = 'claude:fixture-profile-session';
  for (const [data, wallet] of [[root, walletA], [dataB, walletB]]) {
    await atomicWriteJson(join(data!, 'status.json'), {app: 'Rebalance', chain: {id: 4663}, wallet, mode: 'ledger', armed: true});
    await atomicWriteJson(join(data!, 'run.lock'), {pid: process.pid, createdAt: new Date().toISOString(), token: 'fixture-owned-runner'});
    await atomicWriteJson(bindingPath(data!, sessionId), {version: 1, wallet,
      sessionDigest: createHash('sha256').update(sessionId).digest('hex'), ignoredEventIds: []});
  }
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
  const ignored = { ...shared, id: 'later-old-wallet', message: 'Must remain local after selection changes.' };
  await atomicWriteJson(join(root, 'events.json'), [shared, ignored]);
  await delay(250);assert.equal(first.received.length, 1);
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


test('new Claude binding ignores historical backlog and stopped-wallet events remain local after restart', {timeout: 15_000}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'rebalance-channel-binding-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await preparePortfolio(root, defaultSession, defaultWallet, false);
  const event = (id: string) => ({id, type: 'rebalance-completed', createdAt: new Date().toISOString(), message: 'Confirmed fixture completion.'});
  const history = [event('historical')];await atomicWriteJson(join(root, 'events.json'), history);
  const channel = await openSession(root, selectedEnv(root));t.after(() => channel.client.close());
  await waitFor(async () => (await readJson<{ignoredEventIds: string[]}>(bindingPath(root, defaultSession)))?.ignoredEventIds.includes('historical') === true, 'initial backlog must be retained as ignored');
  history.push(event('new-running'));await atomicWriteJson(join(root, 'events.json'), history);
  await waitFor(() => channel.received.length === 1, 'new selected-running event should arrive');
  assert.deepEqual(channel.received.map(eventId), ['new-running']);
  await atomicWriteJson(join(root, 'stop.json'), {createdAt: new Date().toISOString()});
  history.push(event('while-stopped'));await atomicWriteJson(join(root, 'events.json'), history);
  await waitFor(async () => (await readJson<{ignoredEventIds: string[]}>(bindingPath(root, defaultSession)))?.ignoredEventIds.includes('while-stopped') === true, 'stopped events should enter only local ignored history');
  await rm(join(root, 'stop.json'));history.push(event('after-restart'));await atomicWriteJson(join(root, 'events.json'), history);
  await waitFor(() => channel.received.length === 2, 'future running events should resume without old backlog');
  assert.deepEqual(channel.received.map(eventId), ['new-running', 'after-restart']);
  assert.deepEqual(await readJson(join(root, 'events.json')), history, 'delivery filters never acknowledge or delete event history');
  assert.deepEqual(channel.errors, []);assert.equal(channel.stderr(), '');
});

test('unknown or malformed runner ownership never delivers portfolio events', {timeout: 15_000}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'rebalance-channel-running-'));
  t.after(() => rm(root, {recursive: true, force: true}));await preparePortfolio(root);
  await atomicWriteJson(join(root, 'run.lock'), {pid: process.pid});
  const history = [{id: 'invalid-owner', type: 'rebalance-attention', createdAt: new Date().toISOString(), message: 'Should stay local.'}];
  await atomicWriteJson(join(root, 'events.json'), history);
  const channel = await openSession(root, selectedEnv(root));t.after(() => channel.client.close());
  await waitFor(async () => (await readJson<{ignoredEventIds: string[]}>(bindingPath(root, defaultSession)))?.ignoredEventIds.includes('invalid-owner') === true, 'unknown runner cannot authorize notification');
  assert.deepEqual(channel.received, []);
  await atomicWriteJson(join(root, 'run.lock'), {pid: process.pid, createdAt: new Date().toISOString(), token: 'fixture-owned-runner'});
  history.push({id: 'current-valid-owner', type: 'rebalance-attention', createdAt: new Date().toISOString(), message: 'Current meaningful failure.'});
  await atomicWriteJson(join(root, 'events.json'), history);await waitFor(() => channel.received.length === 1, 'later verified running event can arrive');
  assert.deepEqual(channel.received.map(eventId), ['current-valid-owner']);assert.equal(channel.stderr(), '');
});
