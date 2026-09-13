import { isolatedViewPreload, seedLegacyHookRoute } from './legacy-hook-fixture.js';
import { assertTemporaryTestDirectory } from '../src/test-isolation.js';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

const { handleOpenCodePrompt: realHandle, selectOpenCodeLaunchRequest } = await import(new URL('../scripts/rebalance-opencode-hook.mjs', import.meta.url).href);
// These tests preserve historical per-wallet routes; new entry tests exercise restoration.
const handleOpenCodePrompt = async (input: unknown, overrides: Record<string, unknown> = {}) => {
  const selected = selectOpenCodeLaunchRequest(input, overrides.repository);
  await seedLegacyHookRoute(overrides.repository, selected?.normalized ? { ...selected.normalized,
    requestId: selected.requestId, sessionId: selected.normalized.session_id } : selected, overrides);
  return realHandle(input, overrides);
};

// Sanitized internal plugin envelope. Native command.execute.before has no
// stable message identity; the plugin must correlate it to chat.message first.
const event = {
  hook_event_name: 'OpenCodeCommand', command: 'rebalance', arguments: '',
  direct_user_command: true, parent_session_id: null, agent: 'build', cwd: '/fixture',
  session_id: 'ses_0123456789abABCdef01234567', message_id: 'msg_0123456789abABCdef01234567',
};
const forbidden = {
  resolveProfile: () => assert.fail('must not select a wallet'),
  runView: () => assert.fail('must not prepare a view'),
  openView: () => assert.fail('must not open a native pane'),
  readStopToken: () => assert.fail('must not read stop state'),
  ensureDependencies: () => assert.fail('must not install'),
  runLaunch: () => assert.fail('must not launch'),
  runRecovery: () => assert.fail('must not invoke manual recovery'),
};
function publicResult(reply: { hookSpecificOutput: { additionalContext: string } }) {
  const context = reply.hookSpecificOutput.additionalContext;
  return JSON.parse(context.slice(context.indexOf('\n') + 1));
}
function pinFixtureRepository(t: TestContext, root: string) {
  assertTemporaryTestDirectory(root);
  const previousRoot = process.env.REBALANCE_ROOT_DIR;
  const previousData = process.env.REBALANCE_DATA_DIR;
  process.env.REBALANCE_ROOT_DIR = join(root, '.local');
  process.env.REBALANCE_DATA_DIR = join(root, '.local');
  t.after(() => {
    if (previousRoot === undefined) delete process.env.REBALANCE_ROOT_DIR; else process.env.REBALANCE_ROOT_DIR = previousRoot;
    if (previousData === undefined) delete process.env.REBALANCE_DATA_DIR; else process.env.REBALANCE_DATA_DIR = previousData;
  });
}
async function fixture(t: TestContext, label: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), `rebalance-opencode-${label}-`)));
  pinFixtureRepository(t, root);
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('OpenCode adapter requires the exact correlated bare command, never text or tool calls', async () => {
  const cases = [null, {}, ...[
    { hook_event_name: 'command.execute.before' }, { hook_event_name: 'chat.message' },
    { hook_event_name: 'tool.execute.before', tool: 'skill' }, { hook_event_name: 'UserPromptSubmit', prompt: '$rebalance' },
    { command: 'other' }, { command: '/rebalance' }, { command: 'plugin:rebalance' },
    { arguments: undefined }, { direct_user_command: false }, { direct_user_command: undefined },
    { direct_user_command: 'true' },
    ...['status', 'recover', 'stop', 'setup', '--setup-only', '\nstart', '; anything',
      '/rebalance', '`touch /fixture/forbidden`', '$(touch /fixture/forbidden)'].map(arguments_ => ({ arguments: arguments_ })),
  ].map(update => ({ ...event, ...update }))];
  for (const input of cases) {
    assert.equal(selectOpenCodeLaunchRequest(input), null);
    assert.equal(await handleOpenCodePrompt(input, forbidden), null);
  }
});

test('OpenCode native session and message IDs provide stable namespaced request identity', () => {
  const first = selectOpenCodeLaunchRequest(event);
  assert.match(first.requestId, /^[a-f0-9]{64}$/);
  assert.equal(first.requestId, selectOpenCodeLaunchRequest({ ...event, arguments: ' \t\n' }).requestId);
  assert.equal(first.requestId, selectOpenCodeLaunchRequest({ ...event, prompt: '/rebalance stop', turn_id: 'not-used', messageID: 'not-used' }).requestId);
  assert.notEqual(first.requestId, selectOpenCodeLaunchRequest({ ...event, session_id: `${event.session_id}A` }).requestId);
  assert.notEqual(first.requestId, selectOpenCodeLaunchRequest({ ...event, message_id: `${event.message_id}A` }).requestId);
  assert.deepEqual(first.normalized, {
    hook_event_name: 'UserPromptSubmit', prompt: '$rebalance', permission_mode: 'default',
    cwd: event.cwd, session_id: `opencode:${event.session_id}`, turn_id: event.message_id,
  });
});

