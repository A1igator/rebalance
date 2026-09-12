import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { createOpenCodeNotifications, type OpenCodeNotificationClient, type OpenCodeNotificationDependencies,
  type OpenCodeNotificationFailure, type OpenCodeNotificationOptions, type OpenCodeNotifications } from '../src/opencode-notifications.js';
import type { RebalanceEvent } from '../src/events.js';
import { atomicWriteJson, readJson } from '../src/storage.js';

const sessionId = 'ses_fixtureNativeSessionA';
const wallet = `0x${'a'.repeat(40)}`;
const epoch = Date.parse('2026-09-11T12:00:00Z');
const event = (id: string, type: RebalanceEvent['type'] = 'rebalance-completed', message = 'Fixture event'): RebalanceEvent =>
  ({ id, type, message, createdAt: new Date(epoch).toISOString() });
const localEvents = [event('read-local', 'rebalance-attention', 'Rebalance needs attention: Fresh portfolio holdings or prices could not be read. No completion is confirmed by this alert. Review the current agent status before recovery.'),
  event('quote-local', 'rebalance-attention', 'Rebalance needs attention: A usable swap quote could not be obtained. No completion is confirmed by this alert. Review the current agent status before recovery.'), event('recovery-local', 'rebalance-recovered')];
type Prompt = Parameters<OpenCodeNotificationClient['session']['promptAsync']>[0];
type History = Parameters<OpenCodeNotificationClient['session']['messages']>[0];
type Entry = { id: string; messageID: string; state: string; attemptedAt: string };
type Saved = { version: number; scope: string; entries: Entry[] };
const success = (data?: unknown, status = 204) => ({ response: { status }, data });
async function until(check: () => boolean | Promise<boolean>) {
  for (let attempt = 0; attempt < 500; attempt++) { if (await check()) return; await delay(5); }
  assert.fail('Fixture condition did not settle');
}
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'opencode-notifications-'));
  const calls: Prompt[] = [], historyCalls: History[] = [], errors: OpenCodeNotificationFailure[] = [];
  const watchers: { directory: string; changed: (filename: string | null) => void; failed: () => void; closed: boolean }[] = [];
  const timers = new Map<number, { ms: number; callback: () => void }>();
  let timerId = 0, reads = 0;
  const after = (ms: number, callback: () => void) => {
    const id = ++timerId;
    timers.set(id, { ms, callback: () => { timers.delete(id); callback(); } });
    return () => { timers.delete(id); };
  };
  let execute: (options: Prompt) => Promise<unknown> = async () => success();
  let history: (options: History) => Promise<unknown> = async () => success([], 200);
  const client: OpenCodeNotificationClient = { session: {
    promptAsync: async options => { calls.push(options); return execute(options); },
    messages: async options => { historyCalls.push(options); return history(options); },
  } };
  const deps: Partial<OpenCodeNotificationDependencies> = { now: () => epoch, after,
    read: async path => { const value = await readJson(path); if (path.endsWith('/events.json')) reads++; return value; },
    stream: { now: () => epoch, after, watch: (directory, changed, failed) => {
      const watcher = { directory, changed, failed, closed: false }; watchers.push(watcher);
      return () => { watcher.closed = true; failed(); };
    } },
  };
  const base: OpenCodeNotificationOptions = { sessionId, wallet, projectDir: directory, rootDir: directory, dataDir: directory, client, onError: failure => errors.push(failure) };
  const workers: OpenCodeNotifications[] = [];
  t.after(async () => { await Promise.all(workers.map(worker => worker.close())); await rm(directory, { recursive: true, force: true }); });
  const start = async (options: Partial<OpenCodeNotificationOptions> = {}) => {
    const worker = await createOpenCodeNotifications({ ...base, ...options }, deps); workers.push(worker); return worker;
  };
  const journalPaths = async (dataDir = directory) => (await readdir(dataDir)).filter(name => /^opencode-notifications-.*\.json$/.test(name)).map(name => join(dataDir, name));
  const saved = async (dataDir = directory) => (await Promise.all((await journalPaths(dataDir)).map(path => readJson<Saved>(path)))).filter((value): value is Saved => !!value);
  const entries = async (dataDir = directory) => (await saved(dataDir)).flatMap(value => value.entries);
  const write = async (events: RebalanceEvent[], dataDir = directory) => {
    await atomicWriteJson(join(dataDir, 'events.json'), events);
    watchers.filter(watcher => watcher.directory === dataDir).forEach(watcher => watcher.changed('events.json'));
  };
  return { directory, calls, historyCalls, errors, watchers, timers, deps, base, start, write, saved, entries, journalPaths, reads: () => reads,
    execute: (fn: typeof execute) => { execute = fn; }, history: (fn: typeof history) => { history = fn; } };
}

