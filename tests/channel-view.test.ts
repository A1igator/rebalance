import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Notification } from '@modelcontextprotocol/sdk/types.js';
import { atomicWriteJson } from '../src/storage.js';
import { issueView, pendingViewRequests, requestWalletSetup, type SetupMode } from '../src/view-session.js';

const repository = fileURLToPath(new URL('..', import.meta.url));
const channel = fileURLToPath(new URL('../src/channel.ts', import.meta.url));
const nativeA = 'fixture-native-session-a';
const nativeB = 'fixture-native-session-b';
const sessionA = `claude:${nativeA}`;
const sessionB = `claude:${nativeB}`;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const setupId = (token: string, requestId: string) => hash(`${hash(token)}\0${requestId}`);
const metadata = (notification: Notification) => notification.params?.meta as Record<string, unknown>;
const ids = (notifications: Notification[]) => notifications.map(notification => metadata(notification).setup_id);

async function waitFor(condition: () => boolean | Promise<boolean>, message: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (await condition()) return; await delay(15); }
  assert.ok(await condition(), message);
}

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'rebalance-channel-view-'));
  const clients: Client[] = [];
  t.after(async () => { for (const client of clients) await client.close(); await rm(root, { recursive: true, force: true }); });
  const networkMarker = join(root, 'unexpected-network');
  const preload = join(root, 'no-network.mjs');
  await writeFile(preload, `import { writeFileSync } from 'node:fs';
    globalThis.fetch = async () => { writeFileSync(${JSON.stringify(networkMarker)}, 'blocked');
      throw new Error('Isolated channel fixture network disabled'); };`);
  async function open(nativeSession?: string, env: Record<string, string> = {}) {
    const received: Notification[] = [];
    const errors: Error[] = [];
    const client = new Client({ name: 'isolated-rebalance-setup-fixture', version: '1.0.0' }, { capabilities: {} });
    clients.push(client);
    client.fallbackNotificationHandler = async notification => { received.push(notification); };
    client.onerror = error => { errors.push(error); };
    const transport = new StdioClientTransport({ command: process.execPath,
      args: ['--import', preload, '--import', 'tsx', channel], cwd: repository,
      env: { REBALANCE_ROOT_DIR: root, REBALANCE_DATA_DIR: root,
        ...(nativeSession ? { CLAUDE_CODE_SESSION_ID: nativeSession } : {}), ...env }, stderr: 'pipe' });
    let stderr = '';
    transport.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    await client.connect(transport);
    return { client, received, errors, stderr: () => stderr };
  }
  async function setup(token: string, mode: SetupMode = 'private-key', requestId: string = randomUUID()) {
    const result = await requestWalletSetup(root, token, mode, requestId, {
      execute: async () => assert.fail('Claude fixtures must never enqueue through a native external transport'),
    });
    return { ...result, id: setupId(token, requestId), token, mode };
  }
  const record = async (id: string) => JSON.parse(await readFile(join(root, 'ui-requests', `${id}.json`), 'utf8')) as {
    id: string; state: string; sessionId: string; acknowledgedAt?: string;
  };
  // Atomic record visibility precedes delivery-lock release. Wait for the
  // complete delivery handoff before exercising a new replay/ack operation.
  const accepted = (id: string) => waitFor(async () => (await record(id)).state === 'accepted' &&
    !existsSync(join(root, 'ui-requests', `${id}.lock`)), 'local transport acceptance must finish and release its lock');
  function noTradingChanges(directories = [root]) {
    assert.equal(existsSync(networkMarker), false);
    for (const directory of directories) for (const file of ['private-key', 'run.lock', 'start.log', 'chart.lock', 'chart.log',
      'pending.json', 'cycle.json', 'recovery.json', 'recovery.lock', 'stop.json']) {
      assert.equal(existsSync(join(directory, file)), false, `setup transport must not create ${file}`);
    }
  }
  return { root, open, setup, record, accepted, noTradingChanges };
}

