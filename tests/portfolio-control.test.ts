import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { connectionPath } from '../scripts/profile-routing.mjs';
import { PortfolioControls, type PortfolioControlDependencies, type RunnerRequest } from '../src/portfolio-control.js';
import { LedgerExecution, requestLedgerRebalance, readLedgerRequest } from '../src/ledger-request.js';
import { validateConfig } from '../src/config.js';
import { issueView } from '../src/view-session.js';
import { atomicWriteJson, readJson } from '../src/storage.js';

const walletA = `0x${'a'.repeat(40)}`, walletB = `0x${'b'.repeat(40)}`;
const session = 'claude:runner-control-fixture';
const configuration = (wallet: string, mode = 'private-key') => ({ version: 1, wallet, chainId: 4663, mode,
  rpcUrl: 'https://fixture.invalid', targets: { USDG: 500, AAPL: 2500, NVDA: 2500, MSFT: 2500, AMD: 2000 },
  driftThresholdBps: 500, slippageBps: 50, deadlineSeconds: 120, pollSeconds: 30, rebalanceIntervalSeconds: 3600 });
const digest = (value: unknown) => value === null ? 'none' : createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function until(condition: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 2_000; i++) { if (await condition()) return; await delay(5); }
  assert.fail('Fixture did not settle');
}
async function fixture(t: TestContext, mode = 'private-key') {
  const root = await mkdtemp(join(tmpdir(), 'rebalance-runner-control-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const other = join(root, 'wallets', walletB);
  await atomicWriteJson(join(root, 'portfolios.json'), { version: 1, profiles: [
    { wallet: walletA, chainId: 4663, directory: '.', chartPort: 4663 },
    { wallet: walletB, chainId: 4663, directory: `wallets/${walletB}`, chartPort: 4664 },
  ] });
  await atomicWriteJson(join(root, 'config.json'), configuration(walletA, mode));
  await atomicWriteJson(join(other, 'config.json'), configuration(walletB));
  await atomicWriteJson(connectionPath(root, session), { version: 1, chainId: 4663, wallet: walletA });
  const { token } = await issueView(root, session);
  const calls: { profile: Parameters<PortfolioControlDependencies['execute']>[0]; args: readonly string[] }[] = [];
  const alive = new Set<number>();
  const setupOutcome = (outcome = 'already-enabled') => ({ app: 'Rebalance', operation: 'simple7702-setup', wallet: walletA, chainId: 4663, outcome });
  const outcome = (state: string) => ({ ok: state !== 'blocked', value: { app: 'Rebalance', outcome: state,
    status: { chain: { id: 4663 }, wallet: walletA } } });
  const run: PortfolioControlDependencies['execute'] = async (profile, args) => {
    assert.equal(profile.wallet, walletA); assert.equal(profile.dataDir, root); assert.equal(profile.rootDir, root); assert.equal(profile.chartPort, 4663);
    if (args[0] === 'launch') {
      assert.deepEqual(args.filter((_arg, index) => index % 2 === 1), ['--request-id', '--expected-stop']);
      if (args[4] !== digest(await readJson(join(root, 'stop.json')))) return outcome('blocked');
      await rm(join(root, 'stop.json'), { force: true });
      alive.add(424242);
      await atomicWriteJson(join(root, 'run.lock'), { pid: 424242 });
      await atomicWriteJson(join(root, 'status.json'), { wallet: walletA, armed: true });
      return outcome('armed');
    }
    if (args[0] === 'ledger') {
      assert.deepEqual(args, ['ledger', 'setup-simple7702', '--expected-stop', digest(await readJson(join(root, 'stop.json')))]);
      return { ok: true, value: setupOutcome() };
    }
    assert.deepEqual(args, ['stop']);
    await atomicWriteJson(join(root, 'stop.json'), { requestId: randomUUID() });
    return { ok: true, value: { status: 'stop-requested' } };
  };
  let execute = run;
  const deps: Partial<PortfolioControlDependencies> = { alive: pid => alive.has(pid),
    simple7702Status: async () => setupOutcome('needed'),
    caliburStatus: async () => ({ ...setupOutcome('needed'), operation: 'calibur-setup' }), wait: async (_milliseconds, signal) => { signal.throwIfAborted(); },
    selectedNotifications: async () => undefined,
    execute: async (profile, args) => { calls.push({ profile, args }); return execute(profile, args); } };
  const controls = new PortfolioControls(root, root, deps);
  return { root, other, token, calls, alive, controls, deps, run, outcome, setupOutcome,
    request: (action: RunnerRequest['action'], requestId = randomUUID()): RunnerRequest => ({ token, wallet: walletA, action, requestId }),
    setExecute: (value: typeof execute) => { execute = value; },
    connect: (wallet: string) => atomicWriteJson(connectionPath(root, session), { version: 1, chainId: 4663, wallet }),
  };
}

test('runner reads distinguish actual startup, arming, stopping and stopped without any command', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.controls.read(), { wallet: walletA, state: 'stopped' });
  f.alive.add(424242);
  await atomicWriteJson(join(f.root, 'run.lock'), { pid: 424242 });
  assert.equal((await f.controls.read()).state, 'starting');
  await atomicWriteJson(join(f.root, 'status.json'), { wallet: walletA, armed: true });
  assert.equal((await f.controls.read()).state, 'running');
  await atomicWriteJson(join(f.root, 'stop.json'), { requestedAt: 'fixture' });
  assert.equal((await f.controls.read()).state, 'stopping');
  f.alive.clear(); assert.equal((await f.controls.read()).state, 'stopped');
  assert.equal(f.calls.length, 0);
});

test('live launch ownership is starting, while corrupt ownership and history remain unavailable', async t => {
  const f = await fixture(t); f.alive.add(424242);
  await atomicWriteJson(join(f.root, 'launch.lock'), { pid: 424242 });
  assert.equal((await f.controls.read()).state, 'starting');
  await writeFile(join(f.root, 'launch.lock'), '{');
  const corrupt = await f.controls.read();
  assert.equal(corrupt.state, 'unavailable'); assert.equal(corrupt.canCancelStart, undefined);
  await rm(join(f.root, 'launch.lock'));
  await atomicWriteJson(join(f.root, 'runner-requests.json'), [{ invalid: true }]);
  assert.equal((await f.controls.read()).state, 'unavailable');
  assert.equal(f.calls.length, 0);
});

