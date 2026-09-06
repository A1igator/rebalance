import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as turn, setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import {
  configureCodexNotifications, codexNotificationStatus, prepareCodexNotifications,
  runCodexNotifications, stopCodexNotifications, type CodexNotificationDependencies,
} from '../src/codex-notifications.js';
import { createEventStream } from '../src/event-stream.js';
import { acquireLock, atomicWriteJson, readJson } from '../src/storage.js';

const threadId = '01a06e59-b024-7223-a09b-252967319442';
const event = (id = 'event-1') => ({ id, type: 'rebalance-completed', createdAt: '2026-09-06T03:00:00.000Z', message: 'A confirmed rebalance.' });
async function until(condition: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 500; i++) { if (await condition()) return; await delay(2); }
  assert.fail('Fixture did not settle');
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'rebalance-codex-notifications-'));
  const calls: { command: string; args: readonly string[] }[] = [];
  const timers: { ms: number; callback: () => void; cancelled: boolean }[] = [];
  let queueChanged: ((filename: string | null) => void) | undefined;
  let controlChanged: (() => void) | undefined;
  let controlFailed: (() => void) | undefined;
  let reads = 0;
  let execute: CodexNotificationDependencies['execute'] = async () => ({ stdout: `Queued message queue-1 for thread ${threadId}\n` });
  const deps: Partial<CodexNotificationDependencies> = {
    dataDir: directory, projectDir: '/fixture/rebalance', now: () => Date.parse('2026-09-06T03:00:00Z'),
    execute: async (command, args) => { calls.push({ command, args }); return execute(command, args); },
    stream: options => createEventStream({ ...options, read: async () => { reads++; return options.read(); } }, {
      watch: (_directory, changed) => { queueChanged = changed; return () => { queueChanged = undefined; }; },
      after: (ms, callback) => {
        const timer = { ms, callback, cancelled: false }; timers.push(timer);
        return () => { timer.cancelled = true; };
      },
    }),
    watchStop: (_directory, changed, failed) => {
      controlChanged = changed; controlFailed = failed;
      return () => { controlChanged = undefined; controlFailed = undefined; };
    },
  };
  const controllers: AbortController[] = [];
  const running: Promise<void>[] = [];
  t.after(async () => {
    for (const controller of controllers) controller.abort();
    await Promise.allSettled(running);
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory, deps, calls, timers, reads: () => reads,
    setExecute: (value: typeof execute) => { execute = value; },
    configure: () => configureCodexNotifications({ threadId }, deps),
    status: () => codexNotificationStatus(deps),
    writeEvents: async (value: unknown[]) => { await atomicWriteJson(join(directory, 'events.json'), value); queueChanged?.('events.json'); },
    wake: () => queueChanged?.('events.json'),
    controlChanged: () => controlChanged?.(), controlFailed: () => controlFailed?.(),
    start: async (token?: string) => {
      const controller = new AbortController(); controllers.push(controller);
      const task = runCodexNotifications({ signal: controller.signal, token }, deps); running.push(task);
      await until(() => controlChanged !== undefined);
      return { task, controller, stop: async () => { controller.abort(); await task; } };
    },
  };
}

test('configuration is local-only, validated and enabled without starting delivery', async t => {
  const f = await fixture(t);
  const status = await f.configure();
  assert.equal(status.enabled, true); assert.equal(status.running, false);
  assert.equal(f.calls.length, 0);
  for (const options of [
    { threadId: 'not-a-uuid' },
    { threadId, command: 'relative-command' },
    { threadId, command: '/path/with\nnewline' },
    { threadId, command: 'codex --unsafe' },
  ]) await assert.rejects(configureCodexNotifications(options, f.deps), /binding is invalid/);
  assert.deepEqual(await f.status(), status);
});

