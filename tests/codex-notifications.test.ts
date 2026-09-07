import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  const withdrawals: { command: string; threadId: string; queueId: string }[] = [];
  const timers: { ms: number; callback: () => void; cancelled: boolean }[] = [];
  let queueChanged: ((filename: string | null) => void) | undefined;
  let controlChanged: (() => void) | undefined;
  let controlFailed: (() => void) | undefined;
  let reads = 0, completedReads = 0;
  let now = Date.parse('2026-09-06T03:00:00Z');
  let withdraw: CodexNotificationDependencies['withdraw'] = async () => 'deleted';
  let execute: CodexNotificationDependencies['execute'] = async () => ({ stdout: `Queued message queue-1 for thread ${threadId}\n` });
  const deps: Partial<CodexNotificationDependencies> = {
    dataDir: directory, rootDir: directory, projectDir: '/fixture/rebalance', now: () => now, statusModifiedAt: async () => now,
    withdraw: async (command, targetThread, queueId) => { withdrawals.push({ command, threadId: targetThread, queueId }); return withdraw(command, targetThread, queueId); },
    execute: async (command, args) => { calls.push({ command, args }); return execute(command, args); },
    stream: options => createEventStream({ ...options, read: async () => { reads++; try { return await options.read(); } finally { completedReads++; } } }, {
      now: () => now,
      watch: (_directory, changed) => { queueChanged = changed; return () => { queueChanged = undefined; }; },
      after: (ms, callback) => {
        const timer = { ms, callback: () => { timer.cancelled = true; callback(); }, cancelled: false }; timers.push(timer);
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
    directory, deps, calls, withdrawals, timers, reads: () => reads, completedReads: () => completedReads,
    setWithdraw: (value: typeof withdraw) => { withdraw = value; },
    setExecute: (value: typeof execute) => { execute = value; },
    configure: () => configureCodexNotifications({ threadId }, deps),
    status: () => codexNotificationStatus(deps),
    writeEvents: async (value: unknown[]) => { await atomicWriteJson(join(directory, 'events.json'), value); queueChanged?.('events.json'); },
    wake: () => queueChanged?.('events.json'),
    setTime: (value: number) => { now = value; },
    writeStatus: async (value: unknown) => { await atomicWriteJson(join(directory, 'status.json'), value); queueChanged?.('status.json'); },
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

test('queued notifications keep their wallet for reads and acknowledgement after chat attachment changes', async t => {
  const f = await fixture(t);
  const walletA = `0x${'a'.repeat(40)}`, walletB = `0x${'b'.repeat(40)}`;
  await atomicWriteJson(join(f.directory, 'config.json'), { wallet: walletA.toUpperCase().replace('0X', '0x'), chainId: 4663 });
  await mkdir(join(f.directory, 'connections'));
  await atomicWriteJson(join(f.directory, 'connections', 'fixture.json'), { version: 1, chainId: 4663, wallet: walletA });
  await f.configure(); await f.writeEvents([event()]);
  const worker = await f.start();
  await until(async () => (await f.status()).acceptedCount === 1);
  await atomicWriteJson(join(f.directory, 'connections', 'fixture.json'), { version: 1, chainId: 4663, wallet: walletB });
  await f.writeEvents([event(), event('event-2')]);
  await until(async () => (await f.status()).acceptedCount === 2);
  for (const call of f.calls) {
    const prompt = call.args[4];
    const command = `REBALANCE_ROOT_DIR='${f.directory}' npm run cli -- --profile ${walletA}`;
    assert.ok(prompt.includes(`wallet: ${walletA}`));
    assert.ok(prompt.includes(`${command} events`));
    assert.ok(prompt.includes(`${command} status`));
    assert.ok(prompt.includes(`${command} events ack `));
    assert.equal(prompt.split(`--profile ${walletA}`).length - 1, 3);
    assert.ok(!prompt.includes(walletB));
  }
  await worker.stop();
});

test('missing public configuration retains critical events with an explicitly pinned data directory', async t => {
  const f = await fixture(t); await f.configure();
  await f.writeEvents([{ ...event(), type: 'rebalance-attention' }]);
  const worker = await f.start();
  await until(async () => (await f.status()).acceptedCount === 1);
  const prompt = f.calls[0].args[4];
  const command = `REBALANCE_DATA_DIR='${f.directory}' REBALANCE_PROFILE_PINNED=1 npm run cli --`;
  assert.ok(prompt.includes(`${command} events`));
  assert.ok(prompt.includes(`${command} status`));
  assert.ok(prompt.includes(`${command} events ack event-1`));
  assert.doesNotMatch(prompt, /--profile/);
  await worker.stop();
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

const readFailureMessage = 'Rebalance needs attention: Fresh portfolio holdings or prices could not be read. No completion is confirmed by this alert. Review the current agent status before recovery.';
const quietEpoch = Date.parse('2026-09-06T03:00:00Z');
const readFailure = (id: string, at = quietEpoch) => ({ ...event(id), type: 'rebalance-attention', message: readFailureMessage, createdAt: new Date(at).toISOString() });
const readStatus = (failed: boolean, at: number) => ({ wallet: `0x${'a'.repeat(40)}`,
  portfolio: { totalUsdE8: '100', positions: [{ id: 'USDG', balance: '100', priceUsdE8: '100000000', valueUsdE8: '100', weightBps: 10000, targetBps: 10000 }] },
  updatedAt: new Date(at).toISOString(), error: failed ? 'Read failed' : null,
  graph: failed ? { node: 'error', trace: ['config', 'observe', 'error'] }
    : { node: 'wait', trace: ['config', 'observe', 'plan', 'wait'] },
});

test('Codex read failure waits for its exact deadline, deduplicates restarts, and recovers silently', async t => {
  const f = await fixture(t); await f.configure();
  await f.writeStatus(readStatus(true, quietEpoch - 1));
  await f.writeEvents([readFailure('quiet-read')]);
  const worker = await f.start();
  await until(() => f.timers.some(timer => !timer.cancelled));
  assert.equal(f.calls.length, 0);
  const deadline = f.timers.find(timer => !timer.cancelled)!;
  assert.equal(deadline.ms, 120_000);
  f.setTime(quietEpoch + 120_000); deadline.callback();
  await until(async () => (await f.status()).acceptedCount === 1);
  assert.equal(f.calls.length, 1);
  assert.doesNotMatch(f.calls[0].args[4], /completion, recovery/);
  await worker.stop(); const again = await f.start();
  const completedRead = f.reads(); f.wake(); await until(() => f.reads() > completedRead);
  assert.equal(f.calls.length, 1);
  f.setTime(quietEpoch + 125_000); await f.writeStatus(readStatus(false, quietEpoch + 125_000));
  await until(() => f.timers.some(timer => !timer.cancelled && timer.ms === 60_000));
  f.setTime(quietEpoch + 185_000); await f.writeStatus(readStatus(false, quietEpoch + 185_000));
  await until(async () => (await readJson<{incident: unknown}>(join(f.directory, 'read-notification-state.json')))?.incident === null);
  assert.equal(f.calls.length, 1, 'stable recovery never wakes the chat');
  await until(() => f.withdrawals.length === 1);
  await until(async () => (await readJson<{ withdrawal?: { state: string } }[]>(join(f.directory, 'codex-notification-deliveries.json')))?.[0]?.withdrawal?.state === 'deleted');
  assert.equal((await f.status()).acceptedCount, 0, 'withdrawn native prompts are no longer reported as queued');
  assert.equal((await readJson<{ state: string }[]>(join(f.directory, 'codex-notification-deliveries.json')))?.[0]?.state, 'accepted', 'withdrawal preserves the original durable acceptance barrier');
  assert.equal((await readJson<{acknowledgedAt?: string}[]>(join(f.directory, 'events.json')))![0].acknowledgedAt, undefined);
  await again.stop();
});

test('Codex suppresses transient reads and automatic recoveries without delaying completion or hiding filter failures', async t => {
  const f = await fixture(t); await f.configure();
  await f.writeStatus(readStatus(true, quietEpoch - 1));
  await f.writeEvents([readFailure('brief')]);
  const worker = await f.start(); await until(() => f.timers.some(timer => !timer.cancelled));
  f.setTime(quietEpoch + 10_000); await f.writeStatus(readStatus(false, quietEpoch + 10_000));
  await until(async () => (await readJson<{incident: unknown}>(join(f.directory, 'read-notification-state.json')))?.incident === null);
  await f.writeEvents([readFailure('brief'), { ...event('auto-recovery'), type: 'rebalance-recovered' }, event('completed')]);
  await until(async () => (await f.status()).acceptedCount === 1);
  assert.equal(f.calls.length, 1); assert.match(f.calls[0].args[4], /Retained event ID: completed;/);
  await writeFile(join(f.directory, 'read-notification-state.json'), '{invalid');
  await f.writeEvents([readFailure('brief'), event('completed'), event('critical-through-error')]);
  await until(async () => (await f.status()).acceptedCount === 2);
  assert.equal((await f.status()).error, 'read-unavailable');
  assert.equal(f.calls.length, 2);
  await worker.stop();
});


const quoteFailure = (id: string, at: number) => ({ ...readFailure(id, at),
  message: 'Rebalance needs attention: A usable swap quote could not be obtained. No completion is confirmed by this alert. Review the current agent status before recovery.' });
type JournalEntry = { id: string; threadId: string; state: string; attemptedAt: string; queueId?: string;
  withdrawal?: { state: string; attemptedAt: string } };
const acceptedEntry = (id: string, queueId: string, targetThread = threadId): JournalEntry => ({
  id, threadId: targetThread, state: 'accepted', attemptedAt: new Date(quietEpoch - 1_000).toISOString(), queueId,
});
const savedDeliveries = (directory: string) => readJson<JournalEntry[]>(join(directory, 'codex-notification-deliveries.json'));

// Every native withdrawal in this file is injected by fixture(); these are local
// application queues only, never real Codex task queues or live trading workers.
test('stale read and quote withdrawal uses only owned accepted IDs and retains protected journal entries', async t => {
  const f = await fixture(t); await f.configure();
  const otherThread = '00000000-0000-4000-8000-000000000002';
  const retained = [readFailure('owned-read', quietEpoch - 10_000), quoteFailure('owned-quote', quietEpoch - 9_000),
    event('critical-completion'), { ...readFailure('critical-hash', quietEpoch - 8_000), hash: `0x${'1'.repeat(64)}` },
    readFailure('uncertain-read', quietEpoch - 7_000), readFailure('foreign-read', quietEpoch - 6_000)];
  const protectedEntries = [acceptedEntry('critical-completion', 'critical-queue'), acceptedEntry('critical-hash', 'hash-queue'),
    { id: 'uncertain-read', threadId, state: 'uncertain', attemptedAt: new Date(quietEpoch - 1_000).toISOString() },
    acceptedEntry('foreign-read', 'foreign-queue', otherThread)];
  await f.writeEvents(retained);
  await f.writeStatus({ ...readStatus(false, quietEpoch), proposal: null });
  await atomicWriteJson(join(f.directory, 'codex-notification-deliveries.json'), [
    acceptedEntry('owned-read', 'read-queue'), acceptedEntry('owned-quote', 'quote-queue'), ...protectedEntries,
  ]);
  f.setWithdraw(async (command, target, queueId) => {
    assert.equal(command, 'codex'); assert.equal(target, threadId);
    assert.ok(['read-queue', 'quote-queue'].includes(queueId));
    const prepared = (await savedDeliveries(f.directory))!.find(entry => entry.queueId === queueId);
    assert.equal(prepared?.state, 'accepted'); assert.equal(prepared?.withdrawal?.state, 'prepared', 'intent must be durable before native deletion');
    return 'deleted';
  });
  const worker = await f.start();
  await until(() => f.withdrawals.length === 1);
  await until(() => f.timers.some(timer => !timer.cancelled && timer.ms === 1));
  f.setTime(quietEpoch + 1); f.timers.find(timer => !timer.cancelled && timer.ms === 1)!.callback();
  await until(async () => (await savedDeliveries(f.directory))?.filter(entry => entry.withdrawal?.state === 'deleted').length === 2);
  assert.deepEqual(f.withdrawals, [{ command: 'codex', threadId, queueId: 'read-queue' }, { command: 'codex', threadId, queueId: 'quote-queue' }]);
  assert.deepEqual((await savedDeliveries(f.directory))!.filter(entry => !entry.withdrawal), protectedEntries);
  assert.deepEqual(await readJson(join(f.directory, 'events.json')), retained, 'withdrawal is not acknowledgement or history deletion');
  assert.equal(f.calls.length, 0);
  await worker.stop();
});

test('withdrawal outcomes and crash-prepared intent remain no-resend barriers across restart', async t => {
  for (const mode of ['deleted', 'absent', 'throw', 'prepared-crash']) await t.test(mode, async t => {
    const f = await fixture(t); await f.configure();
    const retained = readFailure('withdrawn-read', quietEpoch - 180_000);
    await f.writeEvents([retained]); await f.writeStatus({ ...readStatus(false, quietEpoch), proposal: null });
    const seeded = acceptedEntry(retained.id, 'known-owned-queue');
    if (mode === 'prepared-crash') seeded.withdrawal = { state: 'prepared', attemptedAt: new Date(quietEpoch - 500).toISOString() };
    await atomicWriteJson(join(f.directory, 'codex-notification-deliveries.json'), [seeded]);
    f.setWithdraw(async () => { if (mode === 'throw') throw new Error('private native withdrawal detail'); return mode === 'absent' ? 'absent' : 'deleted'; });
    const worker = await f.start();
    const expected = mode === 'throw' ? 'uncertain' : mode === 'prepared-crash' ? 'prepared' : mode;
    await until(async () => (await savedDeliveries(f.directory))?.[0]?.withdrawal?.state === expected);
    await until(() => f.completedReads() > 0); // A seeded prepared intent predates the first filter read.
    await worker.stop();
    const barrier = await savedDeliveries(f.directory);
    // Re-adopt the old raw failure without suppression history: only the durable
    // delivery/withdrawal record now prevents a second native prompt or delete.
    await rm(join(f.directory, 'read-notification-state.json'), { force: true });
    f.setTime(quietEpoch + 1_000); await f.writeStatus(readStatus(true, quietEpoch - 181_000));
    const reads = f.reads(); const resumed = await f.start();
    await until(() => f.reads() > reads);
    await until(async () => (await readJson<{ incident: { eligible: boolean } | null }>(join(f.directory, 'read-notification-state.json')))?.incident?.eligible === true);
    await resumed.stop();
    assert.equal(f.withdrawals.length, mode === 'prepared-crash' ? 0 : 1);
    assert.equal(f.calls.length, 0); assert.deepEqual(await savedDeliveries(f.directory), barrier);
    assert.deepEqual(await readJson(join(f.directory, 'events.json')), [retained]);
    assert.doesNotMatch(await readFile(join(f.directory, 'codex-notification-deliveries.json'), 'utf8'), /private native/);
  });
});

test('healing during journal preparation vetoes a selected alert and later critical events still deliver', async t => {
  const f = await fixture(t); await f.configure();
  const retained = readFailure('selected-but-healed', quietEpoch - 180_000);
  await f.writeEvents([retained]); await f.writeStatus(readStatus(true, quietEpoch - 181_000));
  let waiting = false; let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.after(() => release());
  f.deps.persistJournal = async (path, entries) => {
    if (!waiting && entries.some(entry => entry.id === retained.id && entry.state === 'prepared')) {
      waiting = true; await gate;
    }
    await atomicWriteJson(path, entries);
  };
  const worker = await f.start(); await until(() => waiting);
  assert.equal(f.calls.length, 0);
  f.setTime(quietEpoch + 1); await f.writeStatus({ ...readStatus(false, quietEpoch + 1), proposal: null });
  release();
  await until(async () => (await savedDeliveries(f.directory))?.length === 0);
  assert.equal(f.calls.length, 0); assert.equal(f.withdrawals.length, 0);
  await f.writeEvents([retained, event('critical-after-veto')]);
  await until(async () => (await f.status()).acceptedCount === 1);
  assert.equal(f.calls.length, 1); assert.match(f.calls[0].args[4], /Retained event ID: critical-after-veto;/);
  assert.deepEqual((await savedDeliveries(f.directory))!.map(entry => entry.id), ['critical-after-veto']);
  assert.deepEqual(await readJson(join(f.directory, 'events.json')), [retained, event('critical-after-veto')]);
  await worker.stop();
});

test('a new critical event delivers before stale withdrawal and the finite backlog still drains', async t => {
  const f = await fixture(t); await f.configure();
  const stale = readFailure('stale-behind-critical', quietEpoch - 10_000);
  await f.writeEvents([stale, event('new-critical')]);
  await f.writeStatus({ ...readStatus(false, quietEpoch), proposal: null });
  await atomicWriteJson(join(f.directory, 'codex-notification-deliveries.json'), [acceptedEntry(stale.id, 'stale-native-queue')]);
  f.setWithdraw(async () => { assert.equal(f.calls.length, 1, 'a critical event must be sent before background withdrawal'); return 'deleted'; });
  const worker = await f.start();
  await until(async () => (await f.status()).queuedEventIds.includes('new-critical'));
  await until(() => f.withdrawals.length === 1 || f.timers.some(timer => !timer.cancelled && timer.ms === 1));
  if (f.withdrawals.length === 0) { f.setTime(quietEpoch + 1); f.timers.find(timer => !timer.cancelled && timer.ms === 1)!.callback(); }
  await until(async () => (await savedDeliveries(f.directory))?.find(entry => entry.id === stale.id)?.withdrawal?.state === 'deleted');
  assert.equal(f.calls.length, 1); assert.equal(f.withdrawals.length, 1);
  await worker.stop();
});

test('abort during the final asynchronous eligibility check prevents native execution after release', async t => {
  const f = await fixture(t); await f.configure();
  const retained = readFailure('abort-in-final-gate', quietEpoch - 180_000);
  await f.writeEvents([retained]); await f.writeStatus(readStatus(true, quietEpoch - 181_000));
  let checks = 0, waiting = false;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.deps.statusModifiedAt = async () => {
    if (++checks === 2) { waiting = true; await gate; }
    return quietEpoch;
  };
  const worker = await f.start();
  try {
    await until(() => waiting);
    assert.equal(checks, 2, 'the first selection completed and the final eligibility read is now blocked');
    assert.equal((await savedDeliveries(f.directory))?.[0]?.state, 'prepared');
    assert.equal(f.calls.length, 0);
    worker.controller.abort();
    release(); await worker.task;
    assert.equal(f.calls.length, 0, 'a successful eligibility result must not override an intervening abort');
    assert.equal(f.withdrawals.length, 0);
    assert.deepEqual(await savedDeliveries(f.directory), []);
    assert.deepEqual(await readJson(join(f.directory, 'events.json')), [retained]);
  } finally { release(); await worker.stop(); }
});

test('an uncertain critical enqueue still drains an already-stale accepted backlog without another file wake', async t => {
  const f = await fixture(t); await f.configure();
  const stale = readFailure('stale-after-ambiguous-send', quietEpoch - 10_000);
  const critical = event('uncertain-new-critical');
  await f.writeEvents([stale, critical]);
  await f.writeStatus({ ...readStatus(false, quietEpoch), proposal: null });
  await atomicWriteJson(join(f.directory, 'codex-notification-deliveries.json'), [acceptedEntry(stale.id, 'owned-stale-queue')]);
  f.setExecute(async () => { throw Object.assign(new Error('private native timeout detail'), { killed: true }); });
  f.setWithdraw(async (command, target, queueId) => {
    assert.equal(f.calls.length, 1);
    assert.equal((await savedDeliveries(f.directory))?.find(entry => entry.id === critical.id)?.state, 'uncertain', 'enqueue uncertainty is durable before cleanup');
    assert.equal(command, 'codex'); assert.equal(target, threadId); assert.equal(queueId, 'owned-stale-queue');
    return 'deleted';
  });
  const worker = await f.start();
  // No manual watcher hint or timer callback: enqueue settlement must wake cleanup.
  await until(async () => (await savedDeliveries(f.directory))?.find(entry => entry.id === stale.id)?.withdrawal?.state === 'deleted');
  assert.equal(f.calls.length, 1); assert.equal(f.withdrawals.length, 1);
  const unknown = (await savedDeliveries(f.directory))!.find(entry => entry.id === critical.id)!;
  assert.equal(unknown.state, 'uncertain'); assert.equal(unknown.queueId, undefined); assert.equal(unknown.withdrawal, undefined);
  assert.deepEqual((await f.status()).uncertainEventIds, [critical.id]);
  assert.deepEqual(await readJson(join(f.directory, 'events.json')), [stale, critical]);
  await worker.stop();
});