test('only the attached wallet on this exact chart can dispatch controls', async t => {
  const f = await fixture(t);
  for (const patch of [{ token: 'f'.repeat(64) }, { wallet: walletB }, { action: 'recover' }, { requestId: '../request' }]) {
    await assert.rejects(f.controls.command({ ...f.request('start'), ...patch } as RunnerRequest));
  }
  await f.connect(walletB);
  await assert.rejects(f.controls.command(f.request('start')), /Reconnect this chart/);
  await assert.rejects(f.controls.command({ ...f.request('start'), wallet: walletB }), /another wallet chart/);
  const otherChart = new PortfolioControls(f.root, f.other, f.deps);
  await f.connect(walletA);
  await assert.rejects(otherChart.command(f.request('start')), /another wallet chart/);
  assert.equal(f.calls.length, 0);
  assert.equal(await readJson(join(f.root, 'runner-requests.json')), null);
});

test('start and stop use pinned fixed CLI commands and retain all portfolio/recovery records', async t => {
  const f = await fixture(t);
  const paths = ['config.json','pending.json','cycle.json','recovery.json'];
  for (const directory of [f.root, f.other]) for (const name of paths.slice(1)) await atomicWriteJson(join(directory, name), { fixture: name });
  const before = await Promise.all([f.root, f.other].flatMap(directory => paths.map(name => readFile(join(directory, name), 'utf8'))));
  const olderStop = { requestId: 'previous-stop' };
  await atomicWriteJson(join(f.root, 'stop.json'), olderStop);
  const started = await f.controls.command(f.request('start'));
  assert.equal(started.state, 'running'); assert.equal(started.outcome, 'armed');
  assert.equal(f.calls[0]!.args[4], digest(olderStop)); assert.match(f.calls[0]!.args[2]!, /^chart:[a-f0-9]{64}$/);
  const stopped = await f.controls.command(f.request('stop'));
  assert.equal(stopped.state, 'stopping'); assert.equal(stopped.outcome, 'stop-requested');
  assert.match(stopped.message!, /already submitted can still settle/);
  assert.deepEqual(f.calls[1]!.args, ['stop']);
  assert.deepEqual(await Promise.all([f.root, f.other].flatMap(directory => paths.map(name => readFile(join(directory, name), 'utf8')))), before);
  assert.equal(await readJson(join(f.other, 'stop.json')), null);
});

test('replaying old start and stop requests cannot override newer controls, including after restart', async t => {
  const f = await fixture(t), start = f.request('start'), stop = f.request('stop');
  await f.controls.command(start); await f.controls.command(stop);
  const savedStop = await readFile(join(f.root, 'stop.json'), 'utf8');
  const restarted = new PortfolioControls(f.root, f.root, f.deps);
  assert.equal((await restarted.command(start)).outcome, 'already-handled');
  assert.equal(await readFile(join(f.root, 'stop.json'), 'utf8'), savedStop);
  f.alive.clear();
  await restarted.command(f.request('start'));
  assert.equal(await readJson(join(f.root, 'stop.json')), null);
  assert.equal((await restarted.command(stop)).outcome, 'already-handled');
  assert.equal(await readJson(join(f.root, 'stop.json')), null);
  assert.equal(f.calls.length, 3);
  await assert.rejects(restarted.command({ ...start, action: 'stop' }), /already belongs/);
});

test('same request coalesces, conflicting replay is rejected, and Stop wins during slow Start', async t => {
  const f = await fixture(t);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.setExecute(async (profile, args) => { if (args[0] === 'launch') await gate; return f.run(profile, args); });
  const request = f.request('start');
  const first = f.controls.command(request); await until(() => f.calls.length === 1);
  const repeated = f.controls.command(request);
  await assert.rejects(f.controls.command({ ...request, action: 'stop' }), /already belongs/);
  const second = await f.controls.command(f.request('start'));
  assert.equal(second.outcome, 'busy'); assert.equal(f.calls.length, 1);
  assert.equal((await f.controls.read()).state, 'starting');
  const stop = await f.controls.command(f.request('stop'));
  assert.equal(stop.outcome, 'stop-requested'); assert.equal(f.calls.length, 2);
  const marker = await readFile(join(f.root, 'stop.json'), 'utf8');
  release();
  const [a, b] = await Promise.all([first, repeated]);
  assert.equal(a.outcome, 'blocked'); assert.deepEqual(a, b);
  assert.equal(await readFile(join(f.root, 'stop.json'), 'utf8'), marker);
  assert.equal((await f.controls.read()).state, 'stopped');
});

test('a changed attachment during dispatch never changes the pinned command wallet', async t => {
  const f = await fixture(t);
  f.setExecute(async (profile, args) => { await f.connect(walletB); return f.run(profile, args); });
  assert.equal((await f.controls.command(f.request('start'))).wallet, walletA);
  assert.equal(f.calls[0]!.profile.dataDir, f.root);
  assert.equal((await readJson<{wallet:string}>(connectionPath(f.root, session)))!.wallet, walletB);
});

test('Start preflight distinguishes its older stop from a later stop and an unknown outcome', async t => {
  const f = await fixture(t); const older = { requestId: 'older-stop' };
  await atomicWriteJson(join(f.root, 'stop.json'), older);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.setExecute(async () => { await gate; throw new Error('fixture unknown start'); });
  const running = f.controls.command(f.request('start')); await until(() => f.calls.length === 1);
  assert.equal((await f.controls.read()).state, 'starting', 'the captured old stop is not a new Stop request');
  release();
  assert.equal((await running).state, 'unavailable', 'the old marker cannot prove that an unknown launch is stopped');
  const newer = { requestId: 'newer-cli-stop' };
  await atomicWriteJson(join(f.root, 'stop.json'), newer);
  assert.equal((await f.controls.read()).state, 'stopped');
  f.setExecute(f.run);
  assert.equal((await f.controls.command(f.request('start'))).state, 'running', 'a later CLI stop permits a distinct explicit Start');
  assert.equal(f.calls.length, 2);
});

