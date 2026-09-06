import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { launch, type LaunchDependencies } from '../src/launch.js';
import type { Status } from '../src/runtime.js';
import type { CodexNotificationStatus } from '../src/codex-notifications.js';
import { atomicWriteJson, readJson } from '../src/storage.js';

const targets = { USDG: 500, AAPL: 2375, NVDA: 2375, MSFT: 2375, AMD: 2375 };
const targetText = 'USDG=5,AAPL=23.75,NVDA=23.75,MSFT=23.75,AMD=23.75';
const wallet = '0x0000000000000000000000000000000000000001';
function status(): Status {
  return { app: 'Rebalance', chain: { id: 4663, name: 'Robinhood' }, mode: 'private-key', wallet,
    config: { targets, rebalanceIntervalSeconds: 3600 }, cycle: null, portfolio: null, operation: null,
    updatedAt: null, error: null, graph: { node: 'wait', trace: [] }, armed: false };
}
async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'rebalance-launch-test-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const current = status();
  const calls: string[][] = [];
  const notificationCalls: string[][] = [];
  const notifications: CodexNotificationStatus = { configured: false, enabled: false, running: false,
    threadId: null, command: null, acceptedCount: 0, queuedEventIds: [], uncertainEventIds: [], error: null, note: 'fixture' };
  const alive = new Set([101]);
  await atomicWriteJson(join(dataDir, 'chart.lock'), { pid: 101, createdAt: 'fixture' });
  const deps: LaunchDependencies = {
    dataDir, attempts: 3, pause: async () => {}, alive: pid => alive.has(pid),
    chartStatus: async () => ({ state: 'response', value: structuredClone(current) }),
    command: async args => {
      if (args[0] === 'notifications') {
        notificationCalls.push(args);
        if (args[1] === 'start') { assert.deepEqual(args.slice(2), ['--background', '--enabled-only']); notifications.running = notifications.enabled; }
        else assert.equal(args[1], 'status');
        return { ok: true, value: { ...structuredClone(notifications), state: notifications.running ? 'running' : 'paused' } };
      }
      calls.push(args);
      if (args[0] === 'status' || args[0] === 'check') return { ok: true, value: structuredClone(current) };
      if (args[0] === 'wallet') { current.wallet = wallet; return { ok: true, value: { address: wallet, created: true } }; }
      if (args[0] === 'configure') {
        current.config = { targets, rebalanceIntervalSeconds: 3600 }; current.mode = 'private-key';
        return { ok: true, value: {} };
      }
      if (args[0] === 'chart') {
        alive.add(101); await atomicWriteJson(join(dataDir, 'chart.lock'), { pid: 101, createdAt: 'fixture' });
        return { ok: true, value: { status: 'starting', pid: 101 } };
      }
      if (args[0] === 'start') {
        const stopped = await readJson(join(dataDir, 'stop.json'));
        const expected = stopped === null ? 'none' : createHash('sha256').update(JSON.stringify(stopped)).digest('hex');
        if (args[2] !== '--expected-stop' || args[3] !== expected) return { ok: false, value: { error: 'Newer stop preserved' } };
        await rm(join(dataDir, 'stop.json'), { force: true });
        alive.add(202); current.armed = true;
        await atomicWriteJson(join(dataDir, 'run.lock'), { pid: 202, createdAt: 'fixture' });
        return { ok: true, value: { status: 'starting', pid: 202 } };
      }
      assert.fail(`Unexpected fixture command: ${args[0]}`);
    },
  };
  return { dataDir, current, calls, alive, deps, notifications, notificationCalls };
}
const count = (calls: string[][], command: string) => calls.filter(args => args[0] === command).length;

