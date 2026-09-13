import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, realpath, rm, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertTemporaryTestDirectory } from '../src/test-isolation.js';

const claude = await import(new URL('../scripts/rebalance-claude-share-hook.mjs', import.meta.url).href);
const opencode = await import(new URL('../scripts/rebalance-opencode-share-hook.mjs', import.meta.url).href);
const code = 'rebalance:v1 USDG=5,AAPL=95 drift=5 interval=3600';
const expected = { app: 'Rebalance', operation: 'share-import', outcome: 'preview', code,
  shared: { targets: { USDG: 500, AAPL: 9500 }, driftThresholdBps: 500, rebalanceIntervalSeconds: 3600 },
  targetChanges: [], settingChanges: [], untrackedAssets: [], applied: false };
const forbidden = {
  ensureDependencies: () => assert.fail('must not bootstrap'),
  readStopToken: () => assert.fail('must not read Stop'),
  captureAppEntryInputs: () => assert.fail('must not snapshot startup'),
  runLaunch: () => assert.fail('must not launch'), runRestore: () => assert.fail('must not restore'),
  runRecovery: () => assert.fail('must not recover'), runView: () => assert.fail('preview owns read-only view preparation'),
  openView: () => assert.fail('must not open browser for completed preview'),
};
const contracts = [
  { name: 'Claude', handle: claude.handleClaudeSharePrompt, select: claude.selectClaudeShareImportRequest,
    script: '../scripts/rebalance-claude-share-hook.mjs', eventName: 'UserPromptSubmit', sessionId: 'claude:fixtureSession',
    input: { hook_event_name: 'UserPromptSubmit', prompt: code, session_id: 'fixtureSession',
      prompt_id: '550e8400-e29b-41d4-a716-446655440000', permission_mode: 'default' },
    ignored: [{ hook_event_name: 'UserPromptExpansion' }, { hook_event_name: 'PreToolUse', tool_name: 'Skill' }, { agent_id: 'child' }],
    blocked: [{ session_id: '' }, { prompt_id: '' }, { permission_mode: 'plan' }],
  },
  { name: 'OpenCode', handle: opencode.handleOpenCodeSharePrompt, select: opencode.selectOpenCodeShareImportRequest,
    script: '../scripts/rebalance-opencode-share-hook.mjs', eventName: 'chat.message', sessionId: 'opencode:ses_fixtureSession',
    input: { hook_event_name: 'OpenCodeShareImport', prompt: code, session_id: 'ses_fixtureSession',
      message_id: 'msg_fixtureMessage', agent: 'build', parent_session_id: null, direct_user_message: true },
    ignored: [{ hook_event_name: 'OpenCodeCommand' }, { direct_user_message: false }, { direct_user_message: undefined }],
    blocked: [{ session_id: '' }, { message_id: '' }, { agent: 'plan' }, { agent: 'custom' }, { parent_session_id: 'ses_parent' }],
  },
];
function publicResult(reply: { hookSpecificOutput: { additionalContext: string } }) {
  const context = reply.hookSpecificOutput.additionalContext;
  return JSON.parse(context.slice(context.indexOf('\n') + 1));
}