test('unknown command outcome and durable prepared request never dispatch a replay', async t => {
  const f = await fixture(t), request = f.request('start');
  f.setExecute(async () => { throw new Error('private provider payload'); });
  const failed = await f.controls.command(request);
  assert.equal(failed.outcome, 'uncertain'); assert.equal(failed.state, 'unavailable');
  assert.equal(failed.canCancelStart, true);
  assert.doesNotMatch(JSON.stringify(failed), /private provider/);
  const saved = await readJson<Record<string, unknown>[]>(join(f.root, 'runner-requests.json'));
  saved![0]!.outcome = 'prepared';
  await atomicWriteJson(join(f.root, 'runner-requests.json'), saved);
  const restarted = new PortfolioControls(f.root, f.root, f.deps);
  assert.equal((await restarted.read()).state, 'unavailable');
  assert.equal((await restarted.command(request)).outcome, 'uncertain');
  assert.equal((await restarted.command(f.request('start'))).outcome, 'uncertain');
  assert.equal(f.calls.length, 1);
});

test('record-write failure cannot dispatch and an after-dispatch save failure retains the barrier', async t => {
  const f = await fixture(t); let writes = 0;
  const controls = new PortfolioControls(f.root, f.root, { ...f.deps, persist: async (path, value) => {
    if (++writes === 1) throw new Error('fixture write failure');
    await atomicWriteJson(path, value);
  } });
  const first = f.request('start'); await assert.rejects(controls.command(first));
  assert.equal(f.calls.length, 0);
  assert.equal((await controls.command(first)).state, 'running');
  const g = await fixture(t); writes = 0;
  const failing = new PortfolioControls(g.root, g.root, { ...g.deps, persist: async (path, value) => {
    if (++writes === 2) throw new Error('fixture result failure');
    await atomicWriteJson(path, value);
  } });
  const request = g.request('start'); await assert.rejects(failing.command(request));
  assert.equal(g.calls.length, 1);
  await new PortfolioControls(g.root, g.root, g.deps).command(request);
  assert.equal(g.calls.length, 1);
});

test('Ledger Start performs setup before monitoring while replay and Stop remain scoped', async t => {
  const f = await fixture(t, 'ledger');
  assert.equal((await f.controls.read()).state, 'stopped');
  f.alive.add(424242); await atomicWriteJson(join(f.root, 'run.lock'), { pid: 424242 });
  const starting = await f.controls.read();
  assert.equal(starting.state, 'starting'); assert.doesNotMatch(starting.message ?? '', /monitoring is active/);
  await rm(join(f.root, 'run.lock')); f.alive.clear();
  const start = f.request('start');
  const started = await f.controls.command(start);
  assert.equal(started.state, 'starting'); assert.equal(started.outcome, 'starting');
  assert.match(started.message!, /Checking existing wallet batching/);
  await until(async () => (await f.controls.read()).state === 'running');
  await until(async () => (await readJson<{outcome:string}[]>(join(f.root, 'runner-requests.json')))?.[0]?.outcome === 'armed');
  assert.equal(f.calls.length, 2); assert.equal(f.calls[0]!.args[0], 'ledger'); assert.equal(f.calls[1]!.args[0], 'launch');
  assert.match((await f.controls.read()).message!, /backend opens device prompts automatically; physical confirmation/);
  assert.equal((await f.controls.command(start)).outcome, 'already-handled');
  assert.equal(f.calls.length, 2);
  assert.equal((await f.controls.command(f.request('stop'))).state, 'stopping');
  f.alive.clear(); assert.equal((await f.controls.read()).state, 'stopped');
  assert.deepEqual(f.calls.map(call => call.args[0]), ['ledger', 'launch', 'stop']);
  assert.equal(await readJson(join(f.other, 'run.lock')), null);
});

test('a legacy deferred Ledger request stays handled while a new Start can begin monitoring', async t => {
  const f = await fixture(t, 'ledger');
  const request = f.request('start');
  await f.controls.command(request);
  await until(async () => (await readJson<{outcome:string}[]>(join(f.root, 'runner-requests.json')))?.[0]?.outcome === 'armed');
  const entries = await readJson<{ outcome: string }[]>(join(f.root, 'runner-requests.json'));
  entries![0]!.outcome = 'deferred';
  await atomicWriteJson(join(f.root, 'runner-requests.json'), entries);
  await rm(join(f.root, 'run.lock')); await rm(join(f.root, 'status.json')); f.alive.clear(); f.calls.length = 0;
  const restarted = new PortfolioControls(f.root, f.root, f.deps);
  const replay = await restarted.command(request);
  assert.equal(replay.outcome, 'already-handled'); assert.equal(replay.state, 'stopped');
  assert.match(replay.message!, /earlier Ledger Start request was deferred/);
  assert.equal(f.calls.length, 0);
  assert.equal((await restarted.command(f.request('start'))).state, 'starting');
  await until(async () => (await readJson<{outcome:string}[]>(join(f.root, 'runner-requests.json')))?.at(-1)?.outcome === 'armed');
  assert.equal(f.calls.length, 2); assert.equal(f.calls[0]!.args[0], 'ledger'); assert.equal(f.calls[1]!.args[0], 'launch');
  const saved = await readJson<{ outcome: string }[]>(join(f.root, 'runner-requests.json'));
  assert.deepEqual(saved!.map(entry => entry.outcome), ['deferred', 'armed']);
});

test('a stop can replace a damaged stop marker without reading keys or submitting a transaction', async t => {
  const f = await fixture(t); await writeFile(join(f.root, 'stop.json'), '{');
  assert.equal((await f.controls.read()).state, 'unavailable');
  assert.equal((await f.controls.command(f.request('stop'))).outcome, 'stop-requested');
  assert.deepEqual(f.calls.map(call => call.args), [['stop']]);
});