test('full launch checks first, reuses the owned chart, starts once, and verifies public arming', async t => {
  const f = await fixture(t);
  const launched = await launch({}, f.deps);
  assert.equal(launched.outcome, 'armed');
  assert.equal(launched.status?.armed, true);
  assert.equal(launched.chart.state, 'ready');
  assert.deepEqual(launched.status?.config?.targets, targets);
  assert.deepEqual(f.calls.map(args => args[0]), ['status', 'check', 'status', 'start', 'status']);
  assert.equal(count(f.calls, 'wallet'), 0);
  assert.equal(count(f.calls, 'configure'), 0);
  assert.deepEqual(f.calls.find(args => args[0] === 'start'), ['start', '--background', '--expected-stop', 'none']);
});

test('setup-only preserves stop, pending and cycle records and never starts a runner', async t => {
  const f = await fixture(t);
  const records = ['stop.json', 'pending.json', 'cycle.json'];
  for (const file of records) await writeFile(join(f.dataDir, file), `{"fixture":"${file}"}\n`);
  const before = await Promise.all(records.map(file => readFile(join(f.dataDir, file), 'utf8')));
  const launched = await launch({ setupOnly: true }, f.deps);
  assert.equal(launched.outcome, 'ready');
  assert.equal(launched.status?.armed, false);
  assert.equal(count(f.calls, 'start'), 0);
  assert.deepEqual(await Promise.all(records.map(file => readFile(join(f.dataDir, file), 'utf8'))), before);
});

test('an active runner is reused without a check, restart or target overwrite', async t => {
  const f = await fixture(t); f.current.armed = true; f.alive.add(202);
  await atomicWriteJson(join(f.dataDir, 'run.lock'), { pid: 202, createdAt: 'fixture' });
  const launched = await launch({ targets: 'different saved choices must survive' }, f.deps);
  assert.equal(launched.outcome, 'armed');
  assert.deepEqual(f.calls, [['status'], ['status']]);
  assert.deepEqual(launched.status?.config?.targets, targets);
});

test('first setup without explicit percentages requests input without creating a wallet or runner', async t => {
  const f = await fixture(t); Object.assign(f.current, { wallet: null, config: null, mode: null });
  const launched = await launch({}, f.deps);
  assert.equal(launched.outcome, 'needs-input');
  assert.deepEqual(f.calls, [['status']]);
});

test('first setup with explicit percentages uses wallet/configure commands and verifies setup', async t => {
  const f = await fixture(t); Object.assign(f.current, { wallet: null, config: null, mode: null });
  const launched = await launch({ setupOnly: true, targets: targetText }, f.deps);
  assert.equal(launched.outcome, 'ready');
  assert.deepEqual(f.calls.slice(0, 5), [['status'], ['wallet', 'create'], ['configure', '--targets', targetText], ['status'], ['check']]);
  assert.equal(count(f.calls, 'start'), 0);
});

test('existing public wallet without allocation is retained during explicit setup', async t => {
  const f = await fixture(t); f.current.config = null;
  const launched = await launch({ setupOnly: true, targets: targetText }, f.deps);
  assert.equal(launched.outcome, 'ready');
  assert.equal(count(f.calls, 'wallet'), 0);
});

test('failed or malformed status is recovery, never permission to create a replacement wallet', async t => {
  const f = await fixture(t);
  f.deps.command = async args => { f.calls.push(args); return { ok: false, value: { error: 'corrupt config' } }; };
  const launched = await launch({ targets: targetText }, f.deps);
  assert.equal(launched.outcome, 'blocked');
  assert.deepEqual(f.calls, [['status']]);
});

test('read-only RPC failure prevents arming while chart setup is still inspected', async t => {
  const f = await fixture(t); const command = f.deps.command;
  f.deps.command = async args => {
    if (args[0] !== 'check') return command(args);
    f.calls.push(args); f.current.error = 'Fixture RPC unavailable';
    return { ok: false, value: structuredClone(f.current) };
  };
  const launched = await launch({}, f.deps);
  assert.equal(launched.outcome, 'blocked');
  assert.equal(launched.status?.error, 'Fixture RPC unavailable');
  assert.equal(launched.chart.state, 'ready');
  assert.equal(count(f.calls, 'start'), 0);
});

