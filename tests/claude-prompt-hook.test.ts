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

const { handleClaudePrompt: realHandle, selectClaudeLaunchRequest } = await import(new URL('../scripts/rebalance-claude-hook.mjs', import.meta.url).href);
// These tests preserve historical per-wallet routes; new entry tests exercise restoration.
const handleClaudePrompt = async (input: unknown, overrides: Record<string, unknown> = {}) => {
  const selected = selectClaudeLaunchRequest(input, overrides.repository);
  await seedLegacyHookRoute(overrides.repository, selected?.normalized ? { ...selected.normalized,
    requestId: selected.requestId, sessionId: selected.normalized.session_id } : selected, overrides);
  return realHandle(input, overrides);
};

// Sanitized fields from the official native hook contract, not a captured live invocation:
// https://code.claude.com/docs/en/hooks#userpromptexpansion
// prompt_id requires Claude Code >=2.1.196; no turn_id or transcript read is needed.

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

const event = {
  hook_event_name: 'UserPromptExpansion', expansion_type: 'slash_command',
  command_name: 'rebalance', command_args: '', command_source: 'project', prompt: '/rebalance',
  session_id: 'fixture-session', prompt_id: '550e8400-e29b-41d4-a716-446655440000',
  permission_mode: 'default', cwd: '/fixture', transcript_path: '/never-read/fixture-private-transcript.jsonl',
};
function publicResult(reply: { hookSpecificOutput: { additionalContext: string } }) {
  const context = reply.hookSpecificOutput.additionalContext;
  return JSON.parse(context.slice(context.indexOf('\n') + 1));
}
const forbidden = {
  runView: () => assert.fail('must not prepare view'),
  openView: () => assert.fail('must not open a native pane'),
  readStopToken: () => assert.fail('must not read stop state'),
  ensureDependencies: () => assert.fail('must not install'),
  runLaunch: () => assert.fail('must not launch'),
  runRecovery: () => assert.fail('must not invoke manual recovery'),
};

test('Claude hook accepts only a direct bare user slash-skill expansion', async () => {
  const cases = [null, {}, ...[
    { hook_event_name: 'UserPromptSubmit' }, { hook_event_name: 'PreToolUse', tool_name: 'Skill' },
    { hook_event_name: 'Stop' }, { hook_event_name: 'Notification' }, { expansion_type: 'mcp_prompt' },
    { command_name: 'another-skill' }, { command_name: 'plugin:rebalance' },
    { command_args: 'recover' }, { command_args: 'status' }, { command_args: '--setup-only' },
    { command_args: undefined }, { agent_id: 'fixture-subagent' },
    ...['/rebalance status', '/rebalance recover', '/rebalance stop', '/rebalance setup',
      '/rebalance --setup-only', '/rebalance\nstart', '/rebalance; anything', '/rebalance /rebalance',
      '$rebalance', '`/rebalance`', '"/rebalance"', 'Please run /rebalance',
      'Use /rebalance to report retained notifications',
      '[/rebalance](/fixture/skills/rebalance/SKILL.md)'].map(prompt => ({ prompt })),
  ].map(update => ({ ...event, ...update }))];
  for (const input of cases) {
    assert.equal(selectClaudeLaunchRequest(input), null);
    assert.equal(await handleClaudePrompt(input, forbidden), null);
  }
});

test('native session_id and prompt_id provide a stable namespaced request without transcript metadata', () => {
  const first = selectClaudeLaunchRequest(event);
  assert.match(first.requestId, /^[a-f0-9]{64}$/);
  assert.equal(first.requestId, selectClaudeLaunchRequest({ ...event, prompt: ' \n/rebalance\n ', command_args: ' \t' }).requestId);
  assert.equal(first.requestId, selectClaudeLaunchRequest({ ...event, prompt_id: event.prompt_id.toUpperCase(), transcript_path: '/different/private-transcript' }).requestId);
  assert.equal(first.requestId, selectClaudeLaunchRequest({ ...event, turn_id: 'ignored-unrelated-field' }).requestId);
  assert.notEqual(first.requestId, selectClaudeLaunchRequest({ ...event, session_id: 'another-session' }).requestId);
  assert.notEqual(first.requestId, selectClaudeLaunchRequest({ ...event, prompt_id: '550e8400-e29b-41d4-a716-446655440001' }).requestId);
  assert.equal(first.normalized.session_id, 'claude:fixture-session');
  assert.equal(first.normalized.turn_id, event.prompt_id, 'internal shared slot receives the documented native prompt identity');
  assert.equal(Object.hasOwn(first.normalized, 'transcript_path'), false);
});

