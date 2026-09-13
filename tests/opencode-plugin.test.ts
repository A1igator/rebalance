import { assertTemporaryTestDirectory } from '../src/test-isolation.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { createRebalanceOpenCodePlugin } from '../src/opencode-plugin.js';
import { atomicWriteJson, readJson } from '../src/storage.js';
import { connectionPath, readProfiles, resolveProfile } from '../scripts/profile-routing.mjs';
import type { OpenCodeNotificationOptions, OpenCodeNotifications } from '../src/opencode-notifications.js';

const { selectOpenCodeLaunchRequest } = await import(new URL('../scripts/rebalance-opencode-hook.mjs', import.meta.url).href);
type Plugin = Awaited<ReturnType<typeof createRebalanceOpenCodePlugin>>;
type Part = Parameters<Plugin['chat.message']>[1]['parts'][number];
type NativeMessage = Parameters<Plugin['chat.message']>[1]['message'];
const sessionId = 'ses_fixtureNativePluginA';
const otherSession = 'ses_fixtureNativePluginB';
const walletA = `0x${'a'.repeat(40)}`;
const walletB = `0x${'b'.repeat(40)}`;
const namespace = (id: string) => `opencode:${id}`;
const digest = (id: string) => createHash('sha256').update(id).digest('hex');
const publicReply = { hookSpecificOutput: { hookEventName: 'chat.message',
  additionalContext: 'The deterministic Rebalance handler handled this invocation. Do not repeat launch or start.\n'
    + JSON.stringify({ app: 'Rebalance', outcome: 'needs-input', status: { armed: false }, messages: [] }) } };
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 500; i++) { if (await check()) return; await delay(5); }
  assert.fail('Isolated plugin condition did not settle');
}
async function fixture(t: TestContext, options: { wallets?: string[]; nested?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rebalance-opencode-plugin-')));
  assertTemporaryTestDirectory(root);
  const rootDir = join(root, '.local');
  const directory = options.nested ? join(root, 'nested') : root;
  await mkdir(rootDir);
  if (options.nested) await mkdir(directory);
  const profiles = (options.wallets ?? []).map((wallet, index) => ({ wallet, chainId: 4663,
    directory: `wallets/${wallet}`, chartPort: 4664 + index }));
  await atomicWriteJson(join(rootDir, 'portfolios.json'), { version: 1, profiles });
  for (const profile of profiles) await mkdir(join(rootDir, profile.directory), { recursive: true });
  const launches: { input: Record<string, unknown>; env: NodeJS.ProcessEnv }[] = [];
  const notificationCalls: OpenCodeNotificationOptions[] = [];
  const notifications: { options: OpenCodeNotificationOptions; closes: number }[] = [];
  const connectionWatchers: { changed: () => void; closed: boolean }[] = [];
  const plugins: Plugin[] = [];
  const clock = { time: 1000 };
  const native = { info: { id: sessionId, directory } as { id: string; directory?: string; parentID?: string }, error: undefined as unknown };
  let messageCounter = 0;
  const client = { session: {
    get: async (input: { path: { id: string } }) => { assert.equal(input.path.id, sessionId); return { data: native.info, error: native.error }; },
    promptAsync: async () => assert.fail('fixture must not use native notification transport'),
    messages: async () => assert.fail('fixture must not read a live message history'),
  } };
  async function persistRoute(input: Record<string, unknown>) {
    const selected = selectOpenCodeLaunchRequest(input, root);
    assert.ok(selected && !selected.blocked);
    let route;
    try {
      const profile = await resolveProfile(rootDir, { sessionId: selected.sessionId });
      route = { profile: { wallet: profile.wallet, dataDir: profile.dataDir, rootDir, chartPort: profile.chartPort } };
    } catch { route = { selectionRequired: true }; }
    await atomicWriteJson(join(rootDir, 'hook-routes', `${selected.requestId}.json`), {
      version: 1, sessionId: selected.sessionId, requestId: selected.requestId, ...route,
    });
  }
  let launch = async (input: Record<string, unknown>, _env: NodeJS.ProcessEnv): Promise<unknown> => {
    await persistRoute(input); return structuredClone(publicReply);
  };
  let notify = async (options: OpenCodeNotificationOptions): Promise<OpenCodeNotifications> => {
    const record = { options, closes: 0 }; notifications.push(record);
    return { wake() {}, close: async () => { record.closes++; } };
  };
  const create = async () => {
    const plugin = await createRebalanceOpenCodePlugin({ directory, client }, {
      repository: root, rootDir, now: () => clock.time,
      launch: async (input, env) => { launches.push({ input, env }); return launch(input, env); },
      notify: async options => { notificationCalls.push(options); return notify(options); },
      watchConnection: (observedRoot, changed) => {
        assert.equal(observedRoot, rootDir);
        const record = { changed, closed: false }; connectionWatchers.push(record);
        return () => { record.closed = true; };
      },
    });
    plugins.push(plugin); return plugin;
  };
  t.after(async () => { await Promise.all(plugins.map(plugin => plugin.dispose())); await rm(root, { recursive: true, force: true }); });
  const plugin = await create();
  async function command(arguments_ = '', selectedPlugin = plugin, parts: Part[] = [{ type: 'text', text: 'Fixture Rebalance skill template.' }]) {
    const output = { parts };
    await selectedPlugin['command.execute.before']({ command: 'rebalance', sessionID: sessionId, arguments: arguments_ }, output);
    return output.parts;
  }
  async function chat(parts: Part[], changes: Partial<NativeMessage> = {}, selectedPlugin = plugin,
    input: { sessionID: string; messageID?: string } = { sessionID: sessionId }) {
    const output = { parts, message: { id: `msg_fixtureNativeMessage${++messageCounter}`, sessionID: sessionId,
      role: 'user', agent: 'build', ...changes } };
    await selectedPlugin['chat.message'](input, output); return output;
  }
  async function invoke(arguments_ = '', selectedPlugin = plugin) { return chat(await command(arguments_, selectedPlugin), {}, selectedPlugin); }
  async function connect(wallet: string, id = sessionId) {
    await atomicWriteJson(connectionPath(rootDir, namespace(id)), { version: 1, chainId: 4663, wallet });
  }
  const changed = () => { for (const record of connectionWatchers) if (!record.closed) record.changed(); };
  const binding = () => readJson<{ version: number; sessionId: string; enabled: boolean; wallets: string[] }>(
    join(rootDir, 'opencode-sessions', `${digest(namespace(sessionId))}.json`));
  return { root, rootDir, directory, plugin, create, command, chat, invoke, launches, notificationCalls,
    notifications, connectionWatchers, connect, changed, binding, native, clock, persistRoute,
    setLaunch(value: typeof launch) { launch = value; }, setNotify(value: typeof notify) { notify = value; } };
}

test('OpenCode plugin loading and ordinary text never launch or bind notifications', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.launches, []); assert.deepEqual(f.notificationCalls, []);
  for (const text of ['/rebalance', '$rebalance', 'Please run /rebalance', 'Read skills/rebalance/SKILL.md']) {
    await f.chat([{ type: 'text', text }]);
  }
  assert.deepEqual(f.launches, []); assert.deepEqual(f.notificationCalls, []); assert.equal(await f.binding(), null);
  assert.deepEqual(await readdir(f.rootDir), ['portfolios.json']);
});