test('malformed successful check cannot reuse stale status as fresh evidence for arming', async t => {
  const f = await fixture(t); const command = f.deps.command;
  f.deps.command = async args => args[0] === 'check' ? { ok: true, value: {} } : command(args);
  assert.equal((await launch({}, f.deps)).outcome, 'blocked');
  assert.equal(count(f.calls, 'start'), 0);
});

test('full raw-key launch arms automatic recovery without rewriting transaction or cycle records', async t => {
  for (const operation of ['unresolved', 'reverted'] as const) {
    const f = await fixture(t); const hash = `0x${'1'.repeat(64)}`;
    f.current.operation = { status: operation, hash };
    const records = { 'pending.json': { hash, nonce: 16 },
      'recovery.json': { originalHash: hash, cancellationHash: `0x${'2'.repeat(64)}`, status: 'unknown' },
      'cycle.json': { startedAt: 'fixture', nextEligibleAt: 'preserved', swapConfirmed: true } };
    for (const [file, value] of Object.entries(records)) await atomicWriteJson(join(f.dataDir, file), value);
    const before = await Promise.all(Object.keys(records).map(file => readFile(join(f.dataDir, file), 'utf8')));
    const launched = await launch({}, f.deps);
    assert.equal(launched.outcome, 'armed', operation);
    assert.equal(launched.status?.operation?.hash, hash);
    assert.equal(launched.status?.operation?.status, operation, 'arming does not claim a resolved receipt');
    assert.match(launched.messages.join(' '), /automatic recovery/i);
    assert.deepEqual(await Promise.all(Object.keys(records).map(file => readFile(join(f.dataDir, file), 'utf8'))), before);
    assert.equal(count(f.calls, 'start'), 1);
    assert.equal(count(f.calls, 'recover'), 0, 'recovery belongs to the graph, not the manual wrapper');
    assert.equal(count(f.calls, 'stop'), 0);
  }
});

test('setup-only and deferred signers never arm through a recovery barrier', async t => {
  for (const operation of ['unresolved', 'reverted'] as const) {
    for (const mode of ['private-key', 'ledger', 'privy'] as const) {
      for (const setupOnly of [true, false]) {
        if (!setupOnly && mode === 'private-key') continue;
        const f = await fixture(t); f.current.mode = mode;
        f.current.operation = { status: operation, hash: `0x${'1'.repeat(64)}` };
        const launched = await launch({ setupOnly }, f.deps);
        assert.equal(launched.outcome, 'blocked');
        assert.equal(launched.status?.armed, false);
        assert.equal(launched.status?.mode, mode);
        assert.equal(count(f.calls, 'start'), 0);
        assert.equal(count(f.calls, 'recover'), 0);
        assert.equal(count(f.calls, 'configure'), 0);
      }
    }
  }
});

test('recovery eligibility never overrides failed, malformed or errored preflight', async t => {
  for (const failure of ['failed', 'malformed', 'error'] as const) {
    const f = await fixture(t); const command = f.deps.command;
    f.current.operation = { status: 'unresolved', hash: `0x${'1'.repeat(64)}` };
    f.deps.command = async args => {
      if (args[0] !== 'check') return command(args);
      f.calls.push(args);
      if (failure === 'error') f.current.error = 'Pending account does not match configuration';
      return { ok: failure !== 'failed', value: failure === 'malformed' ? {} : structuredClone(f.current) };
    };
    assert.equal((await launch({}, f.deps)).outcome, 'blocked', failure);
    assert.equal(count(f.calls, 'start'), 0);
  }
});

