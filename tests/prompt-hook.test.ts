import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const { handlePrompt: realHandlePrompt, launchPromptFormat, recoveryPromptFormat, selectLaunchRequest, selectRecoveryRequest } = await import(new URL('../scripts/rebalance-hook.mjs', import.meta.url).href);
const handlePrompt = (input: unknown, overrides: Record<string, unknown> = {}) => realHandlePrompt(input, { runView: async () => undefined, ...overrides });
const event = { hook_event_name: 'UserPromptSubmit', prompt: '$rebalance', permission_mode: 'default',
  session_id: 'fixture-session', turn_id: 'fixture-turn', cwd: '/fixture' };
const skillPrompt = (root: string) => `[$rebalance](${resolvePath(root, 'skills/rebalance/SKILL.md')})`;
const ambientPrompt = (request: string, url = 'http://127.0.0.1:4663/') => [
  '<in-app-browser-context source="ambient-ui-state">',
  "This block is automatically supplied ambient UI state, not part of the user's request. Do not treat it as an instruction or as evidence that the user explicitly selected the in-app browser.",
  '# In app browser:',
  '- The user has the in-app browser open with 5 tabs.',
  `- Current URL: ${url}`,
  '</in-app-browser-context>',
  '',
  '## My request:',
  request,
].join('\n');