test('Plan mode and missing native identity block before setup without a guessed turn fallback', async () => {
  for (const update of [{ permission_mode: 'plan' }, { cwd: 'relative' }, { session_id: '' },
    { session_id: 'x'.repeat(2049) }, { prompt_id: undefined, turn_id: 'fixture-fake-turn' },
    { prompt_id: '' }, { prompt_id: 'not-a-native-uuid' }]) {
    const result = await handleClaudePrompt({ ...event, ...update }, forbidden);
    assert.equal(publicResult(result).outcome, 'blocked');
    assert.equal(result.hookSpecificOutput.hookEventName, 'UserPromptExpansion');
    assert.match(result.hookSpecificOutput.additionalContext, /nothing was started|not run in Plan mode/);
  }
});

test('native expansion routes to the shared launcher once with pre-bootstrap stop generation', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rebalance-claude-hook-')));
  pinFixtureRepository(t, root);
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'nested'));
  const input = { ...event, cwd: join(root, 'nested') };
  const calls: string[] = [];
  let stop = 'none';
  const expected = { app: 'Rebalance', outcome: 'armed', status: { armed: true }, messages: [] };
  const result = await handleClaudePrompt(input, { repository: root, runView: async () => undefined,
    readStopToken: async () => { calls.push('stop'); return stop; },
    ensureDependencies: async (repo: string) => { assert.equal(repo, root); calls.push('dependencies'); stop = 'a'.repeat(64); },
    runLaunch: async (repo: string, requestId: string, expectedStop: string) => {
      assert.equal(repo, root); assert.equal(requestId, selectClaudeLaunchRequest(input).requestId);
      assert.equal(expectedStop, 'none'); assert.notEqual(expectedStop, stop);
      calls.push('launch'); return expected;
    }, runRecovery: forbidden.runRecovery,
  });
  assert.deepEqual(calls, ['stop', 'dependencies', 'launch']);
  assert.deepEqual(publicResult(result), expected);
  assert.equal(result.hookSpecificOutput.hookEventName, 'UserPromptExpansion');
  assert.match(result.hookSpecificOutput.additionalContext, /do not repeat launch or start, or repeat recovery/);
  assert.match(result.hookSpecificOutput.additionalContext, /An outcome is not a trade receipt/);
  assert.doesNotMatch(JSON.stringify(result), /fixture-private-transcript|fixture-session|550e8400/);
});

test('Claude normalized session selects a wallet and preserves that route after reconnecting the same prompt', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rebalance-claude-wallet-route-')));
  pinFixtureRepository(t, root);
  t.after(() => rm(root, { recursive: true, force: true }));
  const rootDir = join(root, '.local');
  const walletA = `0x${'1'.repeat(40)}`;
  const walletB = `0x${'2'.repeat(40)}`;
  const first = { wallet: walletA, dataDir: join(rootDir, 'wallets', walletA), chartPort: 4664, rootDir };
  const second = { wallet: walletB, dataDir: join(rootDir, 'wallets', walletB), chartPort: 4665, rootDir };
  let selected = first;
  const input = { ...event, cwd: root };
  const requestId = selectClaudeLaunchRequest(input).requestId;
  const sessionId = `claude:${event.session_id}`;
  const routePath = join(rootDir, 'hook-routes', `${requestId}.json`);
  const observed: unknown[] = [];
  const overrides = {
    repository: root, runView: async () => undefined,
    resolveProfile: async (dataRoot: string, context: { sessionId: string }) => {
      assert.equal(dataRoot, rootDir); assert.deepEqual(context, { sessionId }); return selected;
    },
    readStopToken: async (_root: string, profile: unknown) => {
      assert.deepEqual(profile, { ...first, sessionId });
      assert.deepEqual(JSON.parse(await readFile(routePath, 'utf8')).profile, first);
      return 'none';
    },
    ensureDependencies: async () => {},
    runLaunch: async (_root: string, id: string, _stop: string, profile: unknown) => {
      assert.equal(id, requestId); observed.push(profile);
      return { app: 'Rebalance', outcome: 'blocked', status: { armed: false }, messages: [] };
    },
    runRecovery: forbidden.runRecovery,
  };
  await handleClaudePrompt(input, overrides);
  selected = second;
  await handleClaudePrompt(input, overrides);
  assert.deepEqual(observed, [{ ...first, sessionId }, { ...first, sessionId }]);
  const route = JSON.parse(await readFile(routePath, 'utf8'));
  assert.equal(route.requestId, requestId); assert.equal(route.sessionId, sessionId);
  assert.deepEqual(route.profile, first);
});

