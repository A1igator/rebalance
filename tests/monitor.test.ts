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
  let calls = 0, reads = 0, closed = false, concurrent = 0, peak = 0, sources = 0;
  const started: MonitorInput[] = [];
  const config = configuration();
  let input: MonitorInput = { config, cycle: null, stopped: false,
    pending: pending ? { createdAt: new Date(epoch).toISOString() } as MonitorInput['pending'] : null };
  let result = { error: null, operation: { status: pending ? 'pending' : 'balanced' }, cycle: null } as Status;
  let block: Promise<void> | undefined;
  const done = driveMonitor({ dataDir: '/fixture', signal: abort.signal,
    read: async () => { reads++; return input; },
    run: async () => { calls++; started.push(structuredClone(input)); peak = Math.max(peak, ++concurrent); await block; concurrent--; return result; },
    source: options => { sources++; wake = options.onWake; return { close: () => { closed = true; }, state: () => ({ feed: 'connected', files: 'watching', lastActivityAt: null }) }; },
  });
  t.after(async () => { abort.abort(); await done; });
  await flush();
  return {
    get started() { return started; }, get sources() { return sources; },
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

test('a Ledger request or USB revision wakes a cooled monitor immediately without polling the model', async t => {
  const h = await harness(t);
  const cycle = { startedAt: new Date(epoch - 3_500_000).toISOString(), activeUntil: new Date(epoch - 2_900_000).toISOString(), nextEligibleAt: new Date(epoch + 60_000).toISOString() };
  h.change({ config: { ...configuration(), mode: 'ledger' }, cycle, ledgerRequest: 'none:0' });
  h.result({ cycle, operation: { status: 'cooling-down' } });
  h.wake('config'); await h.advance(0); assert.equal(h.calls, 2);
  h.change({ ledgerRequest: 'request-one:0' }); h.wake('ledger');
  await h.advance(0); assert.equal(h.calls, 3, 'request gets an immediate traversal with cadence still enforced by the graph');
  h.wake('ledger'); await h.advance(0); assert.equal(h.calls, 3, 'own journal writes do not schedule another traversal');
  h.change({ ledgerRequest: 'request-one:1' }); h.wake('ledger');
  await h.advance(0); assert.equal(h.calls, 4, 'USB presence prompts a fresh observation, never authorization');
  h.change({ ledgerRequest: 'request-two:1' });
  await h.advance(5000); assert.equal(h.calls, 5, 'missed request file event is covered by local control watchdog');
});


const liveEdits: [string, (config: Config) => Config][] = [
  ['fee target added', config => ({ ...config, rebalanceFeeTargetUsdE8: '5000000' })],
  ['fee target changed', config => ({ ...config, rebalanceFeeTargetUsdE8: '10000000' })],
  ['fee target removed', config => { const { rebalanceFeeTargetUsdE8: _fee, ...withoutFee } = config; return withoutFee; }],
  ['full targets replaced', config => ({ ...config, targets: { USDG: 1000, TSLA: 2500, AMZN: 2500, MSFT: 2000, AMD: 2000 } })],
  ['drift trigger', config => ({ ...config, driftThresholdBps: 250 })],
  ['cycle interval', config => ({ ...config, rebalanceIntervalSeconds: 7200 })],
  ['slippage', config => ({ ...config, slippageBps: 100 })],
  ['poll interval', config => ({ ...config, pollSeconds: 5 })],
  ['transaction deadline', config => ({ ...config, deadlineSeconds: 300 })],
];

for (const barrier of ['pending', 'cooldown'] as const) {
  test(`all live settings immediately refresh the same serial monitor while retaining its ${barrier} barrier`, async t => {
    const h = await harness(t, barrier === 'pending');
    const cycle = { startedAt: new Date(epoch - 3500000).toISOString(), activeUntil: new Date(epoch - 2900000).toISOString(),
      nextEligibleAt: new Date(epoch + 60000).toISOString() };
    h.change({ cycle }); h.result({ cycle, operation: { status: barrier === 'pending' ? 'pending' : 'cooling-down' } });
    h.wake('cycle'); await h.advance(0);
    let config = configuration();
    const originalPending = h.started.at(-1)!.pending;
    for (const [name, edit] of liveEdits) {
      const before = h.calls;
      config = edit(config); h.change({ config });
      for (let event = 0; event < 20; event++) h.wake('config');
      await h.advance(0);
      assert.equal(h.calls, before + 1, `${name} receives an immediate traversal`);
      assert.deepEqual(h.started.at(-1)!.config, config);
      assert.deepEqual(h.started.at(-1)!.cycle, cycle, 'settings do not reset recorded cadence');
      assert.deepEqual(h.started.at(-1)!.pending, originalPending, 'settings do not release the receipt barrier');
      h.wake('config'); await h.advance(0);
      assert.equal(h.calls, before + 1, 'duplicate file events do not rerun the same config');
    }
    assert.equal(h.sources, 1, 'settings reuse the existing monitor and event source');
    assert.equal(h.peak, 1);
    const beforeDeadline = h.calls;
    await h.advance(barrier === 'pending' ? 2999 : 59999);
    assert.equal(h.calls, beforeDeadline, 'the original receipt watchdog or cycle deadline still applies');
    await h.advance(1); assert.equal(h.calls, beforeDeadline + 1);
  });
}

test('every setting edit during a running traversal is queued once with the latest config and no overlap', async t => {
  const h = await harness(t);
  let config = configuration();
  for (const [name, edit] of liveEdits) {
    let release!: () => void;
    h.block(new Promise<void>(resolve => { release = resolve; }));
    const before = h.calls;
    h.wake('chain'); await h.advance(5000);
    assert.equal(h.calls, before + 1);
    const previous = config;
    config = edit(config); h.change({ config });
    for (let event = 0; event < 20; event++) h.wake('config');
    await h.advance(0);
    assert.equal(h.calls, before + 1, `${name} waits for the current traversal to settle`);
    release(); h.block(); await flush(); await h.advance(0);
    assert.equal(h.calls, before + 2);
    assert.deepEqual(h.started.at(-2)!.config, previous);
    assert.deepEqual(h.started.at(-1)!.config, config);
  }
  assert.equal(h.peak, 1); assert.equal(h.sources, 1);
});

test('a config change observed after a blocked run refreshes immediately even when its file event is missed', async t => {
  const h = await harness(t);
  let release!: () => void;
  h.block(new Promise<void>(resolve => { release = resolve; }));
  h.wake('chain'); await h.advance(5000);
  assert.equal(h.calls, 2);
  const updated = { ...configuration(), rebalanceFeeTargetUsdE8: '5000000' };
  h.change({ config: updated });
  release(); h.block(); await flush(); await h.advance(0);
  assert.equal(h.calls, 3, 'the post-run read already knows a fresh traversal is required');
  assert.deepEqual(h.started.at(-1)!.config, updated);
  assert.equal(h.sources, 1); assert.equal(h.peak, 1);
});