test('event changes deliver native queue args only and accepted events survive restart without duplication', async t => {
  const f = await fixture(t); await f.configure(); await f.writeEvents([event()]);
  const worker = await f.start();
  await until(async () => (await f.status()).acceptedCount === 1);
  assert.equal(f.calls.length, 1);
  const call = f.calls[0];
  assert.equal(call.command, 'codex');
  assert.deepEqual(call.args.slice(0, 4), ['queue', '--thread', threadId, '--message']);
  assert.equal(call.args.length, 5);
  assert.ok(!call.args.some(arg => ['--remote', 'resume', 'app-server', 'thread/resume', 'thread/start'].includes(arg)));
  assert.match(call.args[4], /Retained event ID: event-1/);
  assert.match(call.args[4], /Never arm or stop trading/);
  assert.doesNotMatch(call.args[4], /A confirmed rebalance\./, 'event prose is never embedded as command authority');
  assert.deepEqual(await readJson(join(f.directory, 'events.json')), [event()], 'transport does not acknowledge');
  const reads = f.reads(); await turn(); await turn();
  assert.equal(f.reads(), reads); assert.equal(f.timers.length, 0, 'no healthy polling');
  await worker.stop();
  const next = await f.start();
  await until(() => f.reads() > reads);
  assert.equal(f.calls.length, 1);
  await f.writeEvents([event(), event('event-2')]);
  await until(async () => (await f.status()).acceptedCount === 2);
  assert.equal(f.calls.length, 2);
  await next.stop();
});

test('connection-test events request only arrival reporting and exact acknowledgement', async t => {
  const f = await fixture(t); await f.configure();
  const probe = { ...event('notification-test-1'), type: 'notification-test', message: 'Connection test only.' };
  await f.writeEvents([probe]);
  const worker = await f.start();
  await until(async () => (await f.status()).acceptedCount === 1);
  const prompt = f.calls[0].args[4];
  assert.match(prompt, /type: notification-test/);
  assert.match(prompt, /report only that this connection test arrived/);
  assert.match(prompt, /it is not a financial outcome/);
  assert.match(prompt, /events ack notification-test-1/);
  assert.match(prompt, /Never arm or stop trading/);
  assert.deepEqual(await readJson(join(f.directory, 'events.json')), [probe]);
  await worker.stop();
});

test('timeouts, unsuccessful exits and malformed success output remain uncertain across restart', async t => {
  for (const mode of ['timeout', 'nonzero', 'wrong-thread', 'garbage']) await t.test(mode, async t => {
    const f = await fixture(t); await f.configure(); await f.writeEvents([event()]);
    f.setExecute(async () => {
      if (mode === 'timeout') throw Object.assign(new Error('timeout details'), { killed: true });
      if (mode === 'nonzero') throw Object.assign(new Error('command details'), { code: 1 });
      return { stdout: mode === 'garbage' ? 'maybe queued' : 'Queued message queue-1 for thread 00000000-0000-0000-0000-000000000000' };
    });
    const worker = await f.start();
    await until(async () => (await readJson<{ state: string }[]>(join(f.directory, 'codex-notification-deliveries.json')))?.[0]?.state === 'uncertain');
    assert.equal((await f.status()).error, 'delivery-uncertain');
    assert.equal(f.calls.length, 1); assert.equal(f.timers.length, 0);
    await worker.stop(); const next = await f.start();
    f.wake(); await turn(); await turn();
    assert.equal(f.calls.length, 1);
    assert.equal((await f.status()).acceptedCount, 0);
    assert.deepEqual(await readJson(join(f.directory, 'events.json')), [event()]);
    await f.writeEvents([{ ...event(), acknowledgedAt: '2026-09-06T03:01:00Z' }]);
    await until(async () => (await f.status()).uncertainEventIds.length === 0);
    assert.notEqual((await f.status()).error, 'delivery-uncertain');
    await next.stop();
  });
});

test('a crash-prepared journal is uncertain without another command; acknowledgement prunes it', async t => {
  const f = await fixture(t); await f.configure(); await f.writeEvents([event()]);
  await atomicWriteJson(join(f.directory, 'codex-notification-deliveries.json'), [
    { id: 'event-1', threadId, state: 'prepared', attemptedAt: event().createdAt },
  ]);
  const worker = await f.start();
  await until(() => f.reads() > 0);
  assert.deepEqual((await f.status()).uncertainEventIds, ['event-1']);
  assert.equal(f.calls.length, 0);
  await f.writeEvents([{ ...event(), acknowledgedAt: '2026-09-06T03:01:00Z' }]);
  await until(async () => (await readJson<unknown[]>(join(f.directory, 'codex-notification-deliveries.json')))?.length === 0);
  assert.equal((await f.status()).uncertainEventIds.length, 0);
  await worker.stop();
});

test('provable executable-not-found does not leave an uncertain delivery and may retry', async t => {
  const f = await fixture(t); await f.configure(); await f.writeEvents([event()]);
  f.setExecute(async () => { throw Object.assign(new Error('private path'), { code: 'ENOENT' }); });
  const worker = await f.start();
  await until(() => f.timers.length === 1);
  assert.equal((await f.status()).error, 'queue-unavailable');
  assert.deepEqual((await f.status()).uncertainEventIds, []);
  f.setExecute(async () => ({ stdout: `Queued message queue-1 for thread ${threadId}` }));
  f.timers[0].callback();
  await until(async () => (await f.status()).acceptedCount === 1);
  assert.equal(f.calls.length, 2);
  await worker.stop();
});