test('isolated Claude stdio delivers only its native session setup requests and accepted records do not replay', { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const a = await issueView(f.root, sessionA, { kind: 'claude' });
  const b = await issueView(f.root, sessionB, { kind: 'claude' });
  const first = await f.setup(a.token, 'private-key');
  const foreign = await f.setup(b.token, 'ledger');
  assert.equal(first.state, 'pending'); assert.equal(foreign.state, 'pending');
  const initial = await f.open(nativeA);
  await waitFor(() => initial.received.length >= 1, 'own pending setup should be pushed after MCP initialization');
  await f.accepted(first.id);
  assert.deepEqual(ids(initial.received), [first.id]);
  assert.equal(initial.received[0]!.method, 'notifications/claude/channel');
  assert.deepEqual(metadata(initial.received[0]!), { event_type: 'wallet-setup-request', setup_id: first.id, request_id: first.requestId });
  const content = initial.received[0]!.params?.content as string;
  assert.match(content, /new local raw private key/); assert.match(content, /do not arm or stop trading/);
  assert.equal(content.includes(a.token), false); assert.equal(content.includes(b.token), false);
  assert.equal((await f.record(first.id)).acknowledgedAt, undefined, 'transport acceptance is not user handling');
  assert.equal((await f.record(foreign.id)).state, 'pending');

  // Same browser request is idempotent; a new sentinel proves the watcher read
  // the changed directory without resending the accepted request.
  assert.equal((await f.setup(a.token, first.mode, first.requestId)).state, 'accepted');
  const second = await f.setup(a.token, 'privy');
  await waitFor(() => initial.received.length >= 2, 'new own setup should use the existing stdio connection');
  await f.accepted(second.id);
  assert.deepEqual(ids(initial.received), [first.id, second.id]);
  const foreignBefore = await readFile(join(f.root, 'ui-requests', `${foreign.id}.json`), 'utf8');
  const rejected = await initial.client.callTool({ name: 'acknowledge_setup_request', arguments: { id: foreign.id } });
  assert.equal(rejected.isError, true);
  assert.equal(await readFile(join(f.root, 'ui-requests', `${foreign.id}.json`), 'utf8'), foreignBefore);
  assert.notEqual((await initial.client.callTool({ name: 'acknowledge_setup_request', arguments: { id: first.id } })).isError, true);
  assert.equal(typeof (await f.record(first.id)).acknowledgedAt, 'string');
  assert.equal((await f.record(second.id)).acknowledgedAt, undefined);
  assert.deepEqual(initial.errors, []); assert.equal(initial.stderr(), '');
  await initial.client.close();

  const third = await f.setup(a.token, 'ledger');
  const resumed = await f.open(nativeA);
  await waitFor(() => resumed.received.length >= 1, 'new pending sentinel should arrive after restart');
  await f.accepted(third.id);
  assert.deepEqual(ids(resumed.received), [third.id], 'accepted setup records stay hidden even when they were not acknowledged');
  assert.deepEqual((await pendingViewRequests(f.root, sessionB)).map(request => request.id), [foreign.id]);
  assert.deepEqual(resumed.errors, []); assert.equal(resumed.stderr(), '');
  assert.equal(existsSync(join(f.root, 'config.json')), false);
  assert.equal(existsSync(join(f.root, 'connections')), false);
  f.noTradingChanges();
});