test('only supported native bare commands without attachments receive a marker', async t => {
  const f = await fixture(t);
  for (const arguments_ of ['status', 'recover', 'stop', 'setup', '--setup-only', '; touch anything', 'notifications resume extra']) {
    const parts = await f.command(arguments_); assert.equal(parts[0]!.metadata?.rebalanceInvocation, undefined);
    await f.chat(parts);
  }
  for (const parts of [[{ type: 'subtask', text: 'Fixture subtask' }], [{ type: 'text', text: 'template' }, { type: 'file', url: 'file:///fixture' }]]) {
    assert.deepEqual(await f.command('', f.plugin, structuredClone(parts)), parts);
  }
  for (const input of [{ command: 'other', sessionID: sessionId, arguments: '' },
    { command: 'rebalance', sessionID: 'not-native', arguments: '' }]) {
    const output = { parts: [{ type: 'text', text: 'original' }] };
    await f.plugin['command.execute.before'](input, output); assert.equal(output.parts[0]!.text, 'original');
  }
  assert.equal(f.launches.length, 0);
});

test('one linked native command dispatches its output message ID and replay cannot dispatch again', async t => {
  const f = await fixture(t);
  const parts = await f.command();
  const replay = structuredClone(parts);
  assert.match(parts[0]!.metadata!.rebalanceInvocation as string, /^[a-f0-9-]{36}$/);
  const result = await f.chat(parts);
  assert.equal(f.launches.length, 1);
  assert.deepEqual(f.launches[0]!.input, { hook_event_name: 'OpenCodeCommand', command: 'rebalance', arguments: '',
    cwd: f.directory, session_id: sessionId, message_id: result.message.id, agent: 'build', parent_session_id: null, direct_user_command: true });
  assert.equal(f.launches[0]!.env.REBALANCE_ROOT_DIR, f.rootDir);
  assert.equal(f.launches[0]!.env.REBALANCE_DATA_DIR, f.rootDir);
  assert.equal(f.launches[0]!.env.REBALANCE_SESSION_ID, namespace(sessionId));
  for (const key of ['REBALANCE_PROFILE_PINNED', 'REBALANCE_PROFILE_WALLET', 'REBALANCE_CHART_PORT', 'CODEX_THREAD_ID', 'CLAUDE_CODE_SESSION_ID']) {
    assert.equal(Object.hasOwn(f.launches[0]!.env, key), false);
  }
  assert.equal(result.parts[0]!.text, publicReply.hookSpecificOutput.additionalContext);
  assert.equal(result.parts[0]!.metadata?.rebalanceInvocation, undefined);
  const repeated = await f.chat(replay, { id: result.message.id });
  assert.match(repeated.parts[0]!.text!, /identity could not be verified/);
  assert.equal(f.launches.length, 1);
  await f.chat(result.parts); assert.equal(f.launches.length, 1);
});