test('a failed preparation journal write retries a provably unsent event after backoff', async t => {
  const f = await fixture(t); await f.configure(); await f.writeEvents([event()]);
  let writes = 0;
  f.deps.persistJournal = async (path, entries) => {
    if (++writes === 1) throw Object.assign(new Error('private storage detail'), { code: 'EIO' });
    await atomicWriteJson(path, entries);
  };
  const worker = await f.start(); await until(() => f.timers.length === 1);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.status()).error, 'read-unavailable');
  assert.deepEqual((await f.status()).uncertainEventIds, []);
  f.timers[0].callback();
  await until(async () => (await f.status()).acceptedCount === 1);
  assert.equal(f.calls.length, 1);
  await worker.stop();
});

test('a post-dispatch journal failure retains the durable uncertainty barrier across restart', async t => {
  const f = await fixture(t); await f.configure(); await f.writeEvents([event()]);
  let writes = 0;
  f.deps.persistJournal = async (path, entries) => {
    if (++writes === 2) throw Object.assign(new Error('private storage detail'), { code: 'ENOENT' });
    await atomicWriteJson(path, entries);
  };
  const worker = await f.start(); await worker.task;
  assert.equal(f.calls.length, 1);
  assert.deepEqual((await f.status()).uncertainEventIds, ['event-1']);
  const next = await f.start(); await until(() => f.reads() >= 2);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(await readJson(join(f.directory, 'events.json')), [event()]);
  await next.stop();
});

test('paused preference and newer stop generation survive launcher handoff and restore attempts', async t => {
  const f = await fixture(t); await f.configure();
  const first = await prepareCodexNotifications({}, f.deps);
  assert.ok(first.token);
  await stopCodexNotifications(f.deps);
  assert.equal((await f.status()).enabled, false);
  const restore = await prepareCodexNotifications({ restoreOnly: true }, f.deps);
  assert.equal(restore.token, null); assert.equal(restore.status.enabled, false);
  await runCodexNotifications({ token: first.token! }, f.deps);
  assert.equal((await f.status()).running, false);
  const explicit = await prepareCodexNotifications({}, f.deps);
  assert.equal(explicit.status.enabled, true); assert.notEqual(explicit.token, first.token);
  await runCodexNotifications({ token: first.token! }, f.deps);
 
  const worker = await f.start(explicit.token!);
  await stopCodexNotifications(f.deps); f.controlChanged(); await worker.task;
  assert.equal((await f.status()).enabled, false); assert.equal((await f.status()).running, false);
});

test('serial delivery holds the notifier lock until an in-flight command settles on stop', async t => {
  const f = await fixture(t); await f.configure(); await f.writeEvents([event(), event('event-2')]);
  let complete!: () => void;
  f.setExecute(() => new Promise(resolve => { complete = () => resolve({ stdout: `Queued message queue-1 for thread ${threadId}` }); }));
  const worker = await f.start(); await until(() => f.calls.length === 1);
  await assert.rejects(runCodexNotifications({}, f.deps), /Lock codex-notifications.lock is held/);
  await assert.rejects(f.configure(), /Lock codex-notifications.lock is held/);
  worker.controller.abort(); await turn();
  assert.equal((await f.status()).running, true);
  complete(); await worker.task;
  assert.equal(f.calls.length, 1); assert.equal((await f.status()).running, false);
});

test('a stop committed during journal preparation prevents subsequent queue dispatch', async t => {
  const f = await fixture(t); await f.configure(); await f.writeEvents([event()]);
  let finishPreparation!: () => void;
  let first = true;
  f.deps.persistJournal = async (path, entries) => {
    if (first) { first = false; await new Promise<void>(resolve => { finishPreparation = resolve; }); }
    await atomicWriteJson(path, entries);
  };
  const worker = await f.start(); await until(() => finishPreparation !== undefined);
  await stopCodexNotifications(f.deps);
  finishPreparation(); await worker.task;
  assert.equal(f.calls.length, 0);
  assert.deepEqual((await f.status()).uncertainEventIds, []);
  assert.deepEqual(await readJson(join(f.directory, 'events.json')), [event()]);
});

