import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { PortfolioControls } from '../src/portfolio-control.js';
import { issueView } from '../src/view-session.js';
import { connectionPath } from '../scripts/profile-routing.mjs';
import { atomicWriteJson, readJson } from '../src/storage.js';
import { selectedPortfolioRunning, withNotificationSelection } from '../src/notification-selection.js';
import { ensureSelectedCodexNotifications } from '../src/selected-notifications.js';
import { codexNotificationStatus, configureCodexNotifications, runCodexNotifications, selectCodexNotifications, stopCodexNotifications, type CodexNotificationDependencies } from '../src/codex-notifications.js';

const chat = '11111111-1111-4111-8111-111111111111';
const otherChat = '22222222-2222-4222-8222-222222222222';
const wallet = '0x0000000000000000000000000000000000000001';
const event = (id: string) => ({ id, type: 'rebalance-completed' as const, createdAt: '2026-09-01T00:00:00.000Z', message: 'Fixture receipt confirmed' });
async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 200; i++) { if (await check()) return; await delay(5); }
  assert.fail('fixture did not settle');
}
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'rebalance-selected-notifications-'));
  const deps = { rootDir: root, dataDir: root, projectDir: '/fixture' };
  await atomicWriteJson(join(root, 'portfolios.json'), { version: 1, profiles: [{ wallet, chainId: 4663, directory: '.', chartPort: 4663 }] });
  await atomicWriteJson(join(root, 'config.json'), { wallet, chainId: 4663, mode: 'ledger' });
  await atomicWriteJson(join(root, 'status.json'), { app: 'Rebalance', wallet, chain: { id: 4663 }, mode: 'ledger', armed: true });
  await atomicWriteJson(join(root, 'run.lock'), { pid: process.pid, createdAt: new Date().toISOString(), token: randomUUID() });
  const connect = (id = chat) => atomicWriteJson(connectionPath(root, id), { version: 1, chainId: 4663, wallet });
  await connect();
  const controllers: AbortController[] = [], tasks: Promise<void>[] = [];
  t.after(async () => { controllers.forEach(c => c.abort()); await Promise.allSettled(tasks); await rm(root, { recursive: true, force: true }); });
  return { root, deps, connect, write: (file: string, value: unknown) => atomicWriteJson(join(root, file), value),
    async worker(watchSelection: CodexNotificationDependencies['watchSelection'] = () => () => {}) {
      let stream: Parameters<CodexNotificationDependencies['stream']>[0] | undefined;
      const sends: string[] = [];
      const controller = new AbortController(); controllers.push(controller);
      const task = runCodexNotifications({ signal: controller.signal }, { ...deps,
        stream: options => { stream = options; return { wake() {}, close() {} }; }, watchStop: () => () => {}, watchSelection,
        execute: async (_command, args) => { sends.push(args.at(-1)!); return { stdout: `Queued message queue-fixture for thread ${chat}` }; },
      });
      tasks.push(task); await until(() => stream !== undefined);
      return { sends, read: () => stream!.read(), deliver: (e: ReturnType<typeof event>) => stream!.deliver(e), stop: async () => { controller.abort(); await task; } };
    },
  };
}

test('selection guard requires matching public runner identity, actual attachment, and no Stop', async t => {
  const f = await fixture(t);
  assert.equal(await selectedPortfolioRunning(f.root, chat, f.root), true);
  assert.equal(await selectedPortfolioRunning(f.root, otherChat, f.root), false, 'sole wallet is not a selection');
  await f.write('stop.json', { requested: true }); assert.equal(await selectedPortfolioRunning(f.root, chat, f.root), false);
  await rm(join(f.root, 'stop.json'));
  await f.write('run.lock', { pid: process.pid }); assert.equal(await selectedPortfolioRunning(f.root, chat, f.root), false, 'arbitrary live PID lacks owned lock identity');
  await f.write('run.lock', { pid: process.pid, createdAt: new Date().toISOString(), token: randomUUID() });
  await f.write('status.json', { app: 'another app', wallet, chain: { id: 4663 }, mode: 'ledger', armed: true });
  assert.equal(await selectedPortfolioRunning(f.root, chat, f.root), false);
  await f.write('config.json', { wallet, chainId: 4663 });
  await f.write('status.json', { app: 'Rebalance', wallet, chain: { id: 4663 }, armed: true });
  assert.equal(await selectedPortfolioRunning(f.root, chat, f.root), false, 'missing modes cannot establish running identity');
});

