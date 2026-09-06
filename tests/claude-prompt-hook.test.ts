import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const { handleClaudePrompt, selectClaudeLaunchRequest } = await import(new URL('../scripts/rebalance-claude-hook.mjs', import.meta.url).href);
// Sanitized fields from the official native hook contract, not a captured live invocation:
// https://code.claude.com/docs/en/hooks#userpromptexpansion
// prompt_id requires Claude Code >=2.1.196; no turn_id or transcript read is needed.
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
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'nested'));
  const input = { ...event, cwd: join(root, 'nested') };
  const calls: string[] = [];
  let stop = 'none';
  const expected = { app: 'Rebalance', outcome: 'armed', status: { armed: true }, messages: [] };
  const result = await handleClaudePrompt(input, { repository: root,
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

test('outside workspaces and symlinks escaping the project never launch', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rebalance-claude-root-')));
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'rebalance-claude-outside-')));
  t.after(() => Promise.all([root, outside].map(path => rm(path, { recursive: true, force: true }))));
  await symlink(outside, join(root, 'escape'));
  for (const cwd of [outside, join(root, 'escape')]) {
    assert.equal(await handleClaudePrompt({ ...event, cwd }, { repository: root, ...forbidden }), null);
  }
});

test('lost dispatch output preserves unknown start state without leaking subprocess errors', async t => {
  const root = await mkdtemp(join(tmpdir(), 'rebalance-claude-unknown-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await handleClaudePrompt({ ...event, cwd: root }, { repository: root,
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
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await handleClaudePrompt({ ...event, cwd: root }, { repository: root,
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
  await writeFile(preload, `import { writeFileSync } from 'node:fs';
    globalThis.fetch = async () => { writeFileSync(${JSON.stringify(join(directory, 'unexpected-network'))}, 'blocked');
      throw new Error('Isolated hook fixture network disabled'); };`);
  const settings = JSON.parse(await readFile(new URL('../.claude/settings.json', import.meta.url), 'utf8'));
  const definition = settings.hooks.UserPromptExpansion[0].hooks[0];
  const args = definition.args.map((argument: string) => argument.replace('${CLAUDE_PROJECT_DIR}', root));
  const input = { ...event, cwd: root };
  async function invoke() {
    return new Promise<string>((resolve, reject) => {
      const child = execFile(process.execPath, args, { cwd: root,
        env: { PATH: process.env.PATH, REBALANCE_DATA_DIR: directory, NODE_OPTIONS: `--import=${preload}` }, timeout: 10000 },
      (error, stdout) => { if (error) reject(error); else resolve(stdout); });
      child.stdin!.end(JSON.stringify(input));
    });
  }
  const first = publicResult(JSON.parse(await invoke()));
  assert.equal(first.outcome, 'needs-input'); assert.equal(first.status.armed, false);
  const stop = { requestedAt: '2026-09-06T12:00:00.000Z', token: 'fixture-newer-stop' };
  await writeFile(join(directory, 'stop.json'), JSON.stringify(stop));
  const replay = publicResult(JSON.parse(await invoke()));
  assert.equal(replay.outcome, 'already-handled'); assert.equal(replay.status.armed, false);
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'stop.json'), 'utf8')), stop);
  for (const file of ['unexpected-network', 'private-key', 'config.json', 'start.log', 'chart.log', 'pending.json',
    'cycle.json', 'run.lock', 'chart.lock', 'recovery.json', 'recovery.lock']) assert.equal(existsSync(join(directory, file)), false);
});
