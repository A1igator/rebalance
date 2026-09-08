import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { connectionPath } from '../scripts/profile-routing.mjs';
import { PortfolioControls, type PortfolioControlDependencies, type RunnerRequest } from '../src/portfolio-control.js';
import { issueView } from '../src/view-session.js';
import { atomicWriteJson, readJson } from '../src/storage.js';

const walletA = `0x${'a'.repeat(40)}`, walletB = `0x${'b'.repeat(40)}`;
const session = 'claude:runner-control-fixture';
const configuration = (wallet: string, mode = 'private-key') => ({ version: 1, wallet, chainId: 4663, mode,
  rpcUrl: 'https://fixture.invalid', targets: { USDG: 500, AAPL: 2500, NVDA: 2500, MSFT: 2500, AMD: 2000 },
  driftThresholdBps: 500, slippageBps: 50, deadlineSeconds: 120, pollSeconds: 30, rebalanceIntervalSeconds: 3600 });
const digest = (value: unknown) => value === null ? 'none' : createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function until(condition: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 300; i++) { if (await condition()) return; await delay(5); }
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
    assert.deepEqual(args, ['stop']);
    await atomicWriteJson(join(root, 'stop.json'), { requestId: randomUUID() });
    return { ok: true, value: { status: 'stop-requested' } };
  };
  let execute = run;
  const deps: Partial<PortfolioControlDependencies> = { alive: pid => alive.has(pid),
    execute: async (profile, args) => { calls.push({ profile, args }); return execute(profile, args); } };
  const controls = new PortfolioControls(root, root, deps);
  return { root, other, token, calls, alive, controls, deps, run, outcome,
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
  assert.equal((await f.controls.read()).state, 'unavailable');
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

test('Ledger start is deferred without signer fallback, while its existing monitor can stop', async t => {
  const f = await fixture(t, 'ledger');
  assert.equal((await f.controls.read()).state, 'deferred');
  const started = await f.controls.command(f.request('start'));
  assert.equal(started.state, 'deferred'); assert.equal(started.outcome, 'deferred'); assert.equal(f.calls.length, 0);
  f.alive.add(424242); await atomicWriteJson(join(f.root, 'run.lock'), { pid: 424242 });
  await atomicWriteJson(join(f.root, 'status.json'), { wallet: walletA, armed: true });
  assert.equal((await f.controls.read()).state, 'running');
  assert.equal((await f.controls.command(f.request('stop'))).state, 'stopping');
  assert.deepEqual(f.calls.map(call => call.args), [['stop']]);
});

test('a stop can replace a damaged stop marker without reading keys or submitting a transaction', async t => {
  const f = await fixture(t); await writeFile(join(f.root, 'stop.json'), '{');
  assert.equal((await f.controls.read()).state, 'unavailable');
  assert.equal((await f.controls.command(f.request('stop'))).outcome, 'stop-requested');
  assert.deepEqual(f.calls.map(call => call.args), [['stop']]);
});
