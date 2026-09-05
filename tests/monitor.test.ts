import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { driveMonitor, type MonitorInput } from '../src/monitor.js';
import type { Config } from '../src/config.js';
import type { Status } from '../src/runtime.js';
import type { WakeReason } from '../src/wake.js';

const epoch = Date.parse('2026-09-05T23:00:00Z');
const configuration = (cash = 500, pollSeconds = 30): Config => ({
  version: 1, chainId: 4663, wallet: '0x0000000000000000000000000000000000000001',
  mode: 'private-key', rpcUrl: 'http://127.0.0.1:1', pollSeconds, rebalanceIntervalSeconds: 3600,
  driftThresholdBps: 500, slippageBps: 50, deadlineSeconds: 120,
  targets: { USDG: cash, AAPL: 4000 - cash, NVDA: 2000, MSFT: 2000, AMD: 2000 },
});
const flush = async () => { for (let n = 0; n < 30; n++) await Promise.resolve(); };
async function harness(t: TestContext, pending = false) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: epoch });
  const abort = new AbortController();
  let wake: (reason: WakeReason) => void = () => {};
  let calls = 0, reads = 0, closed = false, concurrent = 0, peak = 0;
  const config = configuration();
  let input: MonitorInput = { config, cycle: null, stopped: false,
    pending: pending ? { createdAt: new Date(epoch).toISOString() } as MonitorInput['pending'] : null };
  let result = { error: null, operation: { status: pending ? 'pending' : 'balanced' }, cycle: null } as Status;
  let block: Promise<void> | undefined;
  const done = driveMonitor({ dataDir: '/fixture', signal: abort.signal,
    read: async () => { reads++; return input; },
    run: async () => { calls++; peak = Math.max(peak, ++concurrent); await block; concurrent--; return result; },
    source: options => { wake = options.onWake; return { close: () => { closed = true; }, state: () => ({ feed: 'connected', files: 'watching', lastActivityAt: null }) }; },
  });
  t.after(async () => { abort.abort(); await done; });
  await flush();
  return {
    get calls() { return calls; }, get reads() { return reads; }, get peak() { return peak; }, get closed() { return closed; },
    wake: (reason: WakeReason) => wake(reason),
    change: (patch: Partial<MonitorInput>) => { input = { ...input, ...patch }; },
    result: (patch: Partial<Status>) => { result = { ...result, ...patch }; },
    block: (promise?: Promise<void>) => { block = promise; },
    advance: async (ms: number) => { t.mock.timers.tick(ms); await flush(); },
    stop: async () => { abort.abort(); await done; },
  };
}

test('chain activity promptly checks pending receipts, coalesces bursts and never overlaps runs', async t => {
  const h = await harness(t, true);
  assert.equal(h.calls, 1);
  for (let n = 0; n < 1000; n++) h.wake('chain');
  await h.advance(999); assert.equal(h.calls, 1);
  let release!: () => void;
  h.block(new Promise<void>(resolve => { release = resolve; }));
  await h.advance(1); assert.equal(h.calls, 2);
  for (let n = 0; n < 1000; n++) h.wake('chain');
  await h.advance(10_000); assert.equal(h.calls, 2);
  release(); h.block(); await flush();
  await h.advance(999); assert.equal(h.calls, 2);
  await h.advance(1); assert.equal(h.calls, 3);
  assert.equal(h.peak, 1);
});

test('receipt watchdog progresses without feed and stop aborts the wait promptly', async t => {
  const h = await harness(t, true);
  await h.advance(2999); assert.equal(h.calls, 1);
  await h.advance(1); assert.equal(h.calls, 2);
  h.change({ stopped: true }); h.wake('stop');
  await h.advance(0); assert.equal(h.calls, 2);
  assert.equal(h.closed, true);
});

test('recovery deadline wakes exactly at thirty seconds even before receipt watchdog', async t => {
  const h = await harness(t, true);
  h.change({ pending: { createdAt: new Date(epoch - 28_500).toISOString() } as MonitorInput['pending'] });
  h.wake('chain'); await h.advance(1000);
  assert.equal(h.calls, 2);
  await h.advance(499); assert.equal(h.calls, 2);
  await h.advance(1); assert.equal(h.calls, 3);
  await h.advance(0); assert.equal(h.calls, 3, 'past grace must not cause a busy loop');
});

test('cooldown ignores feed bursts and local watchdogs until the exact eligibility deadline', async t => {
  const h = await harness(t);
  const cycle = { startedAt: new Date(epoch - 3_500_000).toISOString(), activeUntil: new Date(epoch - 2_900_000).toISOString(), nextEligibleAt: new Date(epoch + 60_000).toISOString() };
  h.change({ cycle }); h.result({ cycle, operation: { status: 'cooling-down' } });
  h.wake('cycle'); await h.advance(0); assert.equal(h.calls, 2);
  for (let n = 0; n < 100; n++) h.wake('chain');
  await h.advance(59_999); assert.equal(h.calls, 2);
  assert.ok(h.reads > 4, 'fallback still inspects local controls');
  await h.advance(1); assert.equal(h.calls, 3);
});