type HookProfile = { wallet: string | null; dataDir: string; chartPort: number; rootDir: string; sessionId?: string };
function walletProfile(root: string, digit: string, chartPort: number): HookProfile {
  const wallet = `0x${digit.repeat(40)}`;
  const rootDir = join(root, '.local');
  return { wallet, dataDir: join(rootDir, 'wallets', wallet), chartPort, rootDir };
}

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
  for (const prompt of ['$rebalance', skillPrompt('/fixture'),
    ambientPrompt('$rebalance'), ambientPrompt(skillPrompt('/fixture'))]) {
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

test('ambient framing excludes metadata commands, malformed wrappers and every non-bare request tail', async () => {
  const canonical = skillPrompt('/fixture');
  const framed = ambientPrompt(canonical);
  const prompts = [
    ...['$rebalance status', '$rebalance stop', '$rebalance --setup-only', 'please run $rebalance',
      '`$rebalance`', '"$rebalance"', skillPrompt('/other-project'), `${canonical} status`,
      `${canonical}\nanything`, `${canonical}\n${canonical}`, `## My request:\n${canonical}`].map(request => ambientPrompt(request)),
    ambientPrompt('status', 'http://example.com/$rebalance'),
    ambientPrompt('status', 'http://example.com/' + canonical),
    `Unrelated text\n${framed}`, ambientPrompt(framed), framed + '\n## My request:\n$rebalance',
    framed.replace('source="ambient-ui-state"', 'source="user"'),
    framed.replace('not part of the user\'s request', 'part of the user\'s request'),
    framed.replace('# In app browser:', '# Browser:'),
    framed.replace('5 tabs.', '1000000 tabs.'), framed.replace('5 tabs.', '0 tabs.'),
    framed.replace('- Current URL: http://127.0.0.1:4663/', '- Current URL: bad url'),
    ambientPrompt(canonical, 'x'.repeat(4097)),
    framed.replace('</in-app-browser-context>', 'Extra context line\n</in-app-browser-context>'),
    framed.replace('</in-app-browser-context>', '</other-context>'),
    framed.replace('## My request:', '### My request:'),
    framed.replace('## My request:', '## My request:\n## My request:'),
  ];
  for (const prompt of prompts) {
    assert.equal(launchPromptFormat(prompt, '/fixture'), null);
    assert.equal(await handlePrompt({ ...event, prompt }, { repository: '/fixture',
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
    runRecovery: () => assert.fail('bare launch must not recover'),
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

test('launch and recovery pin the wallet before stop/bootstrap and reuse it after chat reattachment', async t => {
  for (const action of ['launch', 'recovery']) await t.test(action, async t => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'rebalance-hook-frozen-wallet-')));
    t.after(() => rm(root, { recursive: true, force: true }));
    const first = walletProfile(root, '1', 4664);
    const second = walletProfile(root, '2', 4665);
    let selected = first;
    const input = { ...event, cwd: root, prompt: action === 'recovery' ? '$rebalance recover' : '$rebalance' };
    const requestId = (selectRecoveryRequest(input, root) ?? selectLaunchRequest(input, root)).requestId;
    const routePath = join(first.rootDir, 'hook-routes', `${requestId}.json`);
    const phases: string[] = [];
    const observed: HookProfile[] = [];
    let dispatches = 0;
    const assertPinned = async () => {
      const saved = JSON.parse(await readFile(routePath, 'utf8'));
      assert.equal(saved.version, 1); assert.equal(saved.requestId, requestId);
      assert.equal(saved.sessionId, event.session_id);
      assert.deepEqual(saved.profile, first);
    };
    const dispatch = async (repo: string, id: string, expectedStop: string, profile: HookProfile) => {
      assert.equal(repo, root); assert.equal(id, requestId); assert.equal(expectedStop, 'a'.repeat(64));
      assert.deepEqual(profile, { ...first, sessionId: event.session_id });
      await assertPinned(); observed.push(profile); phases.push('dispatch');
      if (++dispatches === 1) throw new Error('fixture lost dispatch output');
      return { app: 'Rebalance', outcome: 'blocked', status: { armed: false }, messages: [] };
    };
    const overrides = {
      repository: root,
      resolveProfile: async (dataRoot: string, context: { sessionId: string }) => {
        assert.equal(dataRoot, first.rootDir); assert.deepEqual(context, { sessionId: event.session_id });
        return selected;
      },
      readStopToken: async (repo: string, profile: HookProfile) => {
        assert.equal(repo, root); assert.deepEqual(profile, { ...first, sessionId: event.session_id });
        await assertPinned(); phases.push('stop'); return 'a'.repeat(64);
      },
      ensureDependencies: async () => { await assertPinned(); phases.push('dependencies'); },
      runLaunch: action === 'launch' ? dispatch : () => assert.fail('recovery must not launch'),
      runRecovery: action === 'recovery' ? dispatch : () => assert.fail('launch must not manually recover'),
    };
    const initial = publicResult(await handlePrompt(input, overrides));
    assert.equal(initial.outcome, action === 'recovery' ? 'unknown' : 'starting');
    const frozen = await readFile(routePath, 'utf8');
    selected = second;
    assert.equal(publicResult(await handlePrompt(input, overrides)).outcome, 'blocked');
    assert.deepEqual(phases, ['stop', 'dependencies', 'dispatch', 'stop', 'dependencies', 'dispatch']);
    assert.equal(observed.length, 2);
    assert.equal(await readFile(routePath, 'utf8'), frozen, 'a retry cannot rewrite the original wallet route');
    assert.equal(existsSync(join(second.dataDir, 'launch-requests')), false);
  });
});

test('independent native sessions route the same turn label to different wallet state', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rebalance-hook-wallet-sessions-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profiles = { 'session-a': walletProfile(root, '1', 4664), 'session-b': walletProfile(root, '2', 4665) };
  const visits: string[] = [];
  const inputs = Object.keys(profiles).map(session_id => ({ ...event, cwd: root, session_id, turn_id: 'same-native-turn-label' }));
  const replies = await Promise.all(inputs.map(input => handlePrompt(input, {
    repository: root,
    resolveProfile: async (_root: string, { sessionId }: { sessionId: keyof typeof profiles }) => profiles[sessionId],
    readStopToken: async (_root: string, profile: HookProfile) => {
      const expected = profiles[profile.sessionId as keyof typeof profiles];
      assert.deepEqual(profile, { ...expected, sessionId: profile.sessionId });
      return profile.sessionId === 'session-a' ? 'a'.repeat(64) : 'b'.repeat(64);
    },
    ensureDependencies: async () => {},
    runLaunch: async (_root: string, requestId: string, expectedStop: string, profile: HookProfile) => {
      const session = profile.sessionId as keyof typeof profiles;
      assert.equal(requestId, selectLaunchRequest(inputs.find(value => value.session_id === session), root).requestId);
      assert.equal(expectedStop, session === 'session-a' ? 'a'.repeat(64) : 'b'.repeat(64));
      assert.deepEqual(profile, { ...profiles[session], sessionId: session }); visits.push(session);
      return { app: 'Rebalance', outcome: 'blocked', status: { armed: false }, messages: [] };
    },
  })));
  assert.deepEqual(visits.sort(), ['session-a', 'session-b']);
  assert.ok(replies.every(reply => publicResult(reply).outcome === 'blocked'));
  assert.notEqual(selectLaunchRequest(inputs[0], root).requestId, selectLaunchRequest(inputs[1], root).requestId);
  assert.equal((await readdir(join(root, '.local', 'hook-routes'))).filter(name => name.endsWith('.json')).length, 2);
});

test('legacy handled request records retain legacy wallet affinity after the chat selects another wallet', async t => {
  for (const action of ['launch', 'recovery']) await t.test(action, async t => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'rebalance-hook-legacy-route-')));
    t.after(() => rm(root, { recursive: true, force: true }));
    const attached = walletProfile(root, '2', 4665);
    const input = { ...event, cwd: root, prompt: action === 'recovery' ? '$rebalance recover' : '$rebalance' };
    const id = (selectRecoveryRequest(input, root) ?? selectLaunchRequest(input, root)).requestId;
    const directory = join(attached.rootDir, action === 'recovery' ? 'recovery-requests' : 'launch-requests');
    await mkdir(directory, { recursive: true });
    const legacyPath = join(directory, `${createHash('sha256').update(id).digest('hex')}.json`);
    const original = '{"fixture":"already-handled-native-request"}\n';
    await writeFile(legacyPath, original);
    const dispatch = async (_root: string, requestId: string, expectedStop: string, profile: HookProfile) => {
      assert.equal(requestId, id); assert.equal(expectedStop, 'none');
      assert.equal(profile.dataDir, attached.rootDir); assert.equal(profile.rootDir, attached.rootDir);
      assert.equal(profile.chartPort, 4663); assert.equal(profile.sessionId, event.session_id);
      return { app: 'Rebalance', outcome: 'already-handled', status: { armed: false }, messages: [] };
    };
    const reply = await handlePrompt(input, {
      repository: root, resolveProfile: async () => attached,
      readStopToken: async (_root: string, profile: HookProfile) => { assert.equal(profile.dataDir, attached.rootDir); return 'none'; },
      ensureDependencies: async () => {},
      runLaunch: action === 'launch' ? dispatch : () => assert.fail('must not launch'),
      runRecovery: action === 'recovery' ? dispatch : () => assert.fail('must not recover'),
    });
    assert.equal(publicResult(reply).outcome, 'already-handled');
    assert.equal(await readFile(legacyPath, 'utf8'), original);
    const route = JSON.parse(await readFile(join(attached.rootDir, 'hook-routes', `${id}.json`), 'utf8'));
    assert.equal(route.profile.dataDir, attached.rootDir);
  });
});