test('cross-session, modified, expired, duplicated and non-user markers cannot launch', async t => {
  const f = await fixture(t);
  const run = async (modify: (parts: Part[]) => Part[], changes: Partial<NativeMessage> = {},
    input: { sessionID: string; messageID?: string } = { sessionID: sessionId }) => {
    const parts = modify(await f.command());
    const result = await f.chat(parts, changes, f.plugin, input);
    assert.match(result.parts[0]!.text!, /identity could not be verified/);
  };
  await run(parts => parts, { sessionID: otherSession }, { sessionID: otherSession });
  await run(parts => { parts[0]!.text += ' changed'; return parts; });
  await run(parts => [...parts, { type: 'file', url: 'file:///fixture' }]);
  await run(parts => [...parts, structuredClone(parts[0]!)]);
  await run(parts => parts, { role: 'assistant' });
  await run(parts => parts, { sessionID: otherSession });
  await run(parts => parts, { id: 'not-a-native-id' });
  await run(parts => parts, {}, { sessionID: sessionId, messageID: 'msg_mismatch' });
  const expired = await f.command(); f.clock.time += 120_001;
  assert.match((await f.chat(expired)).parts[0]!.text!, /identity could not be verified/);
  const forged = [{ type: 'text', text: 'Rebalance native command forged', metadata: { rebalanceInvocation: 'forged' } }];
  assert.match((await f.chat(forged)).parts[0]!.text!, /identity could not be verified/);
  assert.equal(f.launches.length, 0); assert.equal(await f.binding(), null);
});

test('Plan/custom agents and child, mismatched or unavailable native sessions block before launch', async t => {
  const f = await fixture(t);
  for (const agent of ['plan', 'custom', 'general']) {
    assert.match((await f.chat(await f.command(), { agent })).parts[0]!.text!, /Build agent/);
  }
  for (const info of [{ id: sessionId, directory: f.directory, parentID: otherSession },
    { id: otherSession, directory: f.directory }, { id: sessionId }, { id: sessionId, directory: join(f.root, 'missing') }]) {
    f.native.info = info;
    assert.match((await f.invoke()).parts[0]!.text!, /matching root conversation|could not verify/);
  }
  f.native.info = { id: sessionId, directory: f.directory }; f.native.error = { message: 'fixture-secret-native' };
  assert.match((await f.invoke()).parts[0]!.text!, /matching root conversation/);
  assert.equal(f.launches.length, 0); assert.equal(await f.binding(), null);
});