for (const c of contracts) {
  test(`${c.name} previews an exact pasted code under native identity without financial setup`, async t => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'rebalance-native-share-')));
    assertTemporaryTestDirectory(root);
    t.after(() => rm(root, { recursive: true, force: true }));
    const input = { ...c.input, cwd: root };
    const selected = c.select(input, root);
    assert.equal(selected.code, code);
    assert.equal(selected.normalized.prompt, code);
    assert.equal(selected.normalized.session_id, c.sessionId);
    let calls = 0;
    const result = await c.handle(input, { repository: root, ...forbidden,
      runSharePreview: async (repository: string, request: { code: string; sessionId: string }) => {
        calls++; assert.equal(repository, root); assert.equal(request.code, code); assert.equal(request.sessionId, c.sessionId);
        return expected;
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.hookSpecificOutput.hookEventName, c.eventName);
    assert.deepEqual(publicResult(result), expected);
    assert.deepEqual(await readdir(root), []);
  });

  test(`${c.name} ignores quoted, scoped, tool and ordinary prompts before preview`, async () => {
    const input = { ...c.input, cwd: '/fixture' };
    for (const update of [...c.ignored, ...['$rebalance', '/rebalance', '$rebalance share', 'ordinary text',
      `"${code}"`, `\`${code}\``, `Please import ${code}`, `\`\`\`\n${code}\n\`\`\``].map(prompt => ({ prompt }))]) {
      const candidate = { ...input, ...update };
      assert.equal(c.select(candidate), null);
      assert.equal(await c.handle(candidate, { ...forbidden, runSharePreview: () => assert.fail('must not preview') }), null);
    }
    for (const update of [...c.blocked, { cwd: 'relative' }]) {
      const result = await c.handle({ ...input, ...update }, { ...forbidden, runSharePreview: () => assert.fail('must not preview') });
      assert.equal(publicResult(result).outcome, 'blocked');
      assert.equal(publicResult(result).applied, false);
    }
  });

  test(`${c.name} import preview preserves canonical project boundaries and sanitizes failures`, async t => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'rebalance-native-share-root-')));
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'rebalance-native-share-outside-')));
    assertTemporaryTestDirectory(root); assertTemporaryTestDirectory(outside);
    t.after(() => Promise.all([root, outside].map(path => rm(path, { recursive: true, force: true }))));
    await symlink(outside, join(root, 'escape'));
    for (const cwd of [outside, join(root, 'escape')]) {
      assert.equal(await c.handle({ ...c.input, cwd }, { repository: root, ...forbidden,
        runSharePreview: () => assert.fail('must not preview outside project') }), null);
    }
    const result = await c.handle({ ...c.input, cwd: root }, { repository: root, ...forbidden,
      runSharePreview: () => { throw new Error('fixture-secret-provider'); } });
    assert.equal(publicResult(result).outcome, 'blocked');
    assert.equal(publicResult(result).applied, false);
    assert.doesNotMatch(JSON.stringify(result), /fixture-secret/);
    assert.deepEqual(await readdir(outside), []);
  });

  test(`${c.name} missing selection opens only the returned read-only companion view`, async t => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'rebalance-native-share-selector-')));
    assertTemporaryTestDirectory(root);
    t.after(() => rm(root, { recursive: true, force: true }));
    const view = { state: 'ready', url: `http://127.0.0.1:4663/#view=${'a'.repeat(64)}`, connected: true, tradingChanged: false };
    const pending = { app: 'Rebalance', operation: 'share-import', outcome: 'select-portfolio', code, shared: expected.shared, applied: false, view };
    const calls: string[] = [];
    const result = await c.handle({ ...c.input, cwd: root }, { repository: root, ...forbidden,
      runSharePreview: async () => { calls.push('preview'); return pending; },
      openView: async (request: { url: string; sessionId: string }) => {
        calls.push('view'); assert.equal(request.url, view.url); assert.equal(request.sessionId, c.sessionId);
        return { host: 'fixture', opened: true };
      },
    });
    assert.deepEqual(calls, ['preview', 'view']);
    const reported = publicResult(result);
    assert.equal(reported.applied, false); assert.equal(reported.outcome, 'select-portfolio');
    assert.equal(reported.view.presentation.opened, true); assert.equal(reported.targetChanges, undefined);
    assert.deepEqual(await readdir(root), []);
  });

  test(`${c.name} import-only executable ignores launch input in isolated storage`, async t => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'rebalance-native-share-stdin-')));
    assertTemporaryTestDirectory(directory);
    t.after(() => rm(directory, { recursive: true, force: true }));
    const script = fileURLToPath(new URL(c.script, import.meta.url));
    for (const prompt of ['$rebalance', '/rebalance', '$rebalance recover', 'hello']) {
      const output = await new Promise<string>((done, fail) => {
        const child = execFile(process.execPath, [script], { cwd: directory, timeout: 10_000,
          env: { PATH: process.env.PATH, REBALANCE_ROOT_DIR: directory, REBALANCE_DATA_DIR: directory } },
          (error, stdout, stderr) => { if (error) fail(error); else { assert.equal(stderr, ''); done(stdout); } });
        child.stdin!.end(JSON.stringify({ ...c.input, cwd: directory, prompt }));
      });
      assert.equal(output, '');
    }
    assert.deepEqual(await readdir(directory), []);
  });
}

test('Claude registers a dedicated preview-only prompt handler without trust policy changes', async () => {
  const settings = JSON.parse(await readFile(new URL('../.claude/settings.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(settings), ['hooks']);
  assert.deepEqual(settings.hooks.UserPromptSubmit, [{ hooks: [{ type: 'command', command: 'node',
    args: ['${CLAUDE_PROJECT_DIR}/scripts/rebalance-claude-share-hook.mjs'], timeout: 30 }] }]);
  assert.deepEqual(settings.hooks.UserPromptExpansion, [{ matcher: '^rebalance$', hooks: [{ type: 'command', command: 'node',
    args: ['${CLAUDE_PROJECT_DIR}/scripts/rebalance-claude-hook.mjs'], timeout: 400 }] }]);
});