test('a newer stop during unresolved preflight wins over automatic-recovery launch', async t => {
  const f = await fixture(t); const command = f.deps.command;
  f.current.operation = { status: 'unresolved', hash: `0x${'1'.repeat(64)}` };
  const stopped = { requestedAt: 'newer-stop', requestId: 'user-stop' };
  f.deps.command = async args => {
    if (args[0] === 'check') await atomicWriteJson(join(f.dataDir, 'stop.json'), stopped);
    return command(args);
  };
  const launched = await launch({}, f.deps);
  assert.equal(launched.outcome, 'blocked');
  assert.equal(count(f.calls, 'start'), 0);
  assert.deepEqual(await readJson(join(f.dataDir, 'stop.json')), stopped);
});

test('new explicit launch after a stop arms recovery once while replay preserves a later stop', async t => {
  const f = await fixture(t);
  f.current.operation = { status: 'unresolved', hash: `0x${'1'.repeat(64)}` };
  await atomicWriteJson(join(f.dataDir, 'stop.json'), { requestId: 'earlier-stop' });
  const launched = await launch({ requestId: 'explicit-new-launch' }, f.deps);
  assert.equal(launched.outcome, 'armed');
  assert.equal(await readJson(join(f.dataDir, 'stop.json')), null);
  // The still-unresolved active runner is reused, not cancelled or restarted.
  assert.equal((await launch({ requestId: 'reuse' }, f.deps)).outcome, 'armed');
  assert.equal(count(f.calls, 'check'), 1);
  f.current.armed = false; f.alive.delete(202);
  await rm(join(f.dataDir, 'run.lock'));
  const stopped = { requestId: 'later-stop' };
  await atomicWriteJson(join(f.dataDir, 'stop.json'), stopped);
  assert.equal((await launch({ requestId: 'explicit-new-launch' }, f.deps)).outcome, 'already-handled');
  assert.deepEqual(await readJson(join(f.dataDir, 'stop.json')), stopped);
  assert.equal(count(f.calls, 'start'), 1);
  assert.equal(count(f.calls, 'recover'), 0);
});

test('a live runner lock with unarmed status is starting/stopping and is never cleared', async t => {
  const f = await fixture(t); f.alive.add(202);
  const lock = { pid: 202, createdAt: 'fixture' };
  await atomicWriteJson(join(f.dataDir, 'run.lock'), lock);
  const launched = await launch({}, f.deps);
  assert.equal(launched.outcome, 'busy');
  assert.deepEqual(f.calls, [['status'], ['status']]);
  assert.deepEqual(await readJson(join(f.dataDir, 'run.lock')), lock);
});

test('a slow background runner is not duplicated by a later distinct launch request', async t => {
  const f = await fixture(t); const command = f.deps.command;
  f.deps.command = async args => {
    if (args[0] !== 'start') return command(args);
    f.calls.push(args); f.alive.add(202);
    return { ok: true, value: { status: 'starting', pid: 202 } };
  };
  assert.equal((await launch({ requestId: 'first' }, f.deps)).outcome, 'starting');
  assert.equal((await launch({ requestId: 'second' }, f.deps)).outcome, 'busy');
  assert.equal(count(f.calls, 'start'), 1);
  assert.equal(f.current.armed, false);
});

test('replaying the same hook request after a later stop does not rearm trading', async t => {
  const f = await fixture(t);
  assert.equal((await launch({ requestId: 'session/turn' }, f.deps)).outcome, 'armed');
  f.current.armed = false; f.alive.delete(202);
  await rm(join(f.dataDir, 'run.lock'));
  await atomicWriteJson(join(f.dataDir, 'stop.json'), { requestedAt: 'fixture' });
  const replay = await launch({ requestId: 'session/turn' }, f.deps);
  assert.equal(replay.outcome, 'already-handled');
  assert.equal(replay.chart.state, 'not-checked', 'replay does not claim chart availability without a probe');
  assert.equal(count(f.calls, 'start'), 1);
  assert.deepEqual(await readJson(join(f.dataDir, 'stop.json')), { requestedAt: 'fixture' });
});

