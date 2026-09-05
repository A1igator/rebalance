import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const { handlePrompt, selectLaunchRequest } = await import(new URL('../scripts/rebalance-hook.mjs', import.meta.url).href);
const event = { hook_event_name: 'UserPromptSubmit', prompt: '$rebalance', permission_mode: 'default',
  session_id: 'fixture-session', turn_id: 'fixture-turn', cwd: '/fixture' };
const skillPrompt = (root: string) => `[$rebalance](${resolvePath(root, 'skills/rebalance/SKILL.md')})`;

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
  for (const prompt of ['$rebalance', skillPrompt('/fixture')]) {
    for (const input of [{ ...event, prompt, permission_mode: 'plan' }, { ...event, prompt, session_id: '' },
      { ...event, prompt, turn_id: undefined }, { ...event, prompt, cwd: 'relative' }]) {
      const result = await handlePrompt(input, { repository: '/fixture',
        readStopToken: () => assert.fail('must not read stop state'),
        ensureDependencies: () => assert.fail('must not install'), runLaunch: () => assert.fail('must not launch'),
      });
      assert.match(result.hookSpecificOutput.additionalContext, /blocked/);
    }
  }
});

test('hook ignores other skill destinations, scoped links and surrounding text without side effects', async () => {
  const canonical = skillPrompt('/fixture');
  const destination = resolvePath('/fixture', 'skills/rebalance/SKILL.md');
  const prompts = [
    '[$rebalance](https://example.com/SKILL.md)', '[$rebalance](file://' + destination + ')',
    '[$rebalance](skills/rebalance/SKILL.md)', skillPrompt('/another-project'),
    '[$rebalance](/fixture/.agents/skills/rebalance/SKILL.md)',
    '[$rebalance](/fixture/skills/rebalance/../rebalance/SKILL.md)',
    '[$rebalance](<' + destination + '>)', '[$rebalance](' + destination + ' "Rebalance")',
    '[rebalance](' + destination + ')', '[$rebalance status](' + destination + ')',
    `${canonical} status`, `${canonical} --setup-only`, `${canonical}\nstart`,
    `Please run ${canonical}`, `Use ${canonical} to report events`, `${canonical}; anything`,
    '`' + canonical + '`', '"' + canonical + '"', `> ${canonical}`, `${canonical}\n${canonical}`,
  ];
  for (const input of [...prompts.map(prompt => ({ ...event, prompt })),
    { ...event, prompt: canonical, hook_event_name: 'Stop' }]) {
    assert.equal(await handlePrompt(input, { repository: '/fixture',
      readStopToken: () => assert.fail('must not read stop state'),
      ensureDependencies: () => assert.fail('must not install'), runLaunch: () => assert.fail('must not launch'),
    }), null);
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

test('a standalone skill-picker link routes to the same launcher request as the literal command', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rebalance hook picker-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'nested'));
  const calls: string[] = [];
  const literal = { ...event, cwd: join(root, 'nested') };
  const linked = { ...literal, prompt: `  ${skillPrompt(root)} \n` };
  assert.deepEqual(selectLaunchRequest(linked, root), selectLaunchRequest(literal, root));
  assert.notEqual(selectLaunchRequest(linked, root).requestId,
    selectLaunchRequest({ ...linked, turn_id: 'another-turn' }, root).requestId);
  const launchResult = { app: 'Rebalance', outcome: 'armed', status: { armed: true }, messages: [] };
  const result = await handlePrompt(linked, { repository: root,
    readStopToken: async (repo: string) => { assert.equal(repo, root); calls.push('stop'); return 'none'; },
    ensureDependencies: async (repo: string) => { assert.equal(repo, root); calls.push('dependencies'); },
    runLaunch: async (repo: string, id: string, expectedStop: string) => {
      assert.equal(repo, root);
      assert.equal(id, selectLaunchRequest(literal, root).requestId);
      assert.equal(expectedStop, 'none');
      calls.push('launch');
      return launchResult;
    },
  });
  assert.deepEqual(calls, ['stop', 'dependencies', 'launch']);
  assert.deepEqual(publicResult(result), launchResult);
  assert.match(result.hookSpecificOutput.additionalContext, /do not repeat launch or start/);
});