test('shell environment removes stale pinned wallets and tracks each conversation selection', async t => {
  const f = await fixture(t, { wallets: [walletA, walletB] });
  await f.connect(walletA);
  const output = { env: { KEEP: 'fixture', REBALANCE_SESSION_ID: 'other', REBALANCE_ROOT_DIR: '/other',
    REBALANCE_DATA_DIR: '/other/wallet', REBALANCE_PROFILE_PINNED: '1', REBALANCE_PROFILE_WALLET: walletB,
    REBALANCE_CHART_PORT: '9999', CODEX_THREAD_ID: 'other', CLAUDE_CODE_SESSION_ID: 'other' } };
  await f.plugin['shell.env']({ sessionID: sessionId }, output);
  assert.deepEqual(output.env, { KEEP: 'fixture', REBALANCE_SESSION_ID: namespace(sessionId), REBALANCE_ROOT_DIR: f.rootDir,
    REBALANCE_DATA_DIR: f.rootDir, REBALANCE_PROFILE_PINNED: '', REBALANCE_PROFILE_WALLET: '', REBALANCE_CHART_PORT: '', CODEX_THREAD_ID: '', CLAUDE_CODE_SESSION_ID: '' });
  assert.equal((await resolveProfile(output.env.REBALANCE_ROOT_DIR, { sessionId: output.env.REBALANCE_SESSION_ID })).wallet, walletA);
  await f.connect(walletB);
  assert.equal((await resolveProfile(output.env.REBALANCE_ROOT_DIR, { sessionId: output.env.REBALANCE_SESSION_ID })).wallet, walletB);
  const system = { system: [] as string[] }; await f.plugin['experimental.chat.system.transform']({ sessionID: sessionId }, system);
  assert.match(system.system.join('\n'), new RegExp(walletB));
  const untouched = { env: { KEEP: 'unchanged' } }; await f.plugin['shell.env']({}, untouched);
  assert.deepEqual(untouched.env, { KEEP: 'unchanged' }); assert.equal(f.launches.length, 0);
});

test('a single-profile launch without an explicit connection binds that exact wallet and reports fallback', async t => {
  const f = await fixture(t, { wallets: [walletA] });
  assert.equal(await readJson(connectionPath(f.rootDir, namespace(sessionId))), null);
  await f.invoke();
  assert.deepEqual((await f.binding())?.wallets, [walletA]);
  assert.deepEqual(f.notificationCalls.map(call => call.wallet), [walletA]);
  const system = { system: [] as string[] }; await f.plugin['experimental.chat.system.transform']({ sessionID: sessionId }, system);
  assert.match(system.system.join('\n'), new RegExp(walletA));
  assert.doesNotMatch(system.system.join('\n'), /No wallet is selected/);
});

test('launch binding keeps its persisted wallet when selection changes before launch returns', async t => {
  const f = await fixture(t, { wallets: [walletA, walletB] });
  await f.connect(walletA);
  f.setLaunch(async input => { await f.persistRoute(input); await f.connect(walletB); return structuredClone(publicReply); });
  await f.invoke();
  assert.deepEqual(new Set((await f.binding())?.wallets), new Set([walletA, walletB]));
  assert.deepEqual(new Set(f.notificationCalls.map(call => call.wallet)), new Set([walletA, walletB]));
});

test('nested OpenCode sessions use their original directory for notification transport', async t => {
  const f = await fixture(t, { wallets: [walletA], nested: true });
  await f.connect(walletA); await f.invoke();
  assert.equal(f.launches[0]!.input.cwd, f.directory);
  assert.equal(f.notificationCalls.length, 1);
  const call = f.notificationCalls[0]!;
  assert.equal((call as OpenCodeNotificationOptions & { sessionDirectory?: string }).sessionDirectory ?? call.projectDir, f.directory);
  assert.equal(call.sessionId, sessionId); assert.equal(call.rootDir, f.rootDir);
  assert.equal(call.dataDir, join(f.rootDir, 'wallets', walletA));
});