async function retryFixture(t: TestContext, outcome = 'cancelled') {
  const f = await fixture(t, 'ledger');
  f.alive.add(424242);
  const options = { dataDir: f.root, pid: 424242, isAlive: (pid: number) => f.alive.has(pid) };
  await atomicWriteJson(join(f.root, 'run.lock'), { pid: 424242, token: randomUUID() });
  await atomicWriteJson(join(f.root, 'status.json'), { wallet: walletA, armed: true });
  const request = await requestLedgerRebalance(randomUUID(), options);
  const execution = new LedgerExecution(options);
  await execution.prepare(validateConfig(await readJson(join(f.root, 'config.json')))); await execution.finish(outcome);
  return { ...f, options, request, input: () => ({ token: f.token, wallet: walletA, requestId: randomUUID(), retryOf: request.id }) };
}

test('Ledger Retry queues only the displayed running wallet, without launching or touching transaction state', async t => {
  const f = await retryFixture(t), input = f.input();
  await atomicWriteJson(join(f.root, 'cycle.json'), { fixture: 'existing cadence' });
  const beforeConfig = validateConfig(await readJson(join(f.root, 'config.json')));
  const before = await Promise.all(['cycle.json', 'run.lock'].map(file => readFile(join(f.root, file), 'utf8')));
  assert.deepEqual(await f.controls.retry(input), { wallet: walletA, requestId: input.requestId, retryOf: f.request.id, outcome: 'requested' });
  assert.equal((await readLedgerRequest(f.options))?.id, input.requestId);
  assert.equal((await readLedgerRequest(f.options))?.state, 'requested');
  assert.equal(f.calls.length, 0); assert.equal(await readJson(join(f.other, 'ledger-request.json')), null);
  assert.deepEqual(await readJson(join(f.root, 'config.json')), { ...beforeConfig, rebalanceRequestId: input.requestId });
  assert.deepEqual(await Promise.all(['cycle.json', 'run.lock'].map(file => readFile(join(f.root, file), 'utf8'))), before);
  await assert.rejects(f.controls.retry(input), /changed or cannot be retried/);
  await assert.rejects(f.controls.retry(f.input()), /changed or cannot be retried/);
  assert.equal((await readLedgerRequest(f.options))?.id, input.requestId, 'a second UUID from stale status cannot replace the accepted request');
});

test('Ledger Retry requires the same attached chart wallet, live runner and no pending send', async t => {
  for (const condition of ['detached', 'wrong-wallet', 'stopped', 'dead', 'pending']) {
    const f = await retryFixture(t), input = f.input();
    if (condition === 'detached') await f.connect(walletB);
    if (condition === 'wrong-wallet') { await f.connect(walletB); input.wallet = walletB; }
    if (condition === 'stopped') await atomicWriteJson(join(f.root, 'stop.json'), { requestId: randomUUID() });
    if (condition === 'dead') f.alive.clear();
    if (condition === 'pending') await atomicWriteJson(join(f.root, 'pending.json'), { fixture: 'unresolved send' });
    await assert.rejects(f.controls.retry(input), /selected wallet|another wallet|running|changed or cannot be retried/, condition);
    assert.equal((await readLedgerRequest(f.options))?.id, f.request.id); assert.equal(f.calls.length, 0);
    if (condition === 'pending') assert.deepEqual(await readJson(join(f.root, 'pending.json')), { fixture: 'unresolved send' });
  }
});

test('Ledger Retry rejects malformed input and non-Ledger profiles without changing their controls', async t => {
  const f = await retryFixture(t), input = f.input();
  for (const invalid of [{ ...input, retryOf: '../unsafe' }, { ...input, requestId: 'invalid' }, { ...input, action: 'start' }]) {
    await assert.rejects(f.controls.retry(invalid), /Invalid Ledger retry/);
  }
  const raw = await fixture(t);
  await assert.rejects(raw.controls.retry({ ...input, token: raw.token }), /requires this Ledger/);
  assert.equal(raw.calls.length, 0); assert.equal(f.calls.length, 0);
});


test('an unsupported outcome may retry fresh support checks after user action without changing the signing adapter', async t => {
  const f = await retryFixture(t, 'unsupported'), input = f.input();
  assert.equal((await f.controls.retry(input)).outcome, 'requested');
  assert.equal((await readLedgerRequest(f.options))?.id, input.requestId);
  assert.equal(f.calls.length, 0, 'the retry only queues intent, with no launch or signing here');
});


test('stopped Ledger Start durably claims once, preserves settings and waits for verified setup receipts', async t => {
  const f = await fixture(t, 'ledger');
  const oldStop = { requestId: 'older-stop' }; await atomicWriteJson(join(f.root, 'stop.json'), oldStop);
  const original = { ...configuration(walletA, 'ledger'), rebalanceFeeTargetUsdE8: '5000000' };
  await atomicWriteJson(join(f.root, 'config.json'), original);
  const cadence = { startedAt: 'unchanged-cadence' }; await atomicWriteJson(join(f.root, 'cycle.json'), cadence);
  let release!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  let statusReads = 0;
  const controls = new PortfolioControls(f.root, f.root, { ...f.deps, simple7702Status: async () => {
    statusReads++; return f.setupOutcome(statusReads === 1 ? 'needed' : statusReads < 3 ? 'pending' : 'confirmed');
  }, execute: async (profile, args, sessionId, options) => {
    f.calls.push({ profile, args });
    if (args[0] === 'ledger') {
      assert.equal(options?.timeoutMs, 270_000); assert.ok(options?.signal);
      const journal = await readJson<{outcome:string}[]>(join(f.root, 'runner-requests.json'));
      assert.equal(journal?.[0]?.outcome, 'prepared');
      assert.deepEqual(await readJson(join(f.root, 'config.json')), { ...original, execution: 'simple7702' });
      assert.equal(args[3], digest(oldStop)); await gate;
      return { ok: true, value: f.setupOutcome('pending') };
    }
    assert.equal(args[0], 'launch'); assert.ok(statusReads >= 3);
    assert.equal(args[4], digest(oldStop)); return f.run(profile, args, sessionId);
  } });
  const request = f.request('start');
  const response = await controls.command(request); assert.equal(response.state, 'starting');
  await until(() => f.calls.length === 1);
  assert.equal((await controls.command(request)).state, 'setting-up');
  assert.equal((await controls.command(f.request('start'))).outcome, 'busy');
  assert.equal(f.calls.length, 1); assert.deepEqual(await readJson(join(f.root, 'stop.json')), oldStop);
  release();
  await until(async () => (await readJson<{outcome:string}[]>(join(f.root, 'runner-requests.json')))?.[0]?.outcome === 'armed');
  assert.equal((await controls.read()).state, 'running'); assert.equal(f.calls.length, 2);
  assert.deepEqual(await readJson(join(f.root, 'cycle.json')), cadence);
  assert.equal(await readJson(join(f.other, 'run.lock')), null);
});

