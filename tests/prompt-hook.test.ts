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

function publicResult(reply: { hookSpecificOutput: { additionalContext: string } }) {
  const context = reply.hookSpecificOutput.additionalContext;
  return JSON.parse(context.slice(context.indexOf('\n') + 1));
}

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
  const failed = await handlePrompt({ ...event, cwd: root }, { repository: root,
    ensureDependencies: async () => { throw new Error('fixture-secret-install-error'); },
    runLaunch: () => assert.fail('must not launch') });
  const failure = publicResult(failed);
  assert.equal(failure.outcome, 'blocked');
  assert.equal(failure.phase, 'dependencies');
  assert.equal(failure.status, null);
  assert.match(failure.messages.join(' '), /no startup was attempted/);
  assert.doesNotMatch(JSON.stringify(failed), /fixture-secret-install-error/);
  const result = await handlePrompt({ ...event, cwd: root }, { repository: root,
    ensureDependencies: async () => {},
    runLaunch: async () => ({ app: 'Rebalance', outcome: 'starting', status: { armed: false }, messages: [] }) });
  assert.match(result.hookSpecificOutput.additionalContext, /"outcome":"starting"/);
  assert.match(result.hookSpecificOutput.additionalContext, /"armed":false/);
});

test('a failure after launch dispatch reports unknown state without exposing the exception or claiming unarmed', async t => {
  const root = await mkdtemp(join(tmpdir(), 'rebalance-hook-dispatch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await handlePrompt({ ...event, cwd: root }, { repository: root,
    ensureDependencies: async () => {},
    runLaunch: async () => { throw new Error('fixture-secret-provider-response'); } });
  const failure = publicResult(result);
  assert.equal(failure.outcome, 'starting');
  assert.equal(failure.phase, 'launch');
  assert.equal(failure.status, null);
  assert.match(failure.messages.join(' '), /may have started.*state is unknown/);
  assert.match(failure.messages.join(' '), /do not repeat launch or start/);
  assert.doesNotMatch(JSON.stringify(result), /fixture-secret-provider-response|"armed":false|no startup was attempted/);
});

test('saved stop-state failures return a public blocked result before dependencies or launch', async t => {
  const root = await mkdtemp(join(tmpdir(), 'rebalance-hook-stop-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await handlePrompt({ ...event, cwd: root }, { repository: root,
    readStopToken: async () => { throw new Error('fixture-secret-record-error'); },
    ensureDependencies: () => assert.fail('must not install'),
    runLaunch: () => assert.fail('must not launch') });
  const failure = publicResult(result);
  assert.equal(failure.outcome, 'blocked');
  assert.equal(failure.phase, 'stop-state');
  assert.equal(failure.status, null);
  assert.match(failure.messages.join(' '), /no startup was attempted/);
  assert.doesNotMatch(JSON.stringify(result), /fixture-secret-record-error/);
});

test('malformed input and nonexistent cwd exit successfully with safe structured failures before setup', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rebalance-hook-error-exit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('../scripts/rebalance-hook.mjs', import.meta.url));
  const inputs = [
    { raw: '{"fixture-secret-input":', phase: 'input' },
    { raw: JSON.stringify({ ...event, cwd: join(directory, 'fixture-secret-missing-directory') }), phase: 'workspace' },
  ];
  for (const { raw, phase } of inputs) {
    const output = await new Promise<string>((resolve, reject) => {
      const child = execFile(process.execPath, [script], { cwd: directory,
        env: { REBALANCE_DATA_DIR: directory }, timeout: 10_000 }, (error, stdout, stderr) => {
        if (error) { reject(error); return; }
        try { assert.equal(stderr, ''); resolve(stdout); } catch (failure) { reject(failure); }
      });
      child.stdin!.end(raw);
    });
    const failure = publicResult(JSON.parse(output));
    assert.equal(failure.outcome, 'blocked');
    assert.equal(failure.phase, phase);
    assert.equal(failure.status, null);
    assert.match(failure.messages.join(' '), /no startup was attempted/);
    assert.doesNotMatch(output, /fixture-secret|SyntaxError|ENOENT/);
  }
  for (const file of ['private-key', 'config.json', 'stop.json', 'launch.lock', 'start.log', 'chart.log', 'pending.json']) {
    assert.equal(existsSync(join(directory, file)), false);
  }
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