test('paused notifications remain paused across launch and restart until native resume', async t => {
  const f = await fixture(t, { wallets: [walletA] });
  await f.connect(walletA); await f.invoke();
  assert.equal(f.notifications.length, 1);
  await f.invoke('notifications pause');
  assert.equal((await f.binding())?.enabled, false);
  assert.equal(f.notifications[0]!.closes, 1); assert.equal(f.connectionWatchers[0]!.closed, true);
  await f.invoke(); assert.equal(f.launches.length, 2); assert.equal(f.notifications.length, 1);
  await f.plugin.dispose();
  const restored = await f.create();
  await f.chat([{ type: 'text', text: 'ordinary resumed conversation' }], {}, restored);
  assert.equal(f.notifications.length, 1);
  const resumed = await f.invoke('notifications resume', restored);
  assert.match(resumed.parts[0]!.text!, /notifications are enabled/);
  assert.equal((await f.binding())?.enabled, true); assert.equal(f.notifications.length, 2);
  const launches = f.launches.length;
  const status = await f.invoke('notifications status', restored);
  assert.match(status.parts[0]!.text!, /did not change trading/); assert.equal(f.launches.length, launches);
});

test('enabled binding restores on a new message without launching or switching its retained wallet', async t => {
  const f = await fixture(t, { wallets: [walletA, walletB] });
  await f.connect(walletA); await f.invoke(); await f.plugin.dispose();
  await f.connect(walletB);
  const restored = await f.create();
  await f.chat([{ type: 'text', text: 'Hello again' }], {}, restored);
  assert.equal(f.launches.length, 1);
  assert.deepEqual(new Set(f.notificationCalls.slice(1).map(call => call.wallet)), new Set([walletA, walletB]));
  assert.deepEqual(new Set((await f.binding())?.wallets), new Set([walletA, walletB]));
});

test('selection changes during asynchronous watcher setup are drained without another event', { timeout: 10_000 }, async t => {
  const f = await fixture(t, { wallets: [walletA, walletB] });
  await f.connect(walletA);
  const started = deferred(), release = deferred();
  const closed: string[] = [];
  f.setNotify(async options => {
    if (options.wallet === walletA) { started.resolve(); await release.promise; }
    return { wake() {}, close: async () => { closed.push(options.wallet!); } };
  });
  const launching = f.invoke(); await started.promise;
  await f.connect(walletB); f.changed(); release.resolve(); await launching;
  await until(() => f.notificationCalls.some(call => call.wallet === walletB));
  assert.deepEqual(f.notificationCalls.map(call => call.wallet), [walletA, walletB]);
  assert.deepEqual(new Set((await f.binding())?.wallets), new Set([walletA, walletB]));
  await f.plugin.dispose(); assert.deepEqual(new Set(closed), new Set([walletA, walletB]));
});

test('disposal closes a watcher that finishes setup late and prevents every later launch', { timeout: 10_000 }, async t => {
  const f = await fixture(t, { wallets: [walletA] });
  await f.connect(walletA);
  const started = deferred(), release = deferred();
  let closes = 0;
  f.setNotify(async () => { started.resolve(); await release.promise; return { wake() {}, close: async () => { closes++; } }; });
  const launching = f.invoke(); await started.promise;
  const disposing = f.plugin.dispose(); release.resolve(); await Promise.all([launching, disposing]);
  assert.equal(closes, 1); assert.equal(f.connectionWatchers.every(watcher => watcher.closed), true);
  await f.invoke(); assert.equal(f.launches.length, 1);
  await f.plugin.dispose(); assert.equal(closes, 1);
});

test('session deletion closes notification watchers and does not launch', async t => {
  const f = await fixture(t, { wallets: [walletA] });
  await f.connect(walletA); await f.invoke();
  await f.plugin.event({ event: { type: 'session.deleted', properties: { info: { id: sessionId } } } });
  assert.equal(f.notifications[0]!.closes, 1); assert.equal(f.connectionWatchers[0]!.closed, true);
  assert.equal(f.launches.length, 1);
});

test('unknown launch result forbids retry and does not expose errors or claim an unarmed outcome', async t => {
  const f = await fixture(t);
  for (const launch of [async () => { throw new Error('fixture-secret-transport'); }, async () => null,
    async () => ({ hookSpecificOutput: { additionalContext: 42 } })]) {
    f.setLaunch(launch);
    const result = await f.invoke();
    assert.match(result.parts[0]!.text!, /could not verify.*do not repeat launch automatically/);
    assert.doesNotMatch(result.parts[0]!.text!, /fixture-secret|unarmed|"armed":false/);
  }
  assert.equal(await f.binding(), null); assert.equal(f.notificationCalls.length, 0);
});