test('Stop cancels a pending Ledger setup without waiting and prevents any later launch', async t => {
  const f = await fixture(t, 'ledger'); let signal: AbortSignal | undefined;
  const controls = new PortfolioControls(f.root, f.root, { ...f.deps, execute: async (profile, args, _sessionId, options) => {
    f.calls.push({ profile, args });
    if (args[0] === 'ledger') {
      signal = options?.signal;
      return new Promise((_done, fail) => signal!.addEventListener('abort', () => fail(signal!.reason), { once: true }));
    }
    return f.run(profile, args);
  } });
  const request = f.request('start'); assert.equal((await controls.command(request)).state, 'starting');
  await until(() => Boolean(signal));
  assert.equal((await controls.command(f.request('stop'))).outcome, 'stop-requested');
  assert.equal(signal!.aborted, true);
  await until(async () => (await readJson<{outcome:string}[]>(join(f.root, 'runner-requests.json')))?.[0]?.outcome !== 'prepared');
  assert.equal((await controls.read()).state, 'stopped');
  assert.deepEqual(f.calls.map(call => call.args[0]), ['ledger', 'stop']);
  const marker = await readJson(join(f.root, 'stop.json'));
  await controls.command(request);
  assert.deepEqual(await readJson(join(f.root, 'stop.json')), marker);
  assert.equal(f.calls.length, 2);
});

test('unknown Ledger setup result is never signed again by replay or a fresh Start', async t => {
  const f = await fixture(t, 'ledger');
  f.setExecute(async () => { throw new Error('unknown delivery'); });
  const request = f.request('start'); await f.controls.command(request);
  await until(async () => (await readJson<{outcome:string}[]>(join(f.root, 'runner-requests.json')))?.[0]?.outcome === 'uncertain');
  assert.equal((await f.controls.read()).state, 'unavailable');
  const restarted = new PortfolioControls(f.root, f.root, f.deps);
  await restarted.command(request); await restarted.command(f.request('start'));
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0]!.args[0], 'ledger');
});

test('foreign or unverified setup results cannot launch and pending state blocks execution opt-in', async t => {
  for (const failure of ['wrong-wallet', 'unknown', 'pending-record']) {
    const f = await fixture(t, 'ledger');
    const before = await readFile(join(f.root, 'config.json'), 'utf8');
    if (failure === 'pending-record') await atomicWriteJson(join(f.root, 'pending.json'), { retained: true });
    f.setExecute(async () => ({ ok: true, value: { ...f.setupOutcome(failure === 'unknown' ? 'unknown' : 'confirmed'),
      ...(failure === 'wrong-wallet' ? { wallet: walletB } : {}) } }));
    await f.controls.command(f.request('start'));
    await until(async () => (await readJson<{outcome:string}[]>(join(f.root, 'runner-requests.json')))?.[0]?.outcome === 'uncertain');
    assert.equal(f.calls.filter(call => call.args[0] === 'launch').length, 0);
    if (failure === 'pending-record') {
      assert.equal(f.calls.length, 0); assert.equal(await readFile(join(f.root, 'config.json'), 'utf8'), before);
      assert.deepEqual(await readJson(join(f.root, 'pending.json')), { retained: true });
    }
  }
});

test('already running Ledger Start preserves direct execution and never installs Simple7702', async t => {
  const f = await fixture(t, 'ledger'); f.alive.add(424242);
  await atomicWriteJson(join(f.root, 'run.lock'), { pid: 424242 });
  await atomicWriteJson(join(f.root, 'launch-processes.json'), { runner: 424242 });
  await atomicWriteJson(join(f.root, 'status.json'), { wallet: walletA, armed: true });
  const before = await readFile(join(f.root, 'config.json'), 'utf8');
  assert.equal((await f.controls.command(f.request('start'))).state, 'running');
  assert.deepEqual(f.calls.map(call => call.args[0]), ['launch']);
  assert.equal(await readFile(join(f.root, 'config.json'), 'utf8'), before);
});

test('Simple7702 public status reads coalesce and expose device stages without dispatching setup', async t => {
  const f = await fixture(t, 'ledger'); let reads = 0, release!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  const controls = new PortfolioControls(f.root, f.root, { ...f.deps, simple7702Status: async () => {
    reads++; await gate; return f.setupOutcome('needed');
  } });
  await controls.read(); await controls.read(); await controls.read();
  assert.equal(reads, 1); assert.equal(f.calls.length, 0); release();
  await until(async () => (await controls.read()).calibur?.state === 'needed');
  await controls.read(); assert.equal(reads, 1);
});


test('typed pre-broadcast Ledger rejection stays actionable and permits only a new explicit Start', async t => {
  const f = await fixture(t, 'ledger');
  f.setExecute(async () => ({ ok: true, value: { ...f.setupOutcome('blocked'), blockedReason: 'rejected' } }));
  const first = f.request('start'); await f.controls.command(first);
  await until(async () => (await readJson<{outcome:string}[]>(join(f.root, 'runner-requests.json')))?.[0]?.outcome === 'blocked');
  const state = await f.controls.read(); assert.equal(state.state, 'stopped');
  assert.match(state.message!, /cancelled on the Ledger/); assert.match(state.calibur!.message!, /Press Start/);
  const restarted = new PortfolioControls(f.root, f.root, f.deps);
  assert.match((await restarted.read()).message!, /cancelled on the Ledger/);
  await restarted.command(first); assert.equal(f.calls.length, 1);
  f.setExecute(f.run); await restarted.command(f.request('start'));
  await until(async () => (await readJson<{outcome:string}[]>(join(f.root, 'runner-requests.json')))?.at(-1)?.outcome === 'armed');
  assert.deepEqual(f.calls.map(call => call.args[0]), ['ledger', 'ledger', 'launch']);
});