test('native Claude channels reject other sessions but accept rotating tokens for their own session', { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const a = await issueView(f.root, sessionA, { kind: 'claude' });
  const b = await issueView(f.root, sessionB, { kind: 'claude' });
  const initialRequest = await f.setup(a.token, 'private-key');
  const session = await f.open(nativeA);
  await waitFor(() => session.received.length >= 1, 'spawn-time session should initially receive its own setup');
  await f.accepted(initialRequest.id);
  assert.equal((await session.client.callTool({ name: 'connect_companion_view', arguments: { token: b.token } })).isError, true);
  const foreignPending = await f.setup(b.token, 'privy');
  const rotated = await issueView(f.root, sessionA, { kind: 'claude' });
  assert.notEqual((await session.client.callTool({ name: 'connect_companion_view', arguments: { token: rotated.token } })).isError, true);
  const current = await f.setup(rotated.token, 'ledger');
  await waitFor(() => session.received.length >= 2, 'rotated token should preserve the original session');
  await f.accepted(current.id);
  assert.deepEqual(ids(session.received), [initialRequest.id, current.id]);
  assert.equal((await f.record(foreignPending.id)).state, 'pending');
  assert.equal((await session.client.callTool({ name: 'acknowledge_setup_request', arguments: { id: foreignPending.id } })).isError, true);
  assert.equal((await f.record(foreignPending.id)).acknowledgedAt, undefined);
  assert.notEqual((await session.client.callTool({ name: 'acknowledge_setup_request', arguments: { id: initialRequest.id } })).isError, true);

  // Rejected capabilities must not replace the current valid binding.
  const codex = await issueView(f.root, randomUUID(), { kind: 'codex', command: '/fixture/never-executed-codex' });
  const readOnly = await issueView(f.root, 'fixture-read-only', null);
  for (const token of [b.token, codex.token, readOnly.token, 'bad-token']) {
    assert.equal((await session.client.callTool({ name: 'connect_companion_view', arguments: { token } })).isError, true);
  }
  const sentinel = await f.setup(a.token, 'privy');
  await waitFor(() => session.received.length >= 3, 'the original binding should survive invalid connection attempts');
  await f.accepted(sentinel.id);
  assert.deepEqual(ids(session.received), [initialRequest.id, current.id, sentinel.id]);
  assert.deepEqual((await pendingViewRequests(f.root, sessionB)).map(request => request.id), [foreignPending.id]);
  assert.deepEqual(session.errors, []); assert.equal(session.stderr(), '');
  await session.client.close();

  // A changed Claude identity requires a fresh host channel, never a token rebind.
  const oldPending = await f.setup(a.token, 'ledger');
  const fresh = await f.open(nativeB);
  await waitFor(() => fresh.received.length >= 1, 'a fresh channel with the new native identity should receive its own pending setup');
  await f.accepted(foreignPending.id);
  assert.deepEqual(ids(fresh.received), [foreignPending.id]);
  assert.equal((await f.record(oldPending.id)).state, 'pending');
  assert.equal((await fresh.client.callTool({ name: 'connect_companion_view', arguments: { token: a.token } })).isError, true);
  assert.equal((await fresh.client.callTool({ name: 'acknowledge_setup_request', arguments: { id: oldPending.id } })).isError, true);
  assert.deepEqual(fresh.errors, []); assert.equal(fresh.stderr(), '');
  assert.equal(existsSync(join(f.root, 'config.json')), false); f.noTradingChanges();
});

test('a channel without a native startup ID binds once and rejects another session thereafter', { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const a = await issueView(f.root, sessionA, { kind: 'claude' });
  const b = await issueView(f.root, sessionB, { kind: 'claude' });
  const old = await f.setup(a.token, 'private-key');
  const current = await f.setup(b.token, 'privy');
  const session = await f.open();
  assert.equal((await session.client.callTool({ name: 'acknowledge_setup_request', arguments: { id: current.id } })).isError, true);
  assert.notEqual((await session.client.callTool({ name: 'connect_companion_view', arguments: { token: b.token } })).isError, true);
  await waitFor(() => session.received.length >= 1, 'binding should drain the current session pending request');
  await f.accepted(current.id);
  assert.deepEqual(ids(session.received), [current.id]);
  assert.equal((await f.record(old.id)).state, 'pending');
  assert.equal((await session.client.callTool({ name: 'connect_companion_view', arguments: { token: a.token } })).isError, true);
  const rotated = await issueView(f.root, sessionB, { kind: 'claude' });
  assert.notEqual((await session.client.callTool({ name: 'connect_companion_view', arguments: { token: rotated.token } })).isError, true);
  const sentinel = await f.setup(rotated.token, 'ledger');
  await waitFor(() => session.received.length >= 2, 'first binding must stay fixed while its token rotates');
  await f.accepted(sentinel.id);
  assert.deepEqual(ids(session.received), [current.id, sentinel.id]);
  assert.equal((await f.record(old.id)).state, 'pending');
  assert.equal((await session.client.callTool({ name: 'acknowledge_setup_request', arguments: { id: old.id } })).isError, true);
  assert.deepEqual(session.errors, []); assert.equal(session.stderr(), ''); f.noTradingChanges();
});