test('outside workspaces and symlinks escaping the project never launch', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rebalance-claude-root-')));
  pinFixtureRepository(t, root);
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'rebalance-claude-outside-')));
  t.after(() => Promise.all([root, outside].map(path => rm(path, { recursive: true, force: true }))));
  await symlink(outside, join(root, 'escape'));
  for (const cwd of [outside, join(root, 'escape')]) {
    assert.equal(await handleClaudePrompt({ ...event, cwd }, { repository: root, ...forbidden }), null);
  }
});

test('lost dispatch output preserves unknown start state without leaking subprocess errors', async t => {
  const root = await mkdtemp(join(tmpdir(), 'rebalance-claude-unknown-'));
  pinFixtureRepository(t, root);
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await handleClaudePrompt({ ...event, cwd: root }, { repository: root, runView: async () => undefined,
    readStopToken: async () => 'none', ensureDependencies: async () => {},
    runLaunch: async () => { throw new Error('fixture-secret-provider-response'); },
    runRecovery: forbidden.runRecovery,
  });
  const value = publicResult(result);
  assert.equal(value.outcome, 'starting'); assert.equal(value.status, null);
  assert.match(value.messages.join(' '), /Current trading state is unknown/);
  assert.doesNotMatch(JSON.stringify(result), /fixture-secret|"armed":false/);
});

test('dependency failures return fixed blocked context without entering the launcher', async t => {
  const root = await mkdtemp(join(tmpdir(), 'rebalance-claude-deps-'));
  pinFixtureRepository(t, root);
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await handleClaudePrompt({ ...event, cwd: root }, { repository: root, runView: async () => undefined,
    readStopToken: async () => 'none',
    ensureDependencies: async () => { throw new Error('fixture-secret-installer-output'); },
    runLaunch: forbidden.runLaunch, runRecovery: forbidden.runRecovery,
  });
  assert.equal(publicResult(result).outcome, 'blocked');
  assert.equal(publicResult(result).phase, 'dependencies');
  assert.doesNotMatch(JSON.stringify(result), /fixture-secret/);
});

