import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { RebalanceEvent } from '../src/events.js';
import { createNotificationFilter, isLocalOnlyNotification, isRetryableAttention } from '../src/notification-filter.js';

const epoch = Date.parse('2026-09-06T12:00:00Z');
const iso = (at: number) => new Date(at).toISOString();
const readMessage = 'Rebalance needs attention: Fresh portfolio holdings or prices could not be read. No completion is confirmed by this alert. Review the current agent status before recovery.';
const quoteMessage = 'Rebalance needs attention: A usable swap quote could not be obtained. No completion is confirmed by this alert. Review the current agent status before recovery.';
const transactionHash = `0x${'a'.repeat(64)}`;
const event = (id: string, type: RebalanceEvent['type'], message: string, at = epoch): RebalanceEvent => ({
  id, type, message, createdAt: iso(at),
});
const read = (id = 'read', at = epoch) => event(id, 'rebalance-attention', readMessage, at);
const quote = (id = 'quote', at = epoch) => event(id, 'rebalance-attention', quoteMessage, at);
const recovered = (id = 'recovered', at = epoch) => ({
  ...event(id, 'rebalance-recovered', 'Automatic transaction recovery completed.', at), hash: transactionHash,
});
const completion = (id = 'completion', at = epoch) => ({
  ...event(id, 'rebalance-completed', 'Rebalance completed after its verified receipt.', at), hash: transactionHash,
});

async function fixture(t: TestContext) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'rebalance-notification-classification-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('exact read and quote retries plus all automatic recoveries are local-only', async () => {
  const local = [read(), quote(), recovered(), { ...recovered('unhashed-recovery'), hash: undefined }];
  assert.deepEqual(local.map(isRetryableAttention), [true, true, false, false]);
  assert.ok(local.every(isLocalOnlyNotification));
  assert.deepEqual(await createNotificationFilter().select(local), { events: [], nextAt: null });
});

test('unknown attention, transaction hashes, hardware attention, completions and connection tests remain immediate', async () => {
  const phases = [
    'The local configuration could not be loaded.',
    'The previous transaction could not be reconciled.',
    'Automatic transaction recovery could not proceed.',
    'The rebalance plan could not be calculated.',
    'The saved rebalance timing could not be read.',
    'Transaction preparation or execution failed.',
    'The local runtime state could not be saved.',
    'A network or local runtime operation failed.',
  ].map((message, index) => event(`phase-${index}`, 'rebalance-attention',
    `Rebalance needs attention: ${message} No completion is confirmed by this alert. Review the current agent status before recovery.`));
  const immediate = [
    ...phases,
    event('unresolved', 'rebalance-attention', 'A transaction has an unknown outcome; further trades are paused.'),
    event('unknown', 'rebalance-attention', 'Unrecognized attention needs review.'),
    { ...read('hashed-read'), hash: transactionHash },
    { ...quote('hashed-quote'), hash: transactionHash },
    event('hardware', 'ledger-rebalance-needed', 'Physical Ledger confirmation is required.'),
    completion(), event('connection', 'notification-test', 'Notification connection test.'),
  ];
  assert.ok(immediate.every(item => !isRetryableAttention(item) && !isLocalOnlyNotification(item)));
  assert.deepEqual(await createNotificationFilter().select([read(), ...immediate, quote(), recovered()]),
    { events: immediate, nextAt: null });
});

test('local-only recognition requires the exact fixed attention text and event type', async () => {
  const nearMatches = [
    ...[readMessage, quoteMessage].flatMap((message, index) => [
      event(`prefix-${index}`, 'rebalance-attention', ` ${message}`),
      event(`suffix-${index}`, 'rebalance-attention', `${message} Additional operator action required.`),
      event(`changed-${index}`, 'rebalance-attention', message.replace('could not', 'could never')),
      event(`typed-${index}`, 'rebalance-completed', message),
      event(`ledger-${index}`, 'ledger-rebalance-needed', message),
      event(`test-${index}`, 'notification-test', message),
    ]),
  ];
  assert.ok(nearMatches.every(item => !isLocalOnlyNotification(item)));
  assert.deepEqual(await createNotificationFilter().select(nearMatches), { events: nearMatches, nextAt: null });
});

test('acknowledged events stay in history but are never selected again', async () => {
  const entries = [read(), quote(), recovered(), completion(), event('test', 'notification-test', 'Connection test.')];
  const acknowledged = entries.map(item => ({ ...item, acknowledgedAt: iso(epoch + 1000) }));
  const before = structuredClone(acknowledged);
  const pending = completion('new-completion', epoch + 2000);
  assert.deepEqual(await createNotificationFilter().select([...acknowledged, pending]), { events: [pending], nextAt: null });
  assert.deepEqual(acknowledged, before);
  assert.equal(isLocalOnlyNotification(acknowledged[3]!), false, 'acknowledgement and event classification are separate decisions');
});