test('concurrent launches share one launch lock and only one runner request', async t => {
  const f = await fixture(t); const command = f.deps.command;
  let signal!: () => void; const entered = new Promise<void>(r => { signal = r; });
  let resume!: () => void; const gate = new Promise<void>(r => { resume = r; });
  f.deps.command = async args => {
    if (args[0] === 'check') { signal(); await gate; }
    return command(args);
  };
  const first = launch({ requestId: 'one' }, f.deps);
  await entered;
  assert.equal((await launch({ requestId: 'two' }, f.deps)).outcome, 'busy');
  resume();
  assert.equal((await first).outcome, 'armed');
  assert.equal(count(f.calls, 'start'), 1);
});

test('an unrelated or mismatched chart listener blocks launch and is never killed or replaced', async t => {
  for (const kind of ['unowned', 'wallet', 'targets', 'html', 'unavailable'] as const) {
    const f = await fixture(t); const chart = structuredClone(f.current);
    if (kind === 'unowned') { f.alive.delete(101); await rm(join(f.dataDir, 'chart.lock')); }
    if (kind === 'wallet') chart.wallet = '0x0000000000000000000000000000000000000002';
    if (kind === 'targets') chart.config!.targets.USDG = 600;
    if (kind === 'unavailable') { f.alive.delete(101); await rm(join(f.dataDir, 'chart.lock')); }
    f.deps.chartStatus = async () => kind === 'unavailable' ? { state: 'unavailable' }
      : { state: 'response', value: kind === 'html' ? '<html>Not a chart</html>' : chart };
    const launched = await launch({}, f.deps);
    assert.equal(launched.outcome, 'blocked', kind);
    assert.equal(launched.chart.state, 'blocked', kind);
    assert.equal(count(f.calls, 'chart'), 0, kind);
    assert.equal(count(f.calls, 'start'), 0, kind);
  }
});

test('missing chart is started once and readiness is verified after spawn acknowledgement', async t => {
  const f = await fixture(t); f.alive.delete(101); await rm(join(f.dataDir, 'chart.lock'));
  f.deps.chartStatus = async () => f.alive.has(101) ? { state: 'response', value: structuredClone(f.current) } : { state: 'absent' };
  const launched = await launch({ setupOnly: true }, f.deps);
  assert.equal(launched.outcome, 'ready');
  assert.equal(launched.chart.state, 'ready');
  assert.equal(count(f.calls, 'chart'), 1);
});

test('a spawned chart without a verified endpoint blocks trading and is not duplicated on retry', async t => {
  const f = await fixture(t); f.alive.delete(101); await rm(join(f.dataDir, 'chart.lock'));
  f.deps.chartStatus = async () => ({ state: 'absent' });
  assert.equal((await launch({ requestId: 'one' }, f.deps)).outcome, 'blocked');
  assert.equal((await launch({ requestId: 'two' }, f.deps)).outcome, 'blocked');
  assert.equal(count(f.calls, 'chart'), 1);
  assert.equal(count(f.calls, 'start'), 0);
});

test('deferred Ledger mode stays selected and arming is not reported as working Ledger execution', async t => {
  const f = await fixture(t); f.current.mode = 'ledger';
  const launched = await launch({}, f.deps);
  assert.equal(launched.outcome, 'armed');
  assert.equal(launched.status?.mode, 'ledger');
  assert.match(launched.messages.join(' '), /ledger execution is deferred/);
  assert.equal(count(f.calls, 'wallet'), 0);
  assert.equal(count(f.calls, 'configure'), 0);
});

test('an earlier stop can be resumed using its exact captured generation', async t => {
  const f = await fixture(t);
  const stopped = { requestedAt: 'fixture-before-launch', id: 'first-stop' };
  await atomicWriteJson(join(f.dataDir, 'stop.json'), stopped);
  const launched = await launch({}, f.deps);
  assert.equal(launched.outcome, 'armed');
  assert.deepEqual(f.calls.find(args => args[0] === 'start'), ['start', '--background', '--expected-stop',
    createHash('sha256').update(JSON.stringify(stopped)).digest('hex')]);
  assert.equal(await readJson(join(f.dataDir, 'stop.json')), null);
});