test('file-driven native event delivery filters local retries, retains history and does not acknowledge or poll', async t => {
  const f = await fixture(t);
  const critical = [event('complete'), event('ledger', 'ledger-rebalance-needed'), event('action', 'rebalance-attention'), event('connection', 'notification-test')];
  const acknowledged = { ...event('already-handled'), acknowledgedAt: new Date(epoch).toISOString() };
  const retained = [...localEvents, ...critical, acknowledged]; await f.write(retained);
  f.execute(async options => {
    const entries = await f.entries();
    assert.equal(entries.find(entry => entry.messageID === options.body.messageID)?.state, 'prepared', 'persist intent before SDK call');
    return success();
  });
  let worker = await f.start();
  await until(async () => (await f.entries()).filter(entry => entry.state === 'accepted').length === critical.length);
  await until(() => f.timers.size === 0);
  await until(() => f.reads() >= critical.length + 2); // The final send wakes one final retained-queue read.
  assert.equal(f.calls.length, 4); assert.equal(f.historyCalls.length, 0);
  for (const call of f.calls) {
    assert.equal(call.path.id, sessionId); assert.equal(call.query.directory, f.directory);
    assert.equal(call.throwOnError, true); assert.equal(call.responseStyle, 'fields');
    assert.equal(Object.hasOwn(call.body, 'noReply'), false, 'only an actual actionable event requests a model response');
    assert.equal(Object.hasOwn(call.body, 'tools'), false, 'notification requests never change session permissions');
    assert.match(call.body.messageID, /^msg_[0-9a-f]{26}$/);
    assert.match(call.body.parts[0].text, /Retain it if reading or reporting fails/);
    assert.match(call.body.parts[0].text, /do not prove phone delivery/);
  }
  assert.ok(f.calls.every(call => !call.body.parts[0].text.includes('Fixture event')), 'raw producer prose never becomes instructions');
  const before = f.reads();
  for (const filename of ['status.json', 'attention-state.json', 'config.json', 'events.json.tmp']) f.watchers[0].changed(filename);
  await delay(20); assert.equal(f.reads(), before); assert.equal(f.timers.size, 0);
  worker.wake(); await until(() => f.reads() > before); assert.equal(f.calls.length, 4);
  await worker.close(); worker = await f.start();
  const resumed = f.reads(); worker.wake(); await until(() => f.reads() > resumed);
  assert.equal(f.calls.length, 4); assert.equal(f.historyCalls.length, 0); assert.equal(f.timers.size, 0);
  assert.deepEqual(await readJson(join(f.directory, 'events.json')), retained);
  await f.write([...retained, event('after-file-event')]); await until(() => f.calls.length === 5);
});

test('each session-wallet scope pins delivery and acknowledgement provenance despite caller mutation', async t => {
  const f = await fixture(t); const walletB = `0x${'b'.repeat(40)}`, sessionB = 'ses_fixtureNativeSessionB';
  const directoryB = join(f.directory, 'wallet-b');
  await f.write([event('wallet-a-event')]); await f.write([event('wallet-b-event')], directoryB);
  const mutable = { ...f.base };
  const first = await createOpenCodeNotifications(mutable, f.deps); t.after(() => first.close());
  mutable.sessionId = sessionB; mutable.wallet = walletB; mutable.dataDir = directoryB;
  await f.start({ dataDir: directoryB, wallet: walletB, sessionId: sessionB });
  await until(() => f.calls.length === 2);
  const a = f.calls.find(call => call.body.parts[0].text.includes('Retained event ID: wallet-a-event;'))!;
  const b = f.calls.find(call => call.body.parts[0].text.includes('Retained event ID: wallet-b-event;'))!;
  assert.equal(a.path.id, sessionId); assert.match(a.body.parts[0].text, new RegExp(`--profile ${wallet}`));
  assert.equal(b.path.id, sessionB); assert.match(b.body.parts[0].text, new RegExp(`--profile ${walletB}`));
  assert.ok(!a.body.parts[0].text.includes(walletB)); assert.ok(!b.body.parts[0].text.includes(wallet));
  assert.notEqual((await f.saved())[0].scope, (await f.saved(directoryB))[0].scope);
  await f.write([event('wallet-a-event'), event('wallet-a-later')]); await until(() => f.calls.length === 3);
  assert.equal(f.calls[2].path.id, sessionId); assert.match(f.calls[2].body.parts[0].text, new RegExp(`--profile ${wallet}`));
  await first.close();
});