test('automatic setup uses only a selected running native chat and preserves explicit pause', async t => {
  const f = await fixture(t); let starts = 0;
  const stub = { start: async () => { starts++; } };
  await ensureSelectedCodexNotifications(f.root, otherChat, {}, stub);
  await ensureSelectedCodexNotifications(f.root, 'claude:fixture', {}, stub);
  assert.equal(starts, 0); assert.equal((await codexNotificationStatus(f.deps)).configured, false);
  await ensureSelectedCodexNotifications(f.root, chat, {}, stub);
  assert.equal(starts, 1); assert.equal((await codexNotificationStatus(f.deps)).threadId, chat);
  await stopCodexNotifications(f.deps);
  await ensureSelectedCodexNotifications(f.root, chat, { explicitSelection: true }, stub);
  assert.equal((await codexNotificationStatus(f.deps)).enabled, false);
});

test('ordinary view continuation cannot steal another chat; explicit selection can transfer while retaining journal', async t => {
  const f = await fixture(t); await f.connect(otherChat);
  await selectCodexNotifications({ threadId: chat }, f.deps);
  const journal = [{ id: 'uncertain-event', threadId: chat, state: 'uncertain', attemptedAt: new Date().toISOString() }];
  await f.write('codex-notification-deliveries.json', journal);
  await ensureSelectedCodexNotifications(f.root, otherChat, {}, { start: async () => assert.fail('must not steal') });
  assert.equal((await codexNotificationStatus(f.deps)).threadId, chat);
  await ensureSelectedCodexNotifications(f.root, otherChat, { explicitSelection: true }, { start: async () => {} });
  assert.equal((await codexNotificationStatus(f.deps)).threadId, otherChat);
  assert.deepEqual(await readJson(join(f.root, 'codex-notification-deliveries.json')), journal);
});

test('fresh automatic subscription ignores historical IDs; sends only new meaningful events', async t => {
  const f = await fixture(t); await f.write('events.json', [event('historical')]);
  await selectCodexNotifications({ threadId: chat }, f.deps);
  const w = await f.worker(); assert.deepEqual(await w.read(), []);
  await f.write('events.json', [event('historical'), event('new'), { ...event('recovered'), type: 'rebalance-recovered' }]);
  assert.deepEqual((await w.read()).map(e => e.id), ['new']);
  await w.deliver(event('new')); assert.equal(w.sends.length, 1); assert.match(w.sends[0]!, /Retained event ID: new;/);
  assert.equal((await readJson<any[]>(join(f.root, 'events.json')))![0].acknowledgedAt, undefined);
});

test('Stop suspends deliveries without pausing preference, and inactive history stays quiet after Start', async t => {
  const f = await fixture(t); await selectCodexNotifications({ threadId: chat }, f.deps);
  const w = await f.worker(); await f.write('stop.json', { requested: true });
  await f.write('events.json', [event('while-stopped')]); assert.deepEqual(await w.read(), []);
  assert.equal((await codexNotificationStatus(f.deps)).enabled, true);
  await rm(join(f.root, 'stop.json')); assert.deepEqual(await w.read(), []);
  await f.write('events.json', [event('while-stopped'), event('after-start')]);
  assert.deepEqual((await w.read()).map(e => e.id), ['after-start']);
});

test('legacy manual binding also requires current selected running scope', async t => {
  const f = await fixture(t); await configureCodexNotifications({ threadId: chat }, f.deps);
  const w = await f.worker(); await f.write('events.json', [event('new')]);
  await rm(connectionPath(f.root, chat)); assert.deepEqual(await w.read(), []);
  assert.equal(await w.deliver(event('new')), false); assert.equal(w.sends.length, 0);
});