test('Plan, custom agents, child sessions and missing native identity block before all setup', async () => {
  for (const update of [{ agent: 'plan' }, { agent: 'custom' }, { agent: undefined }, { permission_mode: 'plan' },
    { parent_session_id: 'ses_child' }, { parent_session_id: undefined }, { parent_session_id: '' },
    { cwd: 'relative' }, { session_id: '' }, { session_id: 'claude:session' },
    { session_id: `ses_${'a'.repeat(129)}` }, { session_id: 'ses_fixture\n' },
    { message_id: undefined, messageID: event.message_id, turn_id: event.message_id },
    { message_id: '' }, { message_id: 'msg_fixture\0' }, { message_id: 'msg_../escape' },
    { message_id: `msg_${'a'.repeat(129)}` }]) {
    const result = await handleOpenCodePrompt({ ...event, ...update }, forbidden);
    assert.equal(publicResult(result).outcome, 'blocked');
    assert.equal(result.hookSpecificOutput.hookEventName, 'chat.message');
  }
});

test('OpenCode launch captures stop generation before dependencies and returns no-repeat public context', async t => {
  const root = await fixture(t, 'order');
  await mkdir(join(root, 'nested'));
  const input = { ...event, cwd: join(root, 'nested') };
  const calls: string[] = [];
  let stop = 'none';
  const expected = { app: 'Rebalance', outcome: 'armed', status: { armed: true }, messages: [] };
  const result = await handleOpenCodePrompt(input, { repository: root, runView: async () => undefined,
    readStopToken: async () => { calls.push('stop'); return stop; },
    ensureDependencies: async (repo: string) => { assert.equal(repo, root); calls.push('dependencies'); stop = 'a'.repeat(64); },
    runLaunch: async (repo: string, requestId: string, expectedStop: string) => {
      assert.equal(repo, root); assert.equal(requestId, selectOpenCodeLaunchRequest(input).requestId);
      assert.equal(expectedStop, 'none'); assert.notEqual(expectedStop, stop); calls.push('launch'); return expected;
    }, runRecovery: forbidden.runRecovery,
  });
  assert.deepEqual(calls, ['stop', 'dependencies', 'launch']);
  assert.deepEqual(publicResult(result), expected);
  assert.match(result.hookSpecificOutput.additionalContext, /do not repeat launch or start, or repeat recovery/);
  assert.match(result.hookSpecificOutput.additionalContext, /An outcome is not a trade receipt/);
  assert.doesNotMatch(JSON.stringify(result), /ses_012345|msg_012345/);
});

test('OpenCode request replay keeps the original wallet after the session selects another wallet', async t => {
  const root = await fixture(t, 'route');
  const rootDir = join(root, '.local');
  const walletA = `0x${'1'.repeat(40)}`;
  const walletB = `0x${'2'.repeat(40)}`;
  const first = { wallet: walletA, dataDir: join(rootDir, 'wallets', walletA), chartPort: 4664, rootDir };
  const second = { wallet: walletB, dataDir: join(rootDir, 'wallets', walletB), chartPort: 4665, rootDir };
  let selected = first;
  const input = { ...event, cwd: root };
  const requestId = selectOpenCodeLaunchRequest(input).requestId;
  const sessionId = `opencode:${event.session_id}`;
  const routePath = join(rootDir, 'hook-routes', `${requestId}.json`);
  const observed: unknown[] = [];
  const overrides = { repository: root, runView: async () => undefined,
    resolveProfile: async (dataRoot: string, context: { sessionId: string }) => {
      assert.equal(dataRoot, rootDir); assert.deepEqual(context, { sessionId }); return selected;
    },
    readStopToken: async (_root: string, profile: unknown) => {
      assert.deepEqual(profile, { ...first, sessionId });
      assert.deepEqual(JSON.parse(await readFile(routePath, 'utf8')).profile, first); return 'none';
    }, ensureDependencies: async () => {},
    runLaunch: async (_root: string, id: string, _stop: string, profile: unknown) => {
      assert.equal(id, requestId); observed.push(profile);
      return { app: 'Rebalance', outcome: 'blocked', status: { armed: false }, messages: [] };
    }, runRecovery: forbidden.runRecovery,
  };
  await handleOpenCodePrompt(input, overrides);
  selected = second;
  await handleOpenCodePrompt(input, overrides);
  assert.deepEqual(observed, [{ ...first, sessionId }, { ...first, sessionId }]);
  assert.deepEqual(JSON.parse(await readFile(routePath, 'utf8')), { version: 1, requestId, sessionId, profile: first });
});