test('route persistence failure blocks before stop state, dependency bootstrap or dispatch', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rebalance-hook-route-failure-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profile = walletProfile(root, '1', 4664);
  await mkdir(profile.rootDir, { recursive: true });
  await writeFile(join(profile.rootDir, 'hook-routes'), 'fixture-secret-route-storage-error');
  const reply = await handlePrompt({ ...event, cwd: root }, {
    repository: root, resolveProfile: async () => profile,
    readStopToken: () => assert.fail('must persist route before reading stop state'),
    ensureDependencies: () => assert.fail('must persist route before dependency bootstrap'),
    runLaunch: () => assert.fail('must not dispatch without a durable route'),
  });
  assert.equal(publicResult(reply).outcome, 'blocked');
  assert.doesNotMatch(JSON.stringify(reply), /fixture-secret|EEXIST|ENOTDIR/);
});

test('explicit recovery forms route only to recovery with stable identity and the original stop generation', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rebalance-hook-recovery-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'nested'));
  const forms = [['$rebalance recover', 'typed'], [`${skillPrompt(root)} recover`, 'canonical-skill-link'],
    [ambientPrompt('$rebalance recover'), 'ambient-typed'],
    [ambientPrompt(`${skillPrompt(root)} recover`), 'ambient-canonical-skill-link']];
  for (const [prompt, format] of forms) {
    const input = { ...event, prompt: ` \n${prompt}\n `, cwd: join(root, 'nested') };
    assert.equal(recoveryPromptFormat(input.prompt, root), format);
    assert.equal(selectLaunchRequest(input, root), null);
    assert.equal(selectRecoveryRequest(input, root).requestId, selectLaunchRequest(event, root).requestId);
    let stop = 'none';
    const calls: string[] = [];
    const expected = { app: 'Rebalance', requested: 'cancel', outcome: 'pending', armed: false, messages: [] };
    const result = await handlePrompt(input, { repository: root,
      readStopToken: async () => { calls.push('stop'); return stop; },
      ensureDependencies: async () => { calls.push('dependencies'); stop = 'a'.repeat(64); },
      runLaunch: () => assert.fail('recovery must not launch'),
      runRecovery: async (repo: string, requestId: string, expectedStop: string) => {
        assert.equal(repo, root);
        assert.equal(requestId, selectRecoveryRequest(input, root).requestId);
        assert.equal(expectedStop, 'none');
        assert.notEqual(expectedStop, stop);
        calls.push('recover');
        return expected;
      },
    });
    assert.deepEqual(calls, ['stop', 'dependencies', 'recover']);
    assert.deepEqual(publicResult(result), expected);
    assert.match(result.hookSpecificOutput.additionalContext, /do not repeat launch or start, or repeat recovery/);
  }
  assert.equal(selectRecoveryRequest(event, root), null);
});