test('prepared Claude definition uses one native expansion event and changes no trust or approval policy', async () => {
  const settings = JSON.parse(await readFile(new URL('../.claude/settings.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(settings), ['hooks']);
  assert.deepEqual(Object.keys(settings.hooks), ['UserPromptExpansion']);
  assert.equal(settings.hooks.UserPromptExpansion.length, 1);
  const entry = settings.hooks.UserPromptExpansion[0];
  assert.equal(entry.matcher, '^rebalance$');
  assert.equal(entry.hooks.length, 1);
  assert.deepEqual(entry.hooks[0], { type: 'command', command: 'node', args: ['${CLAUDE_PROJECT_DIR}/scripts/rebalance-claude-hook.mjs'], timeout: 400 });
});

test('native script ignores unrelated input and returns safe context for malformed stdin without touching local state', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rebalance-claude-input-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('../scripts/rebalance-claude-hook.mjs', import.meta.url));
  for (const [raw, blocked] of [[JSON.stringify({ ...event, prompt: '/rebalance status' }), false], ['{fixture-private-malformed', true]] as const) {
    const output = await new Promise<string>((resolve, reject) => {
      const child = execFile(process.execPath, [script], { cwd: directory, env: { REBALANCE_DATA_DIR: directory }, timeout: 10000 }, (error, stdout, stderr) => {
        if (error) reject(error); else { assert.equal(stderr, ''); resolve(stdout); }
      });
      child.stdin!.end(raw);
    });
    if (blocked) { assert.equal(publicResult(JSON.parse(output)).outcome, 'blocked'); assert.doesNotMatch(output, /fixture-private/); }
    else assert.equal(output, '');
    assert.deepEqual(await readdir(directory), []);
  }
});

test('prepared Claude command reaches only an isolated unconfigured CLI and replay cannot defeat a newer stop', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rebalance-claude-entry-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = fileURLToPath(new URL('..', import.meta.url));
  const preload = join(directory, 'no-network.mjs');
  await writeFile(preload, `${isolatedViewPreload}\nimport { writeFileSync } from 'node:fs';
    globalThis.fetch = async () => { writeFileSync(${JSON.stringify(join(directory, 'unexpected-network'))}, 'blocked');
      throw new Error('Isolated hook fixture network disabled'); };`);
  const settings = JSON.parse(await readFile(new URL('../.claude/settings.json', import.meta.url), 'utf8'));
  const definition = settings.hooks.UserPromptExpansion[0].hooks[0];
  const args = definition.args.map((argument: string) => argument.replace('${CLAUDE_PROJECT_DIR}', root));
  const input = { ...event, cwd: root };
  // Preserve the real isolated launcher but stub the separate view boundary in
  // this subprocess adapter. This fixture must never start a real hub or cmux.
  const wrapperUrl = new URL('../scripts/rebalance-claude-hook.mjs', import.meta.url);
  const isolatedWrapper = join(directory, 'isolated-claude-hook.mjs');
  const source = (await readFile(wrapperUrl, 'utf8'))
    .replace("'./rebalance-hook.mjs'", JSON.stringify(new URL('../scripts/rebalance-hook.mjs', import.meta.url).href))
    .replace("'./companion-view.mjs'", JSON.stringify(new URL('../scripts/companion-view.mjs', import.meta.url).href))
    .replace("const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');", `const repository = ${JSON.stringify(root)};`)
    .replace('{ openView: openCompanionView, ...overrides,', "{ openView: async () => ({ host: 'fixture', opened: true }), runView: async () => undefined, ...overrides,");
  assert.match(source, /runView: async \(\) => undefined/);
  await writeFile(isolatedWrapper, source);
  assert.equal(args.length, 1);
  args[0] = await realpath(isolatedWrapper);
  async function invoke() {
    return new Promise<string>((resolve, reject) => {
      const child = execFile(process.execPath, args, { cwd: root,
        env: { PATH: process.env.PATH, REBALANCE_DATA_DIR: directory, NODE_OPTIONS: `--import=${preload}` }, timeout: 10000 },
      (error, stdout) => { if (error) reject(error); else resolve(stdout); });
      child.stdin!.end(JSON.stringify(input));
    });
  }
  const first = publicResult(JSON.parse(await invoke()));
  assert.equal(first.outcome, 'ready'); assert.equal(first.status, null);
  const stop = { requestedAt: '2026-09-06T12:00:00.000Z', token: 'fixture-newer-stop' };
  await writeFile(join(directory, 'stop.json'), JSON.stringify(stop));
  const replay = publicResult(JSON.parse(await invoke()));
  assert.equal(replay.outcome, 'already-handled'); assert.equal(replay.status, null);
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'stop.json'), 'utf8')), stop);
  for (const file of ['unexpected-network', 'private-key', 'config.json', 'start.log', 'chart.log', 'pending.json',
    'cycle.json', 'run.lock', 'chart.lock', 'recovery.json', 'recovery.lock']) assert.equal(existsSync(join(directory, file)), false);
});


test('Claude view integration opens the returned session URL only after the deterministic launch result', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rebalance-claude-view-')));
  pinFixtureRepository(t, root);
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls: string[] = [];
  const view = { state: 'ready', url: `http://127.0.0.1:4663/#view=${'a'.repeat(64)}`,
    connected: true, tradingChanged: false };
  const launched = { app: 'Rebalance', outcome: 'armed', status: { armed: true }, messages: [] };
  const result = await handleClaudePrompt({ ...event, cwd: root }, { repository: root,
    readStopToken: async () => 'none', ensureDependencies: async () => {},
    runLaunch: async () => { calls.push('launch'); return launched; },
    runView: async (repository: string, sessionId: string) => {
      calls.push('view'); assert.equal(repository, root); assert.equal(sessionId, `claude:${event.session_id}`); return view;
    },
    openView: async (request: unknown) => {
      calls.push('open'); assert.deepEqual(request, { url: view.url, rootDir: join(root, '.local'), sessionId: `claude:${event.session_id}` });
      return { host: 'cmux', opened: true, reused: false };
    },
  });
  assert.deepEqual(calls, ['launch', 'view', 'open']);
  assert.deepEqual(publicResult(result), { ...launched, view: { ...view, presentation: { host: 'cmux', opened: true, reused: false } } });
});