test('two unattached portfolios do not block setup transport or leak a root portfolio queue', { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const walletA = `0x${'1'.repeat(40)}`;
  const walletB = `0x${'2'.repeat(40)}`;
  const directories = [f.root, ...[walletA, walletB].map(wallet => join(f.root, 'wallets', wallet))];
  const preserved = new Map<string, string>();
  const keep = async (path: string, value: unknown) => {
    await atomicWriteJson(path, value); preserved.set(path, await readFile(path, 'utf8'));
  };
  await keep(join(f.root, 'portfolios.json'), { version: 1, profiles: [walletA, walletB].map((wallet, index) => ({
    wallet, chainId: 4663, directory: `wallets/${wallet}`, chartPort: 4664 + index,
  })) });
  for (const [index, directory] of directories.entries()) {
    await mkdir(directory, { recursive: true });
    await keep(join(directory, 'events.json'), [{ id: `fixture-portfolio-event-${index}`, type: 'notification-test',
      createdAt: '2026-09-07T12:00:00.000Z', message: 'This portfolio queue must not leak into an unattached setup channel.' }]);
    if (index > 0) await keep(join(directory, 'config.json'), {
      version: 1, chainId: 4663, wallet: index === 1 ? walletA : walletB, mode: 'private-key',
      rpcUrl: 'http://127.0.0.1:1', targets: { USDG: 2000, AAPL: 2000, NVDA: 2000, MSFT: 2000, AMD: 2000 },
      driftThresholdBps: 100, slippageBps: 50, deadlineSeconds: 120, pollSeconds: 60, rebalanceIntervalSeconds: 3600,
    });
  }
  const a = await issueView(f.root, sessionA, { kind: 'claude' });
  const request = await f.setup(a.token, 'ledger');
  const session = await f.open(nativeA);
  const tools = await session.client.listTools();
  assert.deepEqual(tools.tools.map(tool => tool.name), ['acknowledge_event', 'connect_companion_view', 'acknowledge_setup_request']);
  await waitFor(() => session.received.length >= 1, 'an unattached multi-wallet session should still receive setup intent');
  await f.accepted(request.id);
  assert.deepEqual(ids(session.received), [request.id]);
  assert.ok(session.received.every(notification => metadata(notification).event_type === 'wallet-setup-request'));
  assert.equal((await session.client.callTool({ name: 'acknowledge_event', arguments: { id: 'fixture-portfolio-event-0' } })).isError, true);
  assert.notEqual((await session.client.callTool({ name: 'acknowledge_setup_request', arguments: { id: request.id } })).isError, true);
  assert.equal(typeof (await f.record(request.id)).acknowledgedAt, 'string');
  for (const [path, content] of preserved) assert.equal(await readFile(path, 'utf8'), content);
  assert.equal(existsSync(join(f.root, 'config.json')), false); assert.equal(existsSync(join(f.root, 'connections')), false);
  assert.deepEqual(session.errors, []); assert.equal(session.stderr(), ''); f.noTradingChanges(directories);
});


test('an explicit Rebalance native session also rejects foreign tokens before any setup is bound', { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const a = await issueView(f.root, sessionA, { kind: 'claude' });
  const b = await issueView(f.root, sessionB, { kind: 'claude' });
  const session = await f.open(undefined, { REBALANCE_SESSION_ID: sessionA });
  assert.equal((await session.client.callTool({ name: 'connect_companion_view', arguments: { token: b.token } })).isError, true);
  assert.notEqual((await session.client.callTool({ name: 'connect_companion_view', arguments: { token: a.token } })).isError, true);
  const foreign = await f.setup(b.token, 'ledger');
  const own = await f.setup(a.token, 'privy');
  await waitFor(() => session.received.length >= 1, 'explicit native binding should receive its own request');
  await f.accepted(own.id);
  assert.deepEqual(ids(session.received), [own.id]);
  assert.equal((await f.record(foreign.id)).state, 'pending');
  assert.deepEqual(session.errors, []); assert.equal(session.stderr(), ''); f.noTradingChanges();
});
