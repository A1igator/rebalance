import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const { handlePrompt, selectLaunchRequest } = await import(new URL('../scripts/rebalance-hook.mjs', import.meta.url).href);
const event = { hook_event_name: 'UserPromptSubmit', prompt: '$rebalance', permission_mode: 'default',
  session_id: 'fixture-session', turn_id: 'fixture-turn', cwd: '/fixture' };

test('hook ignores inspections, heartbeat text, quoted commands and other event kinds without side effects', async () => {
  for (const input of [null, {}, { ...event, hook_event_name: 'Stop' }, { ...event, hook_event_name: 'PreToolUse' },
    ...['$rebalance status', '$rebalance --setup-only', 'Use $rebalance to report events',
      '`$rebalance`', 'please run $rebalance', '$rebalance\nstart', '$rebalance; anything', '/rebalance'].map(prompt => ({ ...event, prompt }))]) {
    const result = await handlePrompt(input, {
      ensureDependencies: () => assert.fail('must not install'), runLaunch: () => assert.fail('must not launch'),
    });
    assert.equal(result, null);
  }
});

test('hook blocks plan mode and missing identities without running setup', async () => {
  for (const input of [{ ...event, permission_mode: 'plan' }, { ...event, session_id: '' },
    { ...event, turn_id: undefined }, { ...event, cwd: 'relative' }]) {
    const result = await handlePrompt(input, {
      ensureDependencies: () => assert.fail('must not install'), runLaunch: () => assert.fail('must not launch'),
    });
    assert.match(result.hookSpecificOutput.additionalContext, /blocked/);
  }
});

test('a bare command routes directly to the launcher with stable opaque request identity', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rebalance-hook-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'nested'));
  const calls: string[] = [];
  const launchResult = { app: 'Rebalance', outcome: 'armed', status: { armed: true }, messages: [] };
  const result = await handlePrompt({ ...event, cwd: join(root, 'nested'), prompt: '  $rebalance\n' }, {
    repository: root,
    ensureDependencies: async (repo: string) => { assert.equal(repo, root); calls.push('dependencies'); },
    runLaunch: async (repo: string, id: string, expectedStop: string) => {
      assert.equal(repo, root);
      assert.match(id, /^[a-f0-9]{64}$/);
      assert.equal(id, selectLaunchRequest(event).requestId);
      assert.equal(expectedStop, 'none');
      calls.push('launch');
      return launchResult;
    },
  });
  assert.deepEqual(calls, ['dependencies', 'launch']);
  assert.equal(result.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(result.hookSpecificOutput.additionalContext, /do not repeat launch or start/);
  assert.ok(result.hookSpecificOutput.additionalContext.endsWith(JSON.stringify(launchResult)));
  assert.notEqual(selectLaunchRequest(event).requestId, selectLaunchRequest({ ...event, turn_id: 'another-turn' }).requestId);
});

test('hook does not launch when installed outside its selected workspace', async t => {
  const root = await mkdtemp(join(tmpdir(), 'rebalance-hook-root-'));
  const unrelated = await mkdtemp(join(tmpdir(), 'rebalance-hook-unrelated-'));
  t.after(() => Promise.all([root, unrelated].map(path => rm(path, { recursive: true, force: true }))));
  const result = await handlePrompt({ ...event, cwd: unrelated }, { repository: root,
    ensureDependencies: () => assert.fail('must not install'), runLaunch: () => assert.fail('must not launch') });
  assert.equal(result, null);
});

test('dependency failure prevents launch and failed structured outcomes are reported without claiming success', async t => {
  const root = await mkdtemp(join(tmpdir(), 'rebalance-hook-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(handlePrompt({ ...event, cwd: root }, { repository: root,
    ensureDependencies: async () => { throw new Error('fixture install failure'); },
    runLaunch: () => assert.fail('must not launch') }), /fixture install failure/);
  const result = await handlePrompt({ ...event, cwd: root }, { repository: root,
    ensureDependencies: async () => {},
    runLaunch: async () => ({ app: 'Rebalance', outcome: 'starting', status: { armed: false }, messages: [] }) });
  assert.match(result.hookSpecificOutput.additionalContext, /"outcome":"starting"/);
  assert.match(result.hookSpecificOutput.additionalContext, /"armed":false/);
});

test('hook captures the stop generation before dependency installation and passes it unchanged', async t => {
  const root = await mkdtemp(join(tmpdir(), 'rebalance-hook-stop-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let current = 'none';
  const calls: string[] = [];
  await handlePrompt({ ...event, cwd: root }, { repository: root,
    readStopToken: async () => { calls.push('snapshot'); return current; },
    ensureDependencies: async () => { calls.push('dependencies'); current = 'a'.repeat(64); },
    runLaunch: async (_root: string, _id: string, expectedStop: string) => {
      calls.push('launch');
      assert.equal(expectedStop, 'none');
      assert.notEqual(expectedStop, current);
      return { app: 'Rebalance', outcome: 'blocked', status: { armed: false }, messages: [] };
    } });
  assert.deepEqual(calls, ['snapshot', 'dependencies', 'launch']);
});

test('prepared hook command reaches the actual CLI in an isolated unconfigured fixture without network or services', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rebalance-hook-entry-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const preload = join(directory, 'no-network.mjs');
  await writeFile(preload, `import { writeFileSync } from 'node:fs';
    globalThis.fetch = async () => { writeFileSync(${JSON.stringify(join(directory, 'unexpected-network'))}, 'blocked');
      throw new Error('Hook fixture transport is disabled'); };`);
  const root = fileURLToPath(new URL('..', import.meta.url));
  const definition = JSON.parse(await readFile(new URL('../.codex/hooks.json', import.meta.url), 'utf8'));
  const command = definition.hooks.UserPromptSubmit[0].hooks[0].command;
  const env: NodeJS.ProcessEnv = { ...process.env, REBALANCE_DATA_DIR: directory, NODE_OPTIONS: `--import=${preload}` };
  delete env.REBALANCE_PRIVATE_KEY;
  const output = await new Promise<string>((resolve, reject) => {
    const child = execFile('/bin/sh', ['-c', command], { cwd: root, env, timeout: 10_000 }, (error, stdout) => {
      if (error) reject(error); else resolve(stdout);
    });
    child.stdin!.end(JSON.stringify({ ...event, cwd: root }));
  });
  const context = JSON.parse(output).hookSpecificOutput.additionalContext;
  assert.match(context, /"outcome":"needs-input"/);
  assert.match(context, /"armed":false/);
  for (const file of ['unexpected-network', 'private-key', 'start.log', 'chart.log', 'pending.json']) {
    assert.equal(existsSync(join(directory, file)), false);
  }
});