test('a newer stop during read-only preparation wins over the earlier launch', async t => {
  const f = await fixture(t); const command = f.deps.command;
  const stopped = { requestedAt: 'fixture-after-launch', id: 'new-stop' };
  f.deps.command = async args => {
    if (args[0] === 'check') await atomicWriteJson(join(f.dataDir, 'stop.json'), stopped);
    return command(args);
  };
  const launched = await launch({}, f.deps);
  assert.equal(launched.outcome, 'blocked');
  assert.match(launched.messages.join(' '), /newer stop/);
  assert.equal(count(f.calls, 'start'), 0);
  assert.deepEqual(await readJson(join(f.dataDir, 'stop.json')), stopped);
});

test('the expected-stop argument lets the CLI reject a stop racing the final spawn request', async t => {
  const f = await fixture(t); const command = f.deps.command;
  const stopped = { requestedAt: 'fixture-at-start-boundary', id: 'last-stop' };
  f.deps.command = async args => {
    if (args[0] === 'start') await atomicWriteJson(join(f.dataDir, 'stop.json'), stopped);
    return command(args);
  };
  const launched = await launch({}, f.deps);
  assert.equal(launched.status?.armed, false);
  assert.equal(f.alive.has(202), false);
  assert.deepEqual(await readJson(join(f.dataDir, 'stop.json')), stopped);
  assert.deepEqual(f.calls.find(args => args[0] === 'start'), ['start', '--background', '--expected-stop', 'none']);
});

test('bookkeeping failure after a real spawn response refreshes armed state instead of claiming unarmed', async t => {
  const f = await fixture(t); const command = f.deps.command;
  f.deps.command = async args => {
    const response = await command(args);
    if (args[0] === 'start') {
      // A directory at the record path makes the atomic rename fail, after the
      // stubbed start has already made a live armed runner visible.
      const { mkdir } = await import('node:fs/promises');
      await mkdir(join(f.dataDir, 'launch-processes.json'));
    }
    return response;
  };
  const launched = await launch({}, f.deps);
  assert.equal(launched.outcome, 'armed');
  assert.equal(launched.status?.armed, true);
  assert.match(launched.messages.join(' '), /bookkeeping or readiness checks failed/);
  assert.equal(count(f.calls, 'start'), 1);
});

test('failed readiness reads after spawn report unknown state without blindly starting again', async t => {
  const f = await fixture(t); const command = f.deps.command;
  let startRequested = false;
  f.deps.command = async args => {
    if (args[0] === 'status' && startRequested) return { ok: false, value: {} };
    const response = await command(args);
    if (args[0] === 'start') startRequested = true;
    return response;
  };
  const launched = await launch({}, f.deps);
  assert.equal(launched.outcome, 'starting');
  assert.equal(launched.status, null);
  assert.match(launched.messages.join(' '), /may have launched.*do not blindly retry/);
  assert.equal(count(f.calls, 'start'), 1);
  assert.equal(f.current.armed, true, 'fixture confirms the uncertainty can hide an already active runner');
});

test('wallet, mode or targets changing after preparation invalidate the chart check and prevent start', async t => {
  for (const field of ['wallet', 'mode', 'targets'] as const) {
    const f = await fixture(t); const command = f.deps.command;
    let statusReads = 0;
    f.deps.command = async args => {
      if (args[0] === 'status' && ++statusReads === 2) {
        if (field === 'wallet') f.current.wallet = '0x0000000000000000000000000000000000000002';
        if (field === 'mode') f.current.mode = 'ledger';
        if (field === 'targets') f.current.config!.targets = { ...targets, USDG: 600, AAPL: 2275 };
      }
      return command(args);
    };
    const launched = await launch({}, f.deps);
    assert.equal(launched.outcome, 'blocked', field);
    assert.equal(launched.chart.state, 'not-checked', field);
    assert.match(launched.messages.join(' '), /Configuration changed during launch/, field);
    assert.equal(count(f.calls, 'start'), 0, field);
  }
});