test('a fresh Start after an uncertain setup send can only reconcile its retained receipt', async t => {
  const f = await fixture(t, 'ledger');
  f.setExecute(async () => {
    await atomicWriteJson(join(f.root, 'pending.json'), { kind: 'simple7702-setup', wallet: walletA, chainId: 4663, hash: `0x${'1'.repeat(64)}`, nonce: 0, status: 'unknown' });
    return { ok: true, value: f.setupOutcome('unresolved') };
  });
  const first = f.request('start'); await f.controls.command(first);
  await until(async () => (await readJson<{outcome:string}[]>(join(f.root, 'runner-requests.json')))?.[0]?.outcome === 'uncertain');
  const uncertain = await f.controls.read();
  assert.equal(uncertain.state, 'stopped'); assert.equal(uncertain.calibur?.state, 'confirming');
  assert.equal(uncertain.canCancelStart, undefined);
  assert.match(uncertain.message!, /Start checks its receipt/);
  assert.notEqual(await readJson(join(f.root, 'pending.json')), null);
  let reads = 0;
  const restarted = new PortfolioControls(f.root, f.root, { ...f.deps, simple7702Status: async () => {
    reads++; await rm(join(f.root, 'pending.json'), { force: true }); return f.setupOutcome('confirmed');
  } });
  f.setExecute(f.run); await restarted.command(first); assert.equal(f.calls.length, 1);
  await restarted.command(f.request('start'));
  await until(async () => (await readJson<{outcome:string}[]>(join(f.root, 'runner-requests.json')))?.at(-1)?.outcome === 'armed');
  assert.ok(reads >= 1); assert.deepEqual(f.calls.map(call => call.args[0]), ['ledger', 'launch']);
});

test('a later CLI Stop during receipt confirmation prevents runner launch without another setup call', async t => {
  const f = await fixture(t, 'ledger');
  f.setExecute(async () => ({ ok: true, value: f.setupOutcome('pending') }));
  const marker = { requestId: 'new-cli-stop' };
  const controls = new PortfolioControls(f.root, f.root, { ...f.deps, wait: async () => {
    await atomicWriteJson(join(f.root, 'stop.json'), marker);
  } });
  await controls.command(f.request('start'));
  await until(async () => (await readJson<{outcome:string}[]>(join(f.root, 'runner-requests.json')))?.[0]?.outcome === 'blocked');
  assert.deepEqual(f.calls.map(call => call.args[0]), ['ledger']);
  assert.deepEqual(await readJson(join(f.root, 'stop.json')), marker);
});


test('a public-status or unrelated run-lock owner cannot bypass Simple7702 setup and launch direct', async t => {
  const f = await fixture(t, 'ledger'); f.alive.add(424242);
  await atomicWriteJson(join(f.root, 'run.lock'), { pid: 424242 });
  await atomicWriteJson(join(f.root, 'status.json'), { wallet: walletA, armed: true });
  await atomicWriteJson(join(f.root, 'launch-processes.json'), { runner: 999999 });
  const before = await readFile(join(f.root, 'config.json'), 'utf8');
  const result = await f.controls.command(f.request('start'));
  assert.equal(result.outcome, 'busy'); assert.equal(f.calls.length, 0);
  assert.equal(await readFile(join(f.root, 'config.json'), 'utf8'), before);
});


test('an undelegated failed Calibur opt-in migrates to Simple7702 only on the new explicit Start', async t => {
  const f = await fixture(t, 'ledger');
  await atomicWriteJson(join(f.root, 'config.json'), { ...configuration(walletA, 'ledger'), execution: 'calibur' });
  await f.controls.read(); assert.equal((await readJson<{execution:string}>(join(f.root, 'config.json')))!.execution, 'calibur');
  await f.controls.command(f.request('start'));
  await until(async () => (await readJson<{outcome:string}[]>(join(f.root, 'runner-requests.json')))?.[0]?.outcome === 'armed');
  assert.equal((await readJson<{execution:string}>(join(f.root, 'config.json')))!.execution, 'simple7702');
  assert.equal(f.calls[0]!.args[1], 'setup-simple7702');
});

test('fresh existing Calibur delegation preserves its configured execution without another setup command', async t => {
  const f = await fixture(t, 'ledger');
  await atomicWriteJson(join(f.root, 'config.json'), { ...configuration(walletA, 'ledger'), execution: 'calibur' });
  const legacy = { ...f.setupOutcome('already-enabled'), operation: 'calibur-setup' };
  const controls = new PortfolioControls(f.root, f.root, { ...f.deps,
    simple7702Status: async () => ({ ...f.setupOutcome('blocked'), blockedReason: 'existing-calibur' }),
    caliburStatus: async () => legacy,
    execute: async (profile, args) => { f.calls.push({profile,args});
      return args[0] === 'ledger' ? {ok:true,value:legacy} : f.run(profile,args);
    },
  });
  await controls.command(f.request('start'));
  await until(async () => (await readJson<{outcome:string}[]>(join(f.root, 'runner-requests.json')))?.[0]?.outcome === 'armed');
  assert.equal((await readJson<{execution:string}>(join(f.root, 'config.json')))!.execution, 'calibur');
  assert.deepEqual(f.calls.map(call => call.args[0]), ['launch']);
});