test('Claude native-pane failure preserves the launch outcome without leaking host errors', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rebalance-claude-view-failure-')));
  pinFixtureRepository(t, root);
  t.after(() => rm(root, { recursive: true, force: true }));
  const launched = { app: 'Rebalance', outcome: 'armed', status: { armed: true }, messages: [] };
  const result = await handleClaudePrompt({ ...event, cwd: root }, { repository: root,
    readStopToken: async () => 'none', ensureDependencies: async () => {}, runLaunch: async () => launched,
    runView: async () => ({ state: 'ready', url: `http://127.0.0.1:4663/#view=${'b'.repeat(64)}`, connected: true, tradingChanged: false }),
    openView: async () => { throw new Error('fixture-private-native-output'); },
  });
  const value = publicResult(result);
  assert.equal(value.outcome, 'armed'); assert.deepEqual(value.status, { armed: true });
  assert.equal(value.view.presentation.opened, false); assert.doesNotMatch(JSON.stringify(result), /fixture-private/);
});

test('Claude view preparation failure never repeats launch or attempts a pane', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rebalance-claude-view-prepare-')));
  pinFixtureRepository(t, root);
  t.after(() => rm(root, { recursive: true, force: true }));
  let launches = 0;
  const result = await handleClaudePrompt({ ...event, cwd: root }, { repository: root,
    readStopToken: async () => 'none', ensureDependencies: async () => {},
    runLaunch: async () => { launches++; return { app: 'Rebalance', outcome: 'needs-input', status: { armed: false }, messages: [] }; },
    runView: async () => { throw new Error('fixture-private-view-failure'); }, openView: forbidden.openView,
  });
  assert.equal(launches, 1); const value = publicResult(result);
  assert.equal(value.outcome, 'needs-input'); assert.equal(value.status.armed, false); assert.equal(value.view.state, 'unavailable');
  assert.doesNotMatch(JSON.stringify(result), /fixture-private/);
});

test('Claude Desktop preview only attaches to the public local origin without a startup command or session token', async () => {
  const preview = JSON.parse(await readFile(new URL('../.claude/launch.json', import.meta.url), 'utf8'));
  assert.deepEqual(preview, { version: '0.0.1', configurations: [{ name: 'Rebalance', port: 4663, url: 'http://127.0.0.1:4663' }] });
});


test('Claude new bare entry preserves native session identity through restore and opens its returned view once', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rebalance-claude-restore-')));
  pinFixtureRepository(t, root); t.after(() => rm(root, { recursive: true, force: true }));
  const input = { ...event, cwd: root }, selected = selectClaudeLaunchRequest(input, root);
  const view = { state: 'ready', url: `http://127.0.0.1:4663/#view=${'a'.repeat(64)}`, connected: true };
  const calls: string[] = [];
  const result = publicResult(await realHandle(input, { repository: root,
    resolveProfile: () => assert.fail('restoration is independent of chat wallet attachment'),
    readStopToken: () => assert.fail('app snapshot owns wallet Stop generations'),
    runLaunch: () => assert.fail('new entry must not use legacy launch'), runView: () => assert.fail('view is already prepared'),
    ensureDependencies: async () => { calls.push('dependencies'); },
    runRestore: async (repository: string, id: string, session: string) => {
      assert.equal(repository, root); assert.equal(id, selected.requestId); assert.equal(session, selected.normalized.session_id);
      calls.push('restore'); return { app: 'Rebalance', outcome: 'ready', status: null, portfolios: [], messages: [], view };
    },
    openView: async (request: {url: string; sessionId: string}) => {
      assert.equal(request.url, view.url); assert.equal(request.sessionId, selected.normalized.session_id);
      calls.push('open'); return { host: 'fixture', opened: true };
    },
  }));
  assert.equal(result.outcome, 'ready'); assert.equal(result.view.presentation.opened, true);
  assert.deepEqual(calls, ['dependencies', 'restore', 'open']);
});