test('an active runner stopped while the chart probe awaits is reported stopped and never resumed', async t => {
  for (const setupOnly of [false, true]) {
    const f = await fixture(t); f.current.armed = true; f.alive.add(202);
    await atomicWriteJson(join(f.dataDir, 'run.lock'), { pid: 202, createdAt: 'fixture' });
    f.deps.chartStatus = async () => {
      const previous = structuredClone(f.current);
      f.current.armed = false; f.alive.delete(202);
      await rm(join(f.dataDir, 'run.lock'));
      await atomicWriteJson(join(f.dataDir, 'stop.json'), { requestedAt: 'during-chart', id: 'new-stop' });
      return { state: 'response', value: previous };
    };
    const launched = await launch({ setupOnly }, f.deps);
    assert.equal(launched.outcome, 'blocked');
    assert.equal(launched.status?.armed, false);
    assert.match(launched.messages.join(' '), /stopped or exited.*not resumed/);
    assert.equal(count(f.calls, 'start'), 0);
  }
});

test('setup-only notices a configuration change during the chart probe instead of claiming readiness', async t => {
  const f = await fixture(t);
  f.deps.chartStatus = async () => {
    const previous = structuredClone(f.current);
    f.current.config!.targets = { ...targets, USDG: 600, AAPL: 2275 };
    return { state: 'response', value: previous };
  };
  const launched = await launch({ setupOnly: true }, f.deps);
  assert.equal(launched.outcome, 'blocked');
  assert.equal(launched.chart.state, 'not-checked');
  assert.equal(launched.status?.config?.targets.USDG, 600);
  assert.equal(count(f.calls, 'start'), 0);
});

test('active-runner reuse reports new configuration and invalidates an earlier chart match', async t => {
  const f = await fixture(t); f.current.armed = true;
  f.deps.chartStatus = async () => {
    const previous = structuredClone(f.current);
    f.current.config!.targets = { ...targets, USDG: 600, AAPL: 2275 };
    return { state: 'response', value: previous };
  };
  const launched = await launch({}, f.deps);
  assert.equal(launched.outcome, 'armed', 'current armed state is still accurate');
  assert.equal(launched.chart.state, 'not-checked');
  assert.equal(launched.status?.config?.targets.USDG, 600);
  assert.equal(count(f.calls, 'check'), 0);
  assert.equal(count(f.calls, 'start'), 0);
});

test('a hook stop snapshot captured before bootstrap preserves a newer stop before launch begins', async t => {
  const f = await fixture(t);
  const newerStop = { requestedAt: 'during-dependency-install', id: 'new-stop' };
  await atomicWriteJson(join(f.dataDir, 'stop.json'), newerStop);
  const launched = await launch({ expectedStop: 'none' }, f.deps);
  assert.equal(launched.outcome, 'blocked');
  assert.equal(count(f.calls, 'start'), 0);
  assert.deepEqual(await readJson(join(f.dataDir, 'stop.json')), newerStop);
});

test('expected-stop accepts lowercase digest snapshots and rejects malformed tokens before work', async t => {
  const f = await fixture(t);
  for (const expectedStop of ['', 'NONE', 'a'.repeat(63), 'A'.repeat(64), '../stop.json']) {
    const launched = await launch({ expectedStop }, f.deps);
    assert.equal(launched.outcome, 'blocked');
    assert.match(launched.messages.join(' '), /Invalid expected stop generation/);
  }
  assert.deepEqual(f.calls, []);
  const stopped = { requestedAt: 'before-hook', id: 'same-stop' };
  await atomicWriteJson(join(f.dataDir, 'stop.json'), stopped);
  const expectedStop = createHash('sha256').update(JSON.stringify(stopped)).digest('hex');
  assert.equal((await launch({ expectedStop }, f.deps)).outcome, 'armed');
  assert.equal(f.calls.find(args => args[0] === 'start')?.[3], expectedStop);
});