test('a retained Calibur setup receipt is never reinterpreted or migrated by Simple7702 Start', async t => {
  const f = await fixture(t, 'ledger');
  await atomicWriteJson(join(f.root, 'config.json'), { ...configuration(walletA, 'ledger'), execution: 'calibur' });
  const pending = { kind:'calibur-setup',wallet:walletA,chainId:4663,hash:`0x${'2'.repeat(64)}`,nonce:0,status:'unknown' };
  await atomicWriteJson(join(f.root, 'pending.json'),pending);
  let simpleReads=0, legacyReads=0;
  const controls = new PortfolioControls(f.root,f.root,{...f.deps,
    simple7702Status:async()=>{simpleReads++;return f.setupOutcome('needed');},
    caliburStatus:async()=>{legacyReads++;return {...f.setupOutcome('unresolved'),operation:'calibur-setup'};},
  });
  await controls.command(f.request('start'));
  await until(async()=> (await readJson<{outcome:string}[]>(join(f.root,'runner-requests.json')))?.[0]?.outcome==='uncertain');
  assert.equal(simpleReads,0); assert.equal(legacyReads,1); assert.equal(f.calls.length,0);
  assert.equal((await readJson<{execution:string}>(join(f.root,'config.json')))!.execution,'calibur');
  assert.deepEqual(await readJson(join(f.root,'pending.json')),pending);
});

test('missing Simple7702 deployment blocks before setup or device prompts and reports the required action', async t => {
  const f=await fixture(t,'ledger');
  const controls=new PortfolioControls(f.root,f.root,{...f.deps,
    simple7702Status:async()=>({...f.setupOutcome('blocked'),blockedReason:'deployment-needed'}),
  });
  const first=f.request('start');await controls.command(first);
  await until(async()=> (await readJson<{outcome:string}[]>(join(f.root,'runner-requests.json')))?.[0]?.outcome==='blocked');
  const current=await controls.read();assert.equal(current.state,'stopped');
  assert.match(current.message!,/one-time contract deployment/);assert.equal(current.calibur?.implementation,'simple7702');
  await controls.command(first);assert.equal(f.calls.length,0);
  assert.equal((await readJson<{execution?:string}>(join(f.root,'config.json')))!.execution,undefined);
});

test('a configured delegated Ledger wallet checks fresh readiness then launches without another setup command', async t => {
  const f = await fixture(t, 'ledger');
  const config = { ...configuration(walletA, 'ledger'), execution: 'simple7702', rebalanceFeeTargetUsdE8: '5000000' };
  const oldStop = { requestId: 'older-stop' }, cycle = { startedAt: 'unchanged-cadence' };
  await atomicWriteJson(join(f.root, 'config.json'), config);
  await atomicWriteJson(join(f.root, 'stop.json'), oldStop);
  await atomicWriteJson(join(f.root, 'cycle.json'), cycle);
  let release!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  const controls = new PortfolioControls(f.root, f.root, { ...f.deps, simple7702Status: async () => {
    await gate; return f.setupOutcome('already-enabled');
  } });
  const request = f.request('start'), accepted = await controls.command(request);
  assert.equal(accepted.state, 'starting'); assert.match(accepted.message!, /Checking existing wallet batching/);
  assert.equal(accepted.calibur, undefined);
  const checking = await controls.read();
  assert.equal(checking.state, 'starting'); assert.equal(checking.calibur, undefined);
  assert.equal((await controls.command(request)).state, 'starting');
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await readJson(join(f.root, 'stop.json')), oldStop);
  release();
  await until(async () => (await readJson<{outcome:string}[]>(join(f.root, 'runner-requests.json')))?.[0]?.outcome === 'armed');
  assert.deepEqual(f.calls.map(call => call.args[0]), ['launch']);
  assert.equal(f.calls[0]!.args[4], digest(oldStop));
  assert.equal((await controls.read()).state, 'running');
  assert.deepEqual(await readJson(join(f.root, 'config.json')), config);
  assert.deepEqual(await readJson(join(f.root, 'cycle.json')), cycle);
  assert.equal(await readJson(join(f.root, 'pending.json')), null);
});

test('failed public batching checks remain retryable without replaying their request or exposing provider errors', async t => {
  const f = await fixture(t, 'ledger');
  const config = { ...configuration(walletA, 'ledger'), execution: 'simple7702' }, stop = { requestId: 'older-stop' };
  await atomicWriteJson(join(f.root, 'config.json'), config); await atomicWriteJson(join(f.root, 'stop.json'), stop);
  const controls = new PortfolioControls(f.root, f.root, { ...f.deps, simple7702Status: async () => {
    throw new Error('private RPC endpoint payload');
  } });
  const request = f.request('start'); assert.equal((await controls.command(request)).state, 'starting');
  await until(async () => (await readJson<{outcome:string}[]>(join(f.root, 'runner-requests.json')))?.[0]?.outcome === 'blocked');
  const entries = await readJson<{outcome:string;setupBlocked?:string}[]>(join(f.root, 'runner-requests.json'));
  assert.equal(entries![0]!.setupBlocked, 'setup-check-unavailable');
  const blocked = await controls.read();
  assert.equal(blocked.state, 'stopped'); assert.equal(blocked.canCancelStart, undefined);
  assert.match(blocked.message!, /Check the network, then press Start/);
  assert.match(blocked.message!, /No setup or runner launch was dispatched/);
  assert.doesNotMatch(JSON.stringify(blocked), /private RPC/);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await readJson(join(f.root, 'config.json')), config);
  assert.deepEqual(await readJson(join(f.root, 'stop.json')), stop);
  const restarted = new PortfolioControls(f.root, f.root, { ...f.deps, simple7702Status: async () => f.setupOutcome('already-enabled') });
  assert.equal((await restarted.command(request)).outcome, 'already-handled'); assert.equal(f.calls.length, 0);
  await restarted.command(f.request('start'));
  await until(async () => (await readJson<{outcome:string}[]>(join(f.root, 'runner-requests.json')))?.at(-1)?.outcome === 'armed');
  assert.deepEqual(f.calls.map(call => call.args[0]), ['launch']);
});