test('local retries never mature into alerts across long outages, clock changes or filter restarts', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: epoch });
  const retained = [read(), quote(), recovered()];
  const first = createNotificationFilter();
  for (const at of [epoch, epoch + 120_000, epoch + 600_000, epoch + 365 * 86_400_000, epoch - 1000]) {
    t.mock.timers.setTime(at);
    const latest = [...retained, read(`retry-${at}`, at), quote(`quote-${at}`, at)];
    for (const filter of [first, createNotificationFilter()]) {
      assert.deepEqual(await filter.select(latest), { events: [], nextAt: null });
    }
  }
  assert.ok(retained.every(item => item.acknowledgedAt === undefined));
});

test('status flaps and old missing or corrupt filter files cannot affect classification or mutate history', async t => {
  const directory = await fixture(t);
  const queue = [read(), quote(), completion(), recovered()];
  const files: Record<string, string> = {
    'events.json': JSON.stringify(queue),
    'read-notification-state.json': '{corrupt legacy incident',
    'quote-notification-state.json': JSON.stringify({ version: 1, clockAt: epoch,
      incident: { representativeId: 'quote', eligible: true }, suppressed: [{ id: 'completion', reason: 'duplicate-quote' }] }),
    'read-notifications.lock': '{corrupt abandoned lock',
    'quote-notifications.lock': '{corrupt abandoned lock',
  };
  for (const [name, bytes] of Object.entries(files)) await fs.writeFile(join(directory, name), bytes);
  const filter = createNotificationFilter();
  for (const status of [null, '{corrupt status', JSON.stringify({ error: 'read failure', armed: true }),
    JSON.stringify({ error: null, graph: { node: 'observe' } }),
    JSON.stringify({ error: null, graph: { node: 'wait' }, updatedAt: iso(epoch + 30_000) }),
    JSON.stringify({ error: 'quote failure', armed: false })]) {
    if (status !== null) await fs.writeFile(join(directory, 'status.json'), status);
    const before = new Map(await Promise.all((await fs.readdir(directory)).map(async name =>
      [name, await fs.readFile(join(directory, name), 'utf8')] as const)));
    for (const selected of [filter, createNotificationFilter()]) {
      assert.deepEqual(await selected.select(queue), { events: [queue[2]], nextAt: null });
    }
    assert.deepEqual((await fs.readdir(directory)).sort(), [...before.keys()].sort());
    for (const [name, bytes] of before) assert.equal(await fs.readFile(join(directory, name), 'utf8'), bytes);
  }
});

test('classification performs no file reads, writes, lock operations or timer scheduling', async t => {
  const calls: string[] = [];
  const methods = ['readFile', 'writeFile', 'stat', 'open', 'mkdir', 'chmod', 'rename', 'unlink'] as const;
  const mocks = methods.map(name => t.mock.method(fs, name, () => {
    calls.push(name); throw new Error('Classification must not access files');
  }));
  const timer = t.mock.method(globalThis, 'setTimeout', () => {
    calls.push('setTimeout'); throw new Error('Classification must not schedule timers');
  });
  syncBuiltinESMExports();
  try {
    const direct = completion();
    const filter = createNotificationFilter();
    assert.deepEqual(await filter.select([read(), direct, quote(), recovered()]), { events: [direct], nextAt: null });
    assert.deepEqual(await filter.select([]), { events: [], nextAt: null });
    assert.deepEqual(calls, []);
  } finally {
    for (const mock of mocks) mock.mock.restore();
    timer.mock.restore(); syncBuiltinESMExports();
  }
});

test('selection preserves queue order, event identity and immutable raw data without transport deduplication', async () => {
  const first = Object.freeze(completion('first', epoch + 10_000));
  const second = Object.freeze(event('second', 'notification-test', 'Connection test.', epoch));
  const queue = Object.freeze([Object.freeze(read()), first, Object.freeze(quote()), second, Object.freeze(recovered())]);
  const before = JSON.stringify(queue);
  const filter = createNotificationFilter();
  for (let attempt = 0; attempt < 3; attempt++) {
    const selected = await filter.select(queue);
    assert.deepEqual(selected, { events: [first, second], nextAt: null });
    assert.equal(selected.events[0], first); assert.equal(selected.events[1], second);
  }
  assert.equal(JSON.stringify(queue), before);
  assert.ok(queue.every(item => item.acknowledgedAt === undefined));
});


test('retired Ledger agent-request alerts are retained locally while other hardware attention still delivers', async () => {
  const message = 'Your Ledger portfolio has drifted beyond its target threshold. Connect and unlock Ledger, open Ethereum, and request a rebalance through your agent. Every transaction needs physical confirmation; this alert does not start signing.';
  const legacy = event('old-ledger-gate', 'ledger-rebalance-needed', message);
  const actionable = event('device-failure', 'rebalance-attention', 'Ledger requires device troubleshooting.');
  const hashed = { ...legacy, id: 'with-transaction', hash: transactionHash };
  const history = [legacy, actionable, hashed];
  const before = structuredClone(history);
  assert.equal(isLocalOnlyNotification(legacy), true);
  assert.deepEqual(await createNotificationFilter().select(history), { events: [actionable, hashed], nextAt: null });
  assert.deepEqual(history, before);
});