test('nested native session directories route prompts and reconciliation without changing repository commands or default journals', async t => {
  const f = await fixture(t); await f.write([event('nested-session')]);
  let worker = await f.start(); await until(async () => (await f.entries())[0]?.state === 'accepted'); await worker.close();
  const originalScope = (await f.saved())[0].scope;
  const reads = f.reads(); worker = await f.start({ sessionDirectory: f.directory });
  await until(() => f.reads() > reads); assert.equal(f.calls.length, 1, 'an explicit default directory reuses its old delivery barrier');
  assert.deepEqual((await f.saved()).map(saved => saved.scope), [originalScope]); await worker.close();

  const nestedDirectory = join(f.directory, 'packages', 'nested');
  const mutable = { ...f.base, sessionDirectory: nestedDirectory };
  f.execute(async options => { assert.equal(options.query.directory, nestedDirectory); throw new Error('Fixture ambiguous response'); });
  f.history(async options => {
    assert.equal(options.query.directory, nestedDirectory, 'reconciliation must read the same native instance');
    const delivered = f.calls[1];
    return success([{ info: { id: delivered.body.messageID, sessionID: sessionId, role: 'user' },
      parts: [{ type: 'text', text: delivered.body.parts[0].text, sessionID: sessionId, messageID: delivered.body.messageID }] }], 200);
  });
  const nested = await createOpenCodeNotifications(mutable, f.deps); t.after(() => nested.close());
  mutable.sessionDirectory = join(f.directory, 'another-native-instance');
  await until(async () => (await f.entries()).filter(entry => entry.state === 'accepted').length === 2);
  assert.equal(f.calls.length, 2); assert.equal(f.historyCalls.length, 1);
  assert.equal(f.calls[1].path.id, sessionId);
  assert.ok(f.calls[1].body.parts[0].text.includes(`Project directory: ${JSON.stringify(f.directory)}.`));
  assert.ok(f.calls[1].body.parts[0].text.includes(`REBALANCE_ROOT_DIR='${f.directory}' npm run cli -- --profile ${wallet}`));
  assert.ok(!f.calls[1].body.parts[0].text.includes(nestedDirectory), 'the CLI repository path is independent of the SDK directory');
  assert.equal(new Set((await f.saved()).map(saved => saved.scope)).size, 2, 'a different native directory has a separate dispatch barrier');
  await nested.close();
});

test('a missing wallet uses its explicit pinned data directory, and quoted paths never become shell substitutions', async t => {
  const f = await fixture(t); await f.write([event('pinned')]);
  const strangeRoot = join(f.directory, "root ' $(touch SHOULD_NOT_RUN)");
  const worker = await f.start({ wallet: null, rootDir: strangeRoot });
  await until(() => f.calls.length === 1);
  assert.match(f.calls[0].body.parts[0].text, /REBALANCE_DATA_DIR='[^']+' REBALANCE_PROFILE_PINNED=1/);
  assert.ok(!f.calls[0].body.parts[0].text.includes('--profile'));
  await worker.close();
  await f.start({ rootDir: strangeRoot }); await until(() => f.calls.length === 2);
  assert.ok(f.calls[1].body.parts[0].text.includes("root '\\'' $(touch SHOULD_NOT_RUN)'"));
});

test('acknowledged, removed, replaced and newly local events are vetoed after journal preparation', async t => {
  for (const mode of ['acknowledged', 'removed', 'replaced', 'local'] as const) await t.test(mode, async t => {
    const f = await fixture(t), original = event('selected'); await f.write([original]);
    let ready = false, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
    f.deps.persistJournal = async (path, value) => {
      if (!ready && (value as Saved).entries.some(entry => entry.state === 'prepared')) { ready = true; await gate; }
      await atomicWriteJson(path, value);
    };
    const worker = await f.start(); await until(() => ready);
    const changed = mode === 'removed' ? [] : mode === 'acknowledged' ? [{ ...original, acknowledgedAt: new Date(epoch).toISOString() }]
      : mode === 'local' ? [{ ...localEvents[0], id: original.id }] : [{ ...original, message: 'Changed after selection' }];
    // Change retained storage without a watcher hint to isolate the selected attempt.
    await atomicWriteJson(join(f.directory, 'events.json'), changed); release();
    await until(async () => (await f.saved()).length > 0 && (await f.entries()).length === 0);
    assert.equal(f.calls.length, 0);
    await f.write([...changed.filter(item => item.id !== original.id), event('later-critical')]);
    await until(() => f.calls.length === 1); assert.match(f.calls[0].body.parts[0].text, /later-critical/);
    await worker.close();
  });
});