test('outside workspaces and symlinks escaping the project never reach the launcher', async t => {
  const root = await fixture(t, 'root');
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'rebalance-opencode-outside-')));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(root, 'escape'));
  for (const cwd of [outside, join(root, 'escape')]) {
    assert.equal(await handleOpenCodePrompt({ ...event, cwd }, { repository: root, ...forbidden }), null);
  }
});

test('lost launch output reports unknown trading state without leaking caught errors', async t => {
  const root = await fixture(t, 'unknown');
  const result = await handleOpenCodePrompt({ ...event, cwd: root }, { repository: root, runView: async () => undefined,
    readStopToken: async () => 'none', ensureDependencies: async () => {},
    runLaunch: async () => { throw new Error('fixture-secret-provider-response'); }, runRecovery: forbidden.runRecovery,
  });
  const value = publicResult(result);
  assert.equal(value.outcome, 'starting'); assert.equal(value.status, null);
  assert.match(value.messages.join(' '), /Current trading state is unknown/);
  assert.doesNotMatch(JSON.stringify(result), /fixture-secret|"armed":false/);
});

test('dependency errors block with fixed context and never dispatch launch', async t => {
  const root = await fixture(t, 'dependencies');
  const result = await handleOpenCodePrompt({ ...event, cwd: root }, { repository: root, runView: async () => undefined,
    readStopToken: async () => 'none', ensureDependencies: async () => { throw new Error('fixture-secret-installer'); },
    runLaunch: forbidden.runLaunch, runRecovery: forbidden.runRecovery,
  });
  assert.equal(publicResult(result).outcome, 'blocked'); assert.equal(publicResult(result).phase, 'dependencies');
  assert.doesNotMatch(JSON.stringify(result), /fixture-secret/);
});

test('OpenCode companion presentation follows the result and uses its namespaced session', async t => {
  const root = await fixture(t, 'view');
  const calls: string[] = [];
  const view = { state: 'ready', url: `http://127.0.0.1:4663/#view=${'a'.repeat(64)}`, connected: true, tradingChanged: false };
  const result = await handleOpenCodePrompt({ ...event, cwd: root }, { repository: root,
    readStopToken: async () => 'none', ensureDependencies: async () => {},
    runLaunch: async () => { calls.push('launch'); return { app: 'Rebalance', outcome: 'needs-input', status: { armed: false }, messages: [] }; },
    runView: async (repo: string, sessionId: string) => {
      calls.push('view'); assert.equal(repo, root); assert.equal(sessionId, `opencode:${event.session_id}`); return view;
    }, openView: async (request: unknown) => {
      calls.push('open'); assert.deepEqual(request, { url: view.url, rootDir: join(root, '.local'), sessionId: `opencode:${event.session_id}` });
      throw new Error('fixture-secret-native-pane');
    },
  });
  assert.deepEqual(calls, ['launch', 'view', 'open']);
  assert.equal(publicResult(result).outcome, 'needs-input'); assert.equal(publicResult(result).status.armed, false);
  assert.equal(publicResult(result).view.presentation.opened, false); assert.doesNotMatch(JSON.stringify(result), /fixture-secret/);
});

test('OpenCode CLI ignores unrelated input and safely handles malformed or oversized stdin', async t => {
  const directory = await fixture(t, 'input');
  const script = fileURLToPath(new URL('../scripts/rebalance-opencode-hook.mjs', import.meta.url));
  for (const [raw, blocked] of [[JSON.stringify({ ...event, arguments: 'status' }), false],
    ['{fixture-private-malformed', true], [' '.repeat(1_048_577), true]] as const) {
    const output = await new Promise<string>((resolve, reject) => {
      const child = execFile(process.execPath, [script], {
        cwd: directory, env: { REBALANCE_ROOT_DIR: directory, REBALANCE_DATA_DIR: directory }, timeout: 10000,
      }, (error, stdout, stderr) => {
        if (error) reject(error); else { assert.equal(stderr, ''); resolve(stdout); }
      });
      child.stdin!.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') reject(error); });
      child.stdin!.end(raw);
    });
    if (blocked) { assert.equal(publicResult(JSON.parse(output)).outcome, 'blocked'); assert.doesNotMatch(output, /fixture-private/); }
    else assert.equal(output, '');
    assert.deepEqual(await readdir(directory), []);
  }
});