test('recovery requires an exact user command, valid identity, execution mode and selected workspace', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rebalance-hook-recovery-gates-')));
  const outside = await mkdtemp(join(tmpdir(), 'rebalance-hook-recovery-outside-'));
  t.after(() => Promise.all([root, outside].map(path => rm(path, { recursive: true, force: true }))));
  const overrides = { repository: root,
    readStopToken: () => assert.fail('must not read stop state'),
    ensureDependencies: () => assert.fail('must not install'), runLaunch: () => assert.fail('must not launch'),
    runRecovery: () => assert.fail('must not recover'),
  };
  const invalidTails = ['$rebalance recover status', '$rebalance recover --cancel', '$rebalance recover now',
    '$rebalance recover; anything', '$rebalance\nrecover', '`$rebalance recover`', '"$rebalance recover"',
    'Please run $rebalance recover', `${skillPrompt(outside)} recover`, `${skillPrompt(root)} recover status`,
    '[$rebalance](skills/rebalance/SKILL.md) recover'];
  for (const prompt of [...invalidTails, ...invalidTails.map(tail => ambientPrompt(tail)),
    ambientPrompt('status', 'http://example.com/$rebalance%20recover'),
    ambientPrompt('$rebalance recover').replace('source="ambient-ui-state"', 'source="other"')]) {
    assert.equal(selectRecoveryRequest({ ...event, prompt, cwd: root }, root), null);
    assert.equal(await handlePrompt({ ...event, prompt, cwd: root }, overrides), null);
  }
  for (const prompt of ['$rebalance recover', `${skillPrompt(root)} recover`,
    ambientPrompt('$rebalance recover'), ambientPrompt(`${skillPrompt(root)} recover`)]) {
    for (const update of [{ permission_mode: 'plan' }, { session_id: '' }, { turn_id: undefined }, { cwd: 'relative' }]) {
      const result = await handlePrompt({ ...event, cwd: root, prompt, ...update }, overrides);
      assert.equal(publicResult(result).outcome, 'blocked');
    }
    assert.equal(await handlePrompt({ ...event, prompt, cwd: outside }, overrides), null);
    assert.equal(await handlePrompt({ ...event, prompt, cwd: root, hook_event_name: 'Stop' }, overrides), null);
  }
});