test('unknown native outcomes retain a no-resend barrier and reconcile only exact owned messages', async t => {
  const f = await fixture(t); await f.write([event('uncertain')]);
  f.execute(async () => { throw new Error('SECRET native body must not reach diagnostics'); });
  let worker = await f.start();
  await until(() => f.historyCalls.length === 1); await until(async () => (await f.entries())[0]?.state === 'uncertain');
  const firstCall = f.calls[0]; assert.equal(f.calls.length, 1);
  for (let repeat = 0; repeat < 3; repeat++) { const before = f.reads(); worker.wake(); await until(() => f.reads() > before); }
  assert.equal(f.calls.length, 1); assert.equal(f.historyCalls.length, 1); assert.deepEqual(f.errors, ['delivery-uncertain']);
  assert.equal(f.timers.size, 0); await worker.close();
  const owned = { info: { id: firstCall.body.messageID, sessionID: sessionId, role: 'user' },
    parts: [{ type: 'text', text: firstCall.body.parts[0].text, sessionID: sessionId, messageID: firstCall.body.messageID }] };
  f.history(async () => success([{ ...owned, info: { ...owned.info, sessionID: 'ses_wrongSession' } },
    { ...owned, parts: [{ ...owned.parts[0], text: 'unrelated text' }] },
    { ...owned, parts: [{ ...owned.parts[0], sessionID: 'ses_wrongSession' }] }], 200));
  worker = await f.start(); await until(() => f.historyCalls.length === 2);
  assert.equal((await f.entries())[0].state, 'uncertain'); assert.equal(f.calls.length, 1); await worker.close();
  f.history(async () => success([owned], 200)); worker = await f.start();
  await until(async () => (await f.entries())[0].state === 'accepted');
  assert.equal(f.calls.length, 1); assert.equal(f.historyCalls.length, 3);
  for (const call of f.historyCalls) { assert.equal(call.path.id, sessionId); assert.equal(call.query.limit, 100); }
  assert.deepEqual(await readJson(join(f.directory, 'events.json')), [event('uncertain')]);
  for (const path of await f.journalPaths()) assert.doesNotMatch(await readFile(path, 'utf8'), /SECRET/);
  await worker.close();
});

test('preparation failures retry only before dispatch and do not emit repeated unchanged diagnostics', async t => {
  const f = await fixture(t); await f.write([event('save-retry')]); let writes = 0;
  f.deps.persistJournal = async (path, value) => {
    writes++; if (writes <= 2) { await atomicWriteJson(path, value); throw new Error('private disk failure'); }
    await atomicWriteJson(path, value);
  };
  const worker = await f.start();
  for (const ms of [1_000, 2_000]) {
    await until(() => [...f.timers.values()].some(timer => timer.ms === ms));
    assert.equal(f.calls.length, 0); [...f.timers.values()].find(timer => timer.ms === ms)!.callback();
  }
  await until(async () => (await f.entries())[0]?.state === 'accepted');
  assert.equal(f.calls.length, 1); assert.deepEqual(f.errors, ['read-unavailable']); assert.equal(f.timers.size, 0);
  await worker.close();
});

test('post-dispatch persistence failure closes the stream and crash-prepared records cannot resend', async t => {
  const f = await fixture(t); await f.write([event('post-send'), event('must-wait')]);
  f.deps.persistJournal = async (path, value) => {
    if ((value as Saved).entries.some(entry => entry.state === 'accepted')) throw new Error('private disk failure');
    await atomicWriteJson(path, value);
  };
  const worker = await f.start(); await until(() => f.watchers[0]?.closed);
  await worker.close(); assert.equal(f.calls.length, 1); assert.equal((await f.entries())[0].state, 'prepared');
  f.deps.persistJournal = atomicWriteJson;
  const resumed = await f.start(); await until(async () => (await f.entries()).some(entry => entry.id === 'must-wait' && entry.state === 'accepted'));
  assert.equal(f.calls.length, 2); assert.match(f.calls[1].body.parts[0].text, /must-wait/);
  assert.equal(f.calls.filter(call => call.body.parts[0].text.includes('Retained event ID: post-send;')).length, 1);
  await resumed.close();
});