test('OpenCode default shared launcher uses isolated unconfigured storage and replay preserves a newer stop', async t => {
  const directory = await fixture(t, 'entry');
  const repository = fileURLToPath(new URL('..', import.meta.url));
  const preload = join(directory, 'no-network.mjs');
  await writeFile(preload, `${isolatedViewPreload}\nimport { writeFileSync } from 'node:fs';
    globalThis.fetch = async () => { writeFileSync(${JSON.stringify(join(directory, 'unexpected-network'))}, 'blocked');
      throw new Error('Isolated OpenCode fixture network disabled'); };`);
  const wrapper = join(directory, 'isolated-opencode.mjs');
  await writeFile(wrapper, `import { handleOpenCodePrompt } from ${JSON.stringify(new URL('../scripts/rebalance-opencode-hook.mjs', import.meta.url).href)};
    let raw = ''; for await (const chunk of process.stdin) raw += chunk;
    const result = await handleOpenCodePrompt(JSON.parse(raw), { runView: async () => undefined,
      openView: async () => { throw new Error('Fixture must not open a host pane'); } });
    process.stdout.write(JSON.stringify(result) + '\\n');`);
  async function invoke() {
    return new Promise<string>((resolve, reject) => {
      const child = execFile(process.execPath, [wrapper], { cwd: repository,
        env: { PATH: process.env.PATH, REBALANCE_ROOT_DIR: directory, REBALANCE_DATA_DIR: directory,
          NODE_OPTIONS: `--import=${preload}` }, timeout: 10000,
      }, (error, stdout) => { if (error) reject(error); else resolve(stdout); });
      child.stdin!.end(JSON.stringify({ ...event, cwd: repository }));
    });
  }
  const first = publicResult(JSON.parse(await invoke()));
  assert.equal(first.outcome, 'ready'); assert.equal(first.status, null);
  const stop = { requestedAt: '2026-09-11T12:00:00.000Z', token: 'fixture-newer-stop' };
  await writeFile(join(directory, 'stop.json'), JSON.stringify(stop));
  const replay = publicResult(JSON.parse(await invoke()));
  assert.equal(replay.outcome, 'already-handled'); assert.equal(replay.status, null);
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'stop.json'), 'utf8')), stop);
  for (const file of ['unexpected-network', 'private-key', 'config.json', 'start.log', 'chart.log', 'pending.json',
    'cycle.json', 'run.lock', 'chart.lock', 'recovery.json', 'recovery.lock']) assert.equal(existsSync(join(directory, file)), false);
});


test('OpenCode new bare entry preserves native session identity through restore and opens its returned view once', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rebalance-opencode-restore-')));
  pinFixtureRepository(t, root); t.after(() => rm(root, { recursive: true, force: true }));
  const input = { ...event, cwd: root }, selected = selectOpenCodeLaunchRequest(input, root);
  const view = { state: 'ready', url: `http://127.0.0.1:4663/#view=${'a'.repeat(64)}`, connected: true };
  const calls: string[] = [];
  const result = publicResult(await realHandle(input, { repository: root,
    resolveProfile: () => assert.fail('restoration is independent of chat wallet attachment'),
    readStopToken: () => assert.fail('app snapshot owns wallet Stop generations'),
    runLaunch: () => assert.fail('new entry must not use legacy launch'), runView: () => assert.fail('view is already prepared'),
    ensureDependencies: async () => { calls.push('dependencies'); },
    runRestore: async (repository: string, id: string, session: string) => {
      assert.equal(repository, root); assert.equal(id, selected.requestId); assert.equal(session, selected.normalized.session_id);
      calls.push('restore'); return { app: 'Rebalance', outcome: 'ready', status: null, restorationResults: [], messages: [], view };
    },
    openView: async (request: {url: string; sessionId: string}) => {
      assert.equal(request.url, view.url); assert.equal(request.sessionId, selected.normalized.session_id);
      calls.push('open'); return { host: 'fixture', opened: true };
    },
  }));
  assert.equal(result.outcome, 'ready'); assert.equal(result.view.presentation.opened, true);
  assert.deepEqual(calls, ['dependencies', 'restore', 'open']);
});