test('notification setup failure preserves an already returned public launch result', async t => {
  const f = await fixture(t, { wallets: [walletA] });
  await f.connect(walletA);
  f.setNotify(async () => { throw new Error('fixture-secret-notification'); });
  const output = await f.invoke();
  assert.ok(output.parts[0]!.text!.startsWith(publicReply.hookSpecificOutput.additionalContext));
  assert.match(output.parts[0]!.text!, /event delivery could not be connected; local events are retained/);
  assert.doesNotMatch(output.parts[0]!.text!, /fixture-secret|could not verify the native command result/);
  assert.equal(f.launches.length, 1);
});

test('outside repositories and escaping symlinks cannot load the plugin', async t => {
  const f = await fixture(t);
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'rebalance-opencode-plugin-outside-')));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(f.root, 'escape'));
  const client = { session: { get: async () => assert.fail('must not inspect session'),
    promptAsync: async () => assert.fail('must not prompt'), messages: async () => assert.fail('must not read history') } };
  for (const directory of [outside, join(f.root, 'escape')]) {
    await assert.rejects(createRebalanceOpenCodePlugin({ directory, client }, { repository: f.root, rootDir: f.rootDir }), /inside its repository/);
  }
});


test('multiple profiles without a selection never attach all wallets from a selection-only launch', async t => {
  const f = await fixture(t, { wallets: [walletA, walletB] });
  await f.invoke();
  assert.equal(f.launches.length, 1); assert.deepEqual((await f.binding())?.wallets, []);
  assert.equal(f.notificationCalls.length, 0);
  await f.connect(walletB); f.changed();
  await until(() => f.notificationCalls.length === 1);
  assert.deepEqual(f.notificationCalls.map(call => call.wallet), [walletB]);
});

test('a mismatched persisted launch route cannot attach notifications to another wallet or scope', async t => {
  const f = await fixture(t, { wallets: [walletA] });
  for (const update of [
    (route: Record<string, unknown>) => { route.sessionId = namespace(otherSession); },
    (route: Record<string, unknown>) => { route.requestId = 'b'.repeat(64); },
    (route: Record<string, unknown>) => { (route.profile as Record<string, unknown>).rootDir = '/fixture/other-root'; },
    (route: Record<string, unknown>) => { (route.profile as Record<string, unknown>).dataDir = '/fixture/other-wallet'; },
    (route: Record<string, unknown>) => { (route.profile as Record<string, unknown>).wallet = walletB; },
    (route: Record<string, unknown>) => { (route.profile as Record<string, unknown>).chartPort = 4669; },
  ]) {
    f.setLaunch(async input => {
      await f.persistRoute(input);
      const selected = selectOpenCodeLaunchRequest(input, f.root);
      const path = join(f.rootDir, 'hook-routes', `${selected.requestId}.json`);
      const route = await readJson<Record<string, unknown>>(path); assert.ok(route);
      update(route); await atomicWriteJson(path, route); return structuredClone(publicReply);
    });
    const output = await f.invoke();
    assert.ok(output.parts[0]!.text!.startsWith(publicReply.hookSpecificOutput.additionalContext));
    assert.match(output.parts[0]!.text!, /event delivery could not be connected/);
  }
  assert.equal(f.notificationCalls.length, 0); assert.deepEqual((await f.binding())?.wallets, []);
});

for (const trigger of ['ordinary message', 'notifications resume'] as const) {
  test(`a failed notification watcher retries on ${trigger} without a new launch`, async t => {
    const f = await fixture(t, { wallets: [walletA] });
    await f.connect(walletA);
    let attempts = 0, closes = 0;
    f.setNotify(async () => {
      attempts++;
      if (attempts === 1) throw new Error('Fixture initial watcher unavailable');
      return { wake() {}, close: async () => { closes++; } };
    });
    const initial = await f.invoke();
    assert.match(initial.parts[0]!.text!, /event delivery could not be connected/);
    assert.equal(attempts, 1); assert.equal(f.launches.length, 1);
    assert.equal(f.connectionWatchers.length, 1);
    if (trigger === 'ordinary message') await f.chat([{ type: 'text', text: 'Hello again' }]);
    else await f.invoke('notifications resume');
    assert.equal(attempts, 2, 'existing session record must retry incomplete watcher setup');
    assert.equal(f.launches.length, 1); assert.equal(f.connectionWatchers.length, 1);
    await f.plugin.dispose(); assert.equal(closes, 1);
  });
}