test('hook does not launch when installed outside its selected workspace', async t => {
  const root = await mkdtemp(join(tmpdir(), 'rebalance-hook-root-'));
  const unrelated = await mkdtemp(join(tmpdir(), 'rebalance-hook-unrelated-'));
  t.after(() => Promise.all([root, unrelated].map(path => rm(path, { recursive: true, force: true }))));
  for (const prompt of ['$rebalance', skillPrompt(root)]) {
    const result = await handlePrompt({ ...event, prompt, cwd: unrelated }, { repository: root,
      readStopToken: () => assert.fail('must not read stop state'),
      ensureDependencies: () => assert.fail('must not install'), runLaunch: () => assert.fail('must not launch') });
    assert.equal(result, null);
  }
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

test('native unmatched prompts record bounded format metadata without output, prompt content or services', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rebalance-hook-observation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = fileURLToPath(new URL('..', import.meta.url));
  const script = fileURLToPath(new URL('../scripts/rebalance-hook.mjs', import.meta.url));
  const recordPath = join(directory, 'last-hook-observation.json');
  for (const [prompt, promptFormat] of [
    ['No command fixture-secret-prompt', 'other'],
    ['$rebalance status fixture-secret-prompt', 'other-with-command'],
  ]) {
    const input = { ...event, prompt, cwd: root,
      session_id: 'fixture-secret-session', turn_id: 'fixture-secret-turn' };
    const output = await new Promise<string>((resolve, reject) => {
      const child = execFile(process.execPath, [script], { cwd: root,
        env: { REBALANCE_DATA_DIR: directory }, timeout: 10_000 }, (error, stdout, stderr) => {
        if (error) { reject(error); return; }
        try { assert.equal(stderr, ''); resolve(stdout); } catch (failure) { reject(failure); }
      });
      child.stdin!.end(JSON.stringify(input));
    });
    assert.equal(output, '');
    const raw = await readFile(recordPath, 'utf8');
    assert.doesNotMatch(raw, /fixture-secret|No command|\$rebalance/);
    assert.equal(raw.includes(root), false);
    const observation = JSON.parse(raw);
    assert.deepEqual(Object.keys(observation).sort(), ['version', 'recordedAt', 'requestId', 'event',
      'promptFormat', 'promptLength', 'selection', 'workspace', 'planMode'].sort());
    assert.equal(observation.version, 1);
    assert.equal(new Date(observation.recordedAt).toISOString(), observation.recordedAt);
    assert.equal(observation.requestId, selectLaunchRequest({ ...input, prompt: '$rebalance' }, root).requestId);
    assert.equal(observation.event, 'UserPromptSubmit');
    assert.equal(observation.promptFormat, promptFormat);
    assert.equal(observation.promptLength, prompt.length);
    assert.equal(observation.selection, 'ignored');
    assert.equal(observation.workspace, 'inside');
    assert.equal(observation.planMode, false);
    assert.equal((await stat(recordPath)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(directory), ['last-hook-observation.json']);
  }
});

test('a failed diagnostic write preserves the normal blocked Plan-mode reply without starting', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rebalance-hook-observation-failure-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dataPath = join(directory, 'fixture-secret-not-directory');
  await writeFile(dataPath, 'fixture-secret-original-content');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const script = fileURLToPath(new URL('../scripts/rebalance-hook.mjs', import.meta.url));
  const input = { ...event, cwd: root, permission_mode: 'plan' };
  const output = await new Promise<string>((resolve, reject) => {
    const child = execFile(process.execPath, [script], { cwd: root,
      env: { REBALANCE_DATA_DIR: dataPath }, timeout: 10_000 }, (error, stdout, stderr) => {
      if (error) { reject(error); return; }
      try { assert.equal(stderr, ''); resolve(stdout); } catch (failure) { reject(failure); }
    });
    child.stdin!.end(JSON.stringify(input));
  });
  assert.deepEqual(JSON.parse(output), await handlePrompt(input, {
    readStopToken: () => assert.fail('must not read stop state'),
    ensureDependencies: () => assert.fail('must not install'), runLaunch: () => assert.fail('must not launch'),
  }));
  assert.equal(publicResult(JSON.parse(output)).outcome, 'blocked');
  assert.match(output, /Plan mode/);
  assert.doesNotMatch(output, /fixture-secret|ENOTDIR|EEXIST/);
  assert.equal(await readFile(dataPath, 'utf8'), 'fixture-secret-original-content');
  assert.deepEqual(await readdir(directory), ['fixture-secret-not-directory']);
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
  for (const [index, prompt] of ['$rebalance', skillPrompt(root)].entries()) {
    const input = { ...event, prompt, cwd: root, turn_id: `fixture-entry-${index}` };
    const output = await new Promise<string>((resolve, reject) => {
      const child = execFile('/bin/sh', ['-c', command], { cwd: root, env, timeout: 10_000 }, (error, stdout) => {
        if (error) reject(error); else resolve(stdout);
      });
      child.stdin!.end(JSON.stringify(input));
    });
    const context = JSON.parse(output).hookSpecificOutput.additionalContext;
    assert.match(context, /"outcome":"needs-input"/);
    assert.match(context, /"armed":false/);
    const observation = JSON.parse(await readFile(join(directory, 'last-hook-observation.json'), 'utf8'));
    assert.equal(observation.requestId, selectLaunchRequest(input, root).requestId);
    assert.equal(observation.promptFormat, index === 0 ? 'typed' : 'canonical-skill-link');
    assert.equal(observation.selection, 'selected');
    assert.equal(observation.workspace, 'inside');
    assert.equal(observation.planMode, false);
    for (const file of ['unexpected-network', 'private-key', 'config.json', 'stop.json',
      'start.log', 'chart.log', 'pending.json', 'cycle.json', 'run.lock', 'chart.lock']) {
      assert.equal(existsSync(join(directory, file)), false);
    }
  }
});