test('the ready shortcut preserves intervening Stop, configuration and pending-transaction barriers', async t => {
  for (const change of ['stop', 'configuration', 'pending']) {
    const f = await fixture(t, 'ledger');
    const config = { ...configuration(walletA, 'ledger'), execution: 'simple7702' };
    await atomicWriteJson(join(f.root, 'config.json'), config);
    const pending = { kind: 'simple7702-setup', wallet: walletA, chainId: 4663, hash: `0x${'1'.repeat(64)}`, nonce: 0, status: 'unknown' };
    const stop = { requestId: 'newer-stop' };
    const controls = new PortfolioControls(f.root, f.root, { ...f.deps, simple7702Status: async () => {
      if (change === 'stop') await atomicWriteJson(join(f.root, 'stop.json'), stop);
      if (change === 'configuration') await atomicWriteJson(join(f.root, 'config.json'), { ...config, driftThresholdBps: 600 });
      if (change === 'pending') await atomicWriteJson(join(f.root, 'pending.json'), pending);
      return f.setupOutcome('already-enabled');
    } });
    await controls.command(f.request('start'));
    await until(async () => (await readJson<{outcome:string}[]>(join(f.root, 'runner-requests.json')))?.[0]?.outcome === 'blocked');
    assert.equal(f.calls.length, 0, change);
    assert.deepEqual(await readJson(join(f.root, 'config.json')), change === 'configuration' ? { ...config, driftThresholdBps: 600 } : config);
    assert.deepEqual(await readJson(join(f.root, 'stop.json')), change === 'stop' ? stop : null);
    assert.deepEqual(await readJson(join(f.root, 'pending.json')), change === 'pending' ? pending : null);
  }
});

test('an unverified public batching result blocks before dispatch and permits a new explicit check', async t => {
  const f = await fixture(t, 'ledger');
  await atomicWriteJson(join(f.root, 'config.json'), { ...configuration(walletA, 'ledger'), execution: 'simple7702' });
  let ready = false;
  const controls = new PortfolioControls(f.root, f.root, { ...f.deps,
    simple7702Status: async () => f.setupOutcome(ready ? 'already-enabled' : 'unknown'),
  });
  const first = f.request('start'); await controls.command(first);
  await until(async () => (await readJson<{outcome:string}[]>(join(f.root, 'runner-requests.json')))?.[0]?.outcome === 'blocked');
  const entries = await readJson<{setupBlocked?:string}[]>(join(f.root, 'runner-requests.json'));
  assert.equal(entries![0]!.setupBlocked, 'setup-check-unavailable');
  assert.equal((await controls.read()).state, 'stopped'); assert.equal(f.calls.length, 0);
  ready = true;
  assert.equal((await controls.command(first)).outcome, 'already-handled'); assert.equal(f.calls.length, 0);
  await controls.command(f.request('start'));
  await until(async () => (await readJson<{outcome:string}[]>(join(f.root, 'runner-requests.json')))?.at(-1)?.outcome === 'armed');
  assert.deepEqual(f.calls.map(call => call.args[0]), ['launch']);
});

test('runner or configuration ownership during the public setup check is busy before any dispatch', async t => {
  for (const lock of ['run.lock', 'config.lock']) {
    const f = await fixture(t, 'ledger');
    const owner = { pid: process.pid, createdAt: new Date().toISOString(), token: randomUUID() };
    const controls = new PortfolioControls(f.root, f.root, { ...f.deps, simple7702Status: async () => {
      await atomicWriteJson(join(f.root, lock), owner);
      return f.setupOutcome('needed');
    } });
    await controls.command(f.request('start'));
    await until(async () => (await readJson<{outcome:string}[]>(join(f.root, 'runner-requests.json')))?.[0]?.outcome === 'busy');
    assert.equal(f.calls.length, 0, lock);
    assert.deepEqual(await readJson(join(f.root, lock)), owner);
    assert.equal((await readJson<{execution?:string}>(join(f.root, 'config.json')))!.execution, undefined);
    if (lock === 'config.lock') assert.equal(await readJson(join(f.root, 'run.lock')), null, 'timed-out configuration wait releases its runner lock');
  }
});

test('an unresolved dispatched Start exposes only explicit cancellation and preserves its journal on replay', async t => {
  const f = await fixture(t, 'ledger');
  f.setExecute(async () => { throw new Error('unknown setup delivery'); });
  const first = f.request('start'); await f.controls.command(first);
  await until(async () => (await readJson<{outcome:string}[]>(join(f.root, 'runner-requests.json')))?.[0]?.outcome === 'uncertain');
  const journal = await readFile(join(f.root, 'runner-requests.json'), 'utf8');
  const restarted = new PortfolioControls(f.root, f.root, { ...f.deps, simple7702Status: async () => f.setupOutcome('already-enabled') });
  const unknown = await restarted.read();
  assert.equal(unknown.state, 'unavailable'); assert.equal(unknown.canCancelStart, true);
  assert.match(unknown.message!, /Cancel that request before trying Start again/);
  assert.equal((await restarted.command(first)).outcome, 'already-handled');
  assert.equal(await readFile(join(f.root, 'runner-requests.json'), 'utf8'), journal);
  assert.equal(f.calls.length, 1);
  f.setExecute(f.run);
  const cancelled = await restarted.command(f.request('stop'));
  assert.equal(cancelled.outcome, 'stop-requested'); assert.equal(cancelled.state, 'stopped');
  assert.equal(cancelled.canCancelStart, undefined);
  const entries = await readJson<{outcome:string}[]>(join(f.root, 'runner-requests.json'));
  assert.deepEqual(entries!.map(entry => entry.outcome), ['uncertain', 'stop-requested']);
  assert.deepEqual(f.calls.map(call => call.args[0]), ['ledger', 'stop']);
  const marker = await readFile(join(f.root, 'stop.json'), 'utf8');
  await restarted.command(first); assert.equal(await readFile(join(f.root, 'stop.json'), 'utf8'), marker);
  assert.equal(f.calls.length, 2);
});

test('an unknown Stop does not expose the unresolved-Start cancellation affordance', async t => {
  const f = await fixture(t);
  f.setExecute(async () => { throw new Error('unknown stop delivery'); });
  const result = await f.controls.command(f.request('stop'));
  assert.equal(result.state, 'unavailable'); assert.equal(result.canCancelStart, undefined);
});