test('pause immediately closes the active wallet while another watcher is still starting', { timeout: 10_000 }, async t => {
  const f = await fixture(t, { wallets: [walletA, walletB] });
  const startingB = deferred(), releaseB = deferred();
  const closed: string[] = [];
  f.setNotify(async options => {
    if (options.wallet === walletB) { startingB.resolve(); await releaseB.promise; }
    return { wake() {}, close: async () => { closed.push(options.wallet!); } };
  });
  await f.connect(walletA); await f.invoke();
  assert.deepEqual(f.notificationCalls.map(call => call.wallet), [walletA]);
  await f.connect(walletB); f.changed(); await startingB.promise;
  const pausing = f.invoke('notifications pause');
  try {
    await until(() => closed.includes(walletA));
    assert.deepEqual(closed, [walletA], 'wallet A must close before wallet B finishes setup');
    assert.equal((await f.binding())?.enabled, false);
    assert.equal(f.connectionWatchers.every(watcher => watcher.closed), true);
  } finally { releaseB.resolve(); await pausing; }
  assert.deepEqual(closed, [walletA, walletB], 'the late wallet B watcher must also close');
  assert.equal(f.launches.length, 1);
  await f.plugin.dispose(); assert.deepEqual(closed, [walletA, walletB]);
});

test('saved notification bindings restore only after native root session and directory verification', async t => {
  for (const condition of ['child', 'other directory', 'missing directory', 'SDK error', 'other session'] as const) {
    const f = await fixture(t, { wallets: [walletA] });
    await f.connect(walletA); await f.invoke(); await f.plugin.dispose();
    assert.equal(f.notificationCalls.length, 1);
    if (condition === 'child') f.native.info.parentID = otherSession;
    if (condition === 'other directory') f.native.info.directory = f.rootDir;
    if (condition === 'missing directory') delete f.native.info.directory;
    if (condition === 'SDK error') f.native.error = { message: 'fixture-private-native-failure' };
    if (condition === 'other session') f.native.info.id = otherSession;
    const restored = await f.create();
    await f.chat([{ type: 'text', text: 'ordinary reopened conversation' }], {}, restored);
    assert.equal(f.notificationCalls.length, 1, `${condition} must not restore a notification watcher`);
    assert.equal(f.connectionWatchers.length, 1); assert.equal(f.launches.length, 1);
  }
});

test('unmarked message provenance is verified before restoring a saved notification binding', async t => {
  const f = await fixture(t, { wallets: [walletA] });
  await f.connect(walletA); await f.invoke(); await f.plugin.dispose();
  const restored = await f.create();
  for (const changes of [{ role: 'assistant' }, { sessionID: otherSession }, { id: '' }, { id: 'not-native' }]) {
    await f.chat([{ type: 'text', text: 'ordinary text' }], changes, restored);
    assert.equal(f.notificationCalls.length, 1);
  }
  await f.chat([{ type: 'text', text: 'ordinary text' }], {}, restored, { sessionID: sessionId, messageID: 'msg_mismatch' });
  assert.equal(f.notificationCalls.length, 1);
  await f.chat([{ type: 'text', text: 'verified ordinary user message' }], {}, restored);
  assert.equal(f.notificationCalls.length, 2); assert.equal(f.launches.length, 1);
});


test('remembered app entry binds only restored wallets without choosing one for the chat', async t => {
 const f = await fixture(t, {wallets:[walletA,walletB]});
 f.setLaunch(async input => {
  const selected=selectOpenCodeLaunchRequest(input,f.root);
  const profiles=await readProfiles(f.rootDir);
  await atomicWriteJson(join(f.rootDir,'app-launch-requests',createHash('sha256').update(selected.requestId).digest('hex')+'.json'),{
   version:1,requestId:selected.requestId,sessionId:selected.sessionId,
   entries:profiles.map(p=>({profile:p,generation:p.wallet===walletA?'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa':null,expectedStop:p.wallet===walletA?'none':null})),
  });
  return structuredClone(publicReply);
 });
 await f.invoke();
 assert.deepEqual((await f.binding())?.wallets,[walletA]);
 assert.deepEqual(f.notificationCalls.map(call=>call.wallet),[walletA]);
 assert.equal(await readJson(connectionPath(f.rootDir,namespace(sessionId))),null);
});