test('configuration changes during a graph run are retained and own-cycle notifications do not loop', async t => {
  const h = await harness(t, true);
  let release!: () => void;
  h.block(new Promise<void>(resolve => { release = resolve; }));
  h.wake('chain'); await h.advance(1000); assert.equal(h.calls, 2);
  const cycle = { startedAt: new Date(epoch).toISOString(), activeUntil: new Date(epoch + 600_000).toISOString(), nextEligibleAt: new Date(epoch + 600_000).toISOString() };
  h.change({ config: configuration(1000, 10), cycle });
  h.result({ cycle }); h.wake('config'); h.wake('cycle');
  release(); h.block(); await flush(); await h.advance(0);
  assert.equal(h.calls, 3, 'new config gets its own traversal');
  h.wake('cycle'); await h.advance(0); assert.equal(h.calls, 3, 'self-published cycle is already reflected');
});

test('missed filesystem events fall back to local control checks', async t => {
  const h = await harness(t);
  h.change({ config: configuration(1000) });
  await h.advance(4999); assert.equal(h.calls, 1);
  await h.advance(1); assert.equal(h.calls, 2);
  h.change({ stopped: true }); await h.advance(5000);
  assert.equal(h.calls, 2); assert.equal(h.closed, true);
});

test('market events are coalesced while ordinary quiet-feed polling remains a fallback', async t => {
  const h = await harness(t);
  for (let n = 0; n < 100; n++) h.wake('chain');
  await h.advance(4999); assert.equal(h.calls, 1);
  await h.advance(1); assert.equal(h.calls, 2);
  await h.advance(29_999); assert.equal(h.calls, 2);
  await h.advance(1); assert.equal(h.calls, 3);
});

test('network errors back off despite feed activity and still accept a configuration change', async t => {
  const h = await harness(t);
  h.result({ error: 'RPC unavailable' }); h.wake('chain');
  await h.advance(5000); assert.equal(h.calls, 2);
  h.wake('chain'); await h.advance(1999); assert.equal(h.calls, 2);
  await h.advance(1); assert.equal(h.calls, 3);
  h.wake('chain'); await h.advance(3999); assert.equal(h.calls, 3);
  h.change({ config: configuration(1500) });
  h.wake('config'); await h.advance(0); assert.equal(h.calls, 4);
  assert.equal(h.peak, 1);
});

test('stopped, unconfigured and aborted monitors never open a feed', async () => {
  for (const scenario of ['stopped', 'unconfigured', 'aborted']) {
    const abort = new AbortController();
    if (scenario === 'aborted') abort.abort();
    let sources = 0, runs = 0;
    await driveMonitor({ dataDir: '/fixture', signal: abort.signal,
      read: async () => ({ config: scenario === 'unconfigured' ? null : configuration(), stopped: scenario === 'stopped', cycle: null, pending: null }),
      run: async () => { runs++; throw new Error('must not execute'); },
      source: () => { sources++; throw new Error('must not connect'); },
    });
    assert.equal(runs, 0); assert.equal(sources, 0);
  }
});

test('persisted receipt cadence followed by an observation error cannot bypass increasing error backoff', async t => {
  const h = await harness(t);
  h.result({ error: 'RPC unavailable', cycle: null });
  h.change({ cycle: { startedAt: new Date(epoch).toISOString(), activeUntil: new Date(epoch + 600_000).toISOString(), nextEligibleAt: new Date(epoch + 3_600_000).toISOString() } });
  h.wake('cycle'); await h.advance(0); assert.equal(h.calls, 2);
  await h.advance(2000); assert.equal(h.calls, 3);
  await h.advance(4000); assert.equal(h.calls, 4);
  await h.advance(5000); assert.equal(h.calls, 4, 'control watchdog does not confuse persisted success with a new external change');
  await h.advance(3000); assert.equal(h.calls, 5);
  await h.advance(5000); assert.equal(h.calls, 5);
});

test('a stop arriving during a traversal prevents all subsequent traversals', async t => {
  const h = await harness(t, true);
  let release!: () => void;
  h.block(new Promise<void>(resolve => { release = resolve; }));
  h.wake('chain'); await h.advance(1000);
  h.change({ stopped: true }); h.wake('stop');
  for (let n = 0; n < 100; n++) h.wake('chain');
  release(); await flush(); await h.advance(30_000);
  assert.equal(h.calls, 2); assert.equal(h.closed, true);
});