test('control-lock contention before dispatch safely retries the known-unsent event', async t => {
  const f = await fixture(t); await f.configure(); await f.writeEvents([event()]);
  let releaseControl: (() => Promise<void>) | undefined;
  let first = true;
  f.deps.persistJournal = async (path, entries) => {
    await atomicWriteJson(path, entries);
    if (first) { first = false; releaseControl = await acquireLock(f.directory, 'codex-notifications-control.lock'); }
  };
  const worker = await f.start(); await until(() => f.timers.length === 1);
  assert.equal(f.calls.length, 0); assert.deepEqual((await f.status()).uncertainEventIds, []);
  assert.equal((await f.status()).error, 'read-unavailable');
  await releaseControl!(); f.timers[0].callback();
  await until(async () => (await f.status()).acceptedCount === 1);
  assert.equal(f.calls.length, 1);
  await worker.stop();
});

test('control-lock release failure after dispatch still awaits and journals that exact request', async t => {
  const f = await fixture(t); await f.configure(); await f.writeEvents([event()]);
  let complete!: () => void;
  f.setExecute(() => {
    writeFileSync(join(f.directory, 'codex-notifications-control.lock'), 'fixture corrupt release record');
    return new Promise(resolve => { complete = () => resolve({ stdout: `Queued message queue-1 for thread ${threadId}` }); });
  });
  const worker = await f.start(); await until(() => f.calls.length === 1);
  worker.controller.abort(); await delay(10);
  assert.equal((await f.status()).running, true, 'worker lock remains while dispatched request is unresolved');
  complete(); await worker.task;
  const status = await f.status();
  assert.equal(status.running, false); assert.equal(status.acceptedCount, 1);
  assert.equal(status.error, 'read-unavailable'); assert.equal(f.calls.length, 1);
});

test('watch failure ends this listener and retains events without changing its enabled preference', async t => {
  const f = await fixture(t); await f.configure();
  const worker = await f.start(); f.controlFailed(); await worker.task;
  const status = await f.status();
  assert.equal(status.enabled, true); assert.equal(status.running, false);
  assert.equal(status.error, 'watch-unavailable');
  assert.equal(f.calls.length, 0);
});

test('malformed event data is retained without code execution or content leakage', async t => {
  for (const invalid of [
    { ...event(), id: 'id; touch /tmp/injected' }, { ...event(), type: 'start-trading' },
    { ...event(), message: 'x'.repeat(4097) }, { ...event(), hash: 'invalid' },
  ]) await t.test(invalid.type + ':' + invalid.id, async t => {
    const f = await fixture(t); await f.configure(); await f.writeEvents([invalid]);
    const worker = await f.start();
    await until(() => f.timers.length === 1);
    await until(async () => (await readJson<{ error: string }>(join(f.directory, 'codex-notifications-status.json')))?.error === 'read-unavailable');
    assert.equal(f.calls.length, 0);
    assert.deepEqual(await readJson(join(f.directory, 'events.json')), [invalid]);
    assert.doesNotMatch(await readFile(join(f.directory, 'codex-notifications-status.json'), 'utf8'), /touch|xxxx/);
    await worker.stop();
  });
});

test('native executable fixture receives only queue append arguments without a remote or resume path', async t => {
  const f = await fixture(t);
  const command = join(f.directory, 'fixture-codex');
  const trace = join(f.directory, 'queue-trace.jsonl');
  await writeFile(command, `#!/usr/bin/env node\nconst fs=require('node:fs'); const args=process.argv.slice(2);\n` +
    `fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({args})+'\\n');\n` +
    `if(args.length!==5||args[0]!=='queue'||args[1]!=='--thread'||args[2]!==${JSON.stringify(threadId)}||args[3]!=='--message')process.exit(92);\n` +
    `console.log('Queued message fixture-entry for thread ${threadId}');\n`, { mode: 0o700 });
  const deps = { ...f.deps }; delete deps.execute;
  await configureCodexNotifications({ threadId, command }, deps);
  await f.writeEvents([event()]);
  const controller = new AbortController();
  const running = runCodexNotifications({ signal: controller.signal }, deps);
  try {
    await until(async () => (await codexNotificationStatus(deps)).acceptedCount === 1);
  } finally { controller.abort(); await running; }
  const records = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].args.slice(0, 4), ['queue', '--thread', threadId, '--message']);
  assert.equal(records[0].args.length, 5);
  assert.ok(!records[0].args.some((arg: string) => ['--remote', 'resume', 'app-server', 'thread/start', 'thread/resume'].includes(arg)));
});