test('pause during an unresolved request cancels transport, retains uncertainty and blocks later events', async t => {
  const f = await fixture(t); await f.write([event('in-flight'), event('after-pause')]);
  f.execute(async () => new Promise(() => {}));
  const controller = new AbortController(); const worker = await f.start({ signal: controller.signal });
  await until(() => f.calls.length === 1); controller.abort(); await worker.close();
  assert.equal(f.calls[0].signal.aborted, true); assert.equal(f.calls.length, 1);
  assert.equal((await f.entries())[0].state, 'uncertain'); assert.equal(f.timers.size, 0);
  assert.equal(f.watchers[0].closed, true);
  const before = f.reads(); worker.wake(); f.watchers[0].changed('events.json'); await delay(20); assert.equal(f.reads(), before);
  f.execute(async () => success()); const resumed = await f.start();
  await until(() => f.calls.length === 2); assert.match(f.calls[1].body.parts[0].text, /after-pause/);
  await resumed.close();
});

test('a native request deadline closes delivery without a concurrent retry', async t => {
  const f = await fixture(t); await f.write([event('timeout'), event('later')]);
  f.execute(async () => new Promise(() => {})); const worker = await f.start();
  await until(() => f.calls.length === 1);
  [...f.timers.values()].find(timer => timer.ms === 10_000)!.callback(); await worker.close();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].signal.aborted, true);
  assert.equal((await f.entries())[0].state, 'uncertain'); assert.equal(f.timers.size, 0);
});

test('pause during preparation prevents dispatch even when the original journal write completes later', async t => {
  const f = await fixture(t); await f.write([event('paused-before-send')]);
  let prepared = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
  f.deps.persistJournal = async (path, value) => {
    if (!prepared && (value as Saved).entries.length) { prepared = true; await gate; }
    await atomicWriteJson(path, value);
  };
  const controller = new AbortController(); const worker = await f.start({ signal: controller.signal });
  await until(() => prepared); controller.abort(); release(); await worker.close();
  assert.equal(f.calls.length, 0); assert.equal(f.historyCalls.length, 0); assert.equal(f.timers.size, 0);
  assert.deepEqual(await f.entries(), []);
  await f.start(); await until(() => f.calls.length === 1);
});

test('SDK error envelopes and malformed success results are retained as uncertain without automatic resend', async t => {
  for (const result of [{}, { response: { status: 204 }, error: { secret: 'hidden' } }, { response: { status: 404 } }]) await t.test(JSON.stringify(result.response ?? 'missing-response'), async t => {
    const f = await fixture(t); await f.write([event('envelope')]); f.execute(async () => result);
    const worker = await f.start(); await until(async () => (await f.entries())[0]?.state === 'uncertain');
    const before = f.reads(); worker.wake(); await until(() => f.reads() > before);
    assert.equal(f.calls.length, 1); assert.deepEqual(f.errors, ['delivery-uncertain']);
    assert.deepEqual(await readJson(join(f.directory, 'events.json')), [event('envelope')]);
    await worker.close();
  });
});

test('malformed scopes and journals fail closed and overlapping plugin instances cannot own the same scope', async t => {
  const f = await fixture(t); await f.write([event('one-owner')]);
  for (const invalid of [{ sessionId: 'codex:other' }, { sessionId: 'ses_other/session' }, { wallet: 'bad' }, { dataDir: 'relative' }, { rootDir: '/bad\npath' },
    { sessionDirectory: 'relative-native-directory' }, { sessionDirectory: '/bad\nnative-directory' }]) {
    await assert.rejects(f.start(invalid), /Invalid OpenCode notification scope/);
  }
  const paused = new AbortController(); paused.abort(); const inactive = await f.start({ signal: paused.signal });
  inactive.wake(); assert.equal(f.calls.length, 0);
  const worker = await f.start(); await until(async () => (await f.entries())[0]?.state === 'accepted');
  await assert.rejects(f.start(), /Lock .* is held/); assert.equal(f.calls.length, 1); await worker.close();
  const path = (await f.journalPaths())[0], original = (await f.saved())[0];
  for (const corrupted of [{ ...original, scope: 'foreign-session-scope' }, { ...original, entries: [...original.entries, ...original.entries] }, { ...original, entries: [{ ...original.entries[0], messageID: 'msg_unorderedHash' }] }]) {
    await atomicWriteJson(path, corrupted); await assert.rejects(f.start(), /OpenCode notification setup unavailable/);
  }
  assert.equal(f.calls.length, 1);
});