test('selection switch while dispatch waits prevents the native send and removes only known-unsent intent', async t => {
  const f = await fixture(t); await selectCodexNotifications({ threadId: chat }, f.deps);
  const w = await f.worker(); await f.write('events.json', [event('racing')]);
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>(done => { entered = done; });
  const held = withNotificationSelection(f.root, chat, async () => { entered(); await new Promise<void>(done => { release = done; }); });
  await ready; const sending = w.deliver(event('racing'));
  await until(async () => Boolean((await readJson<any[]>(join(f.root, 'codex-notification-deliveries.json')))?.length));
  await rm(connectionPath(f.root, chat)); release(); await held; await sending;
  assert.equal(w.sends.length, 0); assert.deepEqual(await readJson(join(f.root, 'codex-notification-deliveries.json')), []);
});

test('explicit reselection rebases history but same-selection continuation preserves the first baseline', async t => {
  const f = await fixture(t); await f.write('events.json', [event('old')]);
  await selectCodexNotifications({ threadId: chat }, f.deps);
  await f.write('events.json', [event('old'), event('while-away')]);
  await selectCodexNotifications({ threadId: chat }, f.deps);
  assert.deepEqual((await readJson<any>(join(f.root, 'codex-notifications.json'))).ignoredEventIds, ['old']);
  await selectCodexNotifications({ threadId: chat, explicitSelection: true }, f.deps);
  assert.deepEqual((await readJson<any>(join(f.root, 'codex-notifications.json'))).ignoredEventIds, ['old', 'while-away']);
});


test('explicit UI Start claims a stopped selection for its native chat, without replay takeover', async t => {
  const f = await fixture(t); await f.connect(otherChat);
  await f.write('config.json', { version: 1, wallet, chainId: 4663, mode: 'ledger',
    rpcUrl: 'https://fixture.invalid', targets: { USDG: 500, AAPL: 2500, NVDA: 2500, MSFT: 2500, AMD: 2000 },
    driftThresholdBps: 500, slippageBps: 50, deadlineSeconds: 120, pollSeconds: 30, rebalanceIntervalSeconds: 3600 });
  await selectCodexNotifications({ threadId: chat }, f.deps);
  await f.write('stop.json', { requested: true });
  let starts = 0;
  const stub = { start: async () => { starts++; } };
  await ensureSelectedCodexNotifications(f.root, otherChat, { explicitSelection: true }, stub);
  assert.equal((await codexNotificationStatus(f.deps)).threadId, chat, 'stopped selection does not start alerts');
  const { token } = await issueView(f.root, otherChat);
  const controls = new PortfolioControls(f.root, f.root, {
    execute: async (_profile, args, nativeSession) => {
      assert.equal(args[0], 'launch'); assert.equal(nativeSession, otherChat);
      await rm(join(f.root, 'stop.json'));
      return { ok: true, value: { app: 'Rebalance', outcome: 'armed', status: { chain: { id: 4663 }, wallet } } };
    },
    selectedNotifications: (profile, nativeSession, starting) => ensureSelectedCodexNotifications(profile.rootDir, nativeSession,
      { dataDir: profile.dataDir, starting, explicitSelection: true }, stub),
  });
  const request = { token, wallet, action: 'start' as const, requestId: randomUUID() };
  assert.equal((await controls.command(request)).outcome, 'armed');
  assert.equal((await codexNotificationStatus(f.deps)).threadId, otherChat);
  assert.equal(starts, 1);
  await selectCodexNotifications({ threadId: chat, explicitSelection: true }, f.deps);
  assert.equal((await controls.command(request)).outcome, 'already-handled');
  assert.equal((await codexNotificationStatus(f.deps)).threadId, chat, 'replayed Start cannot reclaim another chat');
  assert.equal(starts, 1);
});


test('normal notification shutdown does not turn selection watcher closure into an error', async t => {
  const f = await fixture(t); await selectCodexNotifications({ threadId: chat }, f.deps);
  const w = await f.worker((_root, _thread, _changed, failed) => () => failed());
  await w.stop();
  assert.equal((await codexNotificationStatus(f.deps)).error, null);
});