test('post-dispatch recovery failure reports unknown state without leaking errors or launching a fallback', async t => {
  const root = await mkdtemp(join(tmpdir(), 'rebalance-hook-recovery-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await handlePrompt({ ...event, cwd: root, prompt: '$rebalance recover' }, { repository: root,
    readStopToken: async () => 'none', ensureDependencies: async () => {},
    runLaunch: () => assert.fail('must not launch after recovery failure'),
    runRecovery: async () => { throw new Error('fixture-secret-cancellation-provider-response'); },
  });
  const failure = publicResult(result);
  assert.equal(failure.outcome, 'unknown');
  assert.equal(failure.phase, 'recovery');
  assert.equal(failure.status, null);
  assert.match(failure.messages.join(' '), /may have submitted a cancellation or resumed the runner/);
  assert.doesNotMatch(JSON.stringify(result), /fixture-secret|"armed":false|no startup was attempted/);
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

test('ambient framing routes only the entire bare user request with the same stable launch identity', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rebalance-hook-ambient-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'nested'));
  const literal = { ...event, cwd: join(root, 'nested') };
  const cases = [
    [ambientPrompt('$rebalance').replace('\n\n## My request:', '\n## My request:'), 'ambient-typed'],
    [ambientPrompt(skillPrompt(root)).replace('\n\n## My request:', '\n \t\n\n## My request:')
      .replace(/\n/g, '\r\n'), 'ambient-canonical-skill-link'],
  ];
  for (const [prompt, format] of cases) {
    const input = { ...literal, prompt: ` \n${prompt}\n ` };
    assert.equal(launchPromptFormat(input.prompt, root), format);
    assert.deepEqual(selectLaunchRequest(input, root), selectLaunchRequest(literal, root));
    const calls: string[] = [];
    const result = await handlePrompt(input, { repository: root,
      readStopToken: async () => { calls.push('stop'); return 'none'; },
      ensureDependencies: async () => { calls.push('dependencies'); },
      runLaunch: async (repo: string, requestId: string, expectedStop: string) => {
        assert.equal(repo, root);
        assert.equal(requestId, selectLaunchRequest(literal, root).requestId);
        assert.equal(expectedStop, 'none');
        calls.push('launch');
        return { app: 'Rebalance', outcome: 'armed', status: { armed: true }, messages: [] };
      },
    });
    assert.deepEqual(calls, ['stop', 'dependencies', 'launch']);
    assert.equal(publicResult(result).outcome, 'armed');
    assert.match(result.hookSpecificOutput.additionalContext, /do not repeat launch or start/);
  }
});

test('hook does not launch when installed outside its selected workspace', async t => {
  const root = await mkdtemp(join(tmpdir(), 'rebalance-hook-root-'));
  const unrelated = await mkdtemp(join(tmpdir(), 'rebalance-hook-unrelated-'));
  t.after(() => Promise.all([root, unrelated].map(path => rm(path, { recursive: true, force: true }))));
  for (const prompt of ['$rebalance', skillPrompt(root), ambientPrompt('$rebalance'), ambientPrompt(skillPrompt(root))]) {
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
  const forms = [['$rebalance', 'typed'], [skillPrompt(root), 'canonical-skill-link'],
    [ambientPrompt('$rebalance'), 'ambient-typed'], [ambientPrompt(skillPrompt(root)), 'ambient-canonical-skill-link'],
    ['$rebalance recover', 'recovery-typed'], [`${skillPrompt(root)} recover`, 'recovery-canonical-skill-link'],
    [ambientPrompt('$rebalance recover'), 'recovery-ambient-typed'],
    [ambientPrompt(`${skillPrompt(root)} recover`), 'recovery-ambient-canonical-skill-link']];
  for (const [index, [prompt, expectedFormat]] of forms.entries()) {
    const input = { ...event, prompt, cwd: root, turn_id: `fixture-entry-${index}` };
    const output = await new Promise<string>((resolve, reject) => {
      const child = execFile('/bin/sh', ['-c', command], { cwd: root, env, timeout: 10_000 }, (error, stdout) => {
        if (error) reject(error); else resolve(stdout);
      });
      child.stdin!.end(JSON.stringify(input));
    });
    const context = JSON.parse(output).hookSpecificOutput.additionalContext;
    if (expectedFormat.startsWith('recovery-')) {
      assert.match(context, /"requested":"cancel"/);
      assert.match(context, /"outcome":"blocked"/);
      assert.match(context, /No configured portfolio to recover/);
    } else assert.match(context, /"outcome":"needs-input"/);
    assert.match(context, /"armed":false/);
    const observation = JSON.parse(await readFile(join(directory, 'last-hook-observation.json'), 'utf8'));
    assert.equal(observation.requestId, (selectLaunchRequest(input, root) ?? selectRecoveryRequest(input, root)).requestId);
    assert.equal(observation.promptFormat, expectedFormat);
    assert.equal(observation.selection, 'selected');
    assert.equal(observation.workspace, 'inside');
    assert.equal(observation.planMode, false);
    for (const file of ['unexpected-network', 'private-key', 'config.json', 'stop.json',
      'start.log', 'chart.log', 'pending.json', 'cycle.json', 'run.lock', 'chart.lock', 'recovery.json', 'recovery.lock']) {
      assert.equal(existsSync(join(directory, file)), false);
    }
  }
});