test('launch restores an enabled notification listener once and reuses it on later skill launches', async t => {
  const f = await fixture(t);
  Object.assign(f.notifications, { configured: true, enabled: true, threadId: '00000000-0000-4000-8000-000000000001' });
  const first = await launch({ setupOnly: true }, f.deps);
  assert.equal(first.outcome, 'ready');
  assert.equal(first.notifications.state, 'running');
  assert.equal(first.notifications.status?.running, true);
  const second = await launch({ setupOnly: true }, f.deps);
  assert.equal(second.notifications.state, 'running');
  assert.deepEqual(f.notificationCalls, [['notifications', 'status'], ['notifications', 'start', '--background', '--enabled-only'], ['notifications', 'status']]);
  assert.equal(count(f.calls, 'start'), 0, 'notification restoration cannot arm trading during setup-only');
});

test('launch preserves paused notification preference and all financial records', async t => {
  const f = await fixture(t); f.notifications.configured = true;
  const records = ['stop.json', 'pending.json', 'cycle.json', 'recovery.json'];
  for (const file of records) await atomicWriteJson(join(f.dataDir, file), { fixture: file });
  const before = await Promise.all(records.map(file => readFile(join(f.dataDir, file), 'utf8')));
  const result = await launch({ setupOnly: true }, f.deps);
  assert.equal(result.outcome, 'ready');
  assert.equal(result.notifications.state, 'paused');
  assert.deepEqual(f.notificationCalls, [['notifications', 'status']]);
  assert.equal(f.notifications.enabled, false);
  assert.deepEqual(await Promise.all(records.map(file => readFile(join(f.dataDir, file), 'utf8'))), before);
});

test('notification failure is separate from the verified financial launch outcome', async t => {
  const f = await fixture(t); const command = f.deps.command;
  f.deps.command = async args => args[0] === 'notifications' ? { ok: false, value: { error: 'private endpoint diagnostic' } } : command(args);
  const result = await launch({}, f.deps);
  assert.equal(result.outcome, 'armed');
  assert.equal(result.status?.armed, true);
  assert.equal(result.notifications.state, 'unavailable');
  assert.doesNotMatch(JSON.stringify(result), /private endpoint diagnostic/);
  assert.equal(count(f.calls, 'start'), 1);
});

test('notification restore rechecks a pause racing its status read and never overrides it', async t => {
  const f = await fixture(t); Object.assign(f.notifications, { configured: true, enabled: true });
  const command = f.deps.command;
  f.deps.command = async args => {
    if (args[0] === 'notifications' && args[1] === 'start') f.notifications.enabled = false;
    return command(args);
  };
  const result = await launch({ setupOnly: true }, f.deps);
  assert.equal(result.outcome, 'ready');
  assert.equal(result.notifications.state, 'paused');
  assert.equal(f.notifications.running, false);
  assert.equal(count(f.calls, 'start'), 0);
});

test('replayed launch requests do not restore notifications or undo a newer notification stop', async t => {
  const f = await fixture(t); Object.assign(f.notifications, { configured: true, enabled: true });
  await launch({ setupOnly: true, requestId: 'notification-replay' }, f.deps);
  Object.assign(f.notifications, { enabled: false, running: false });
  const calls = f.notificationCalls.length;
  const replay = await launch({ setupOnly: true, requestId: 'notification-replay' }, f.deps);
  assert.equal(replay.outcome, 'already-handled');
  assert.equal(replay.notifications.state, 'not-checked');
  assert.equal(f.notificationCalls.length, calls);
  assert.equal(f.notifications.enabled, false);
});
