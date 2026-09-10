import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openCompanionView, type CompanionOverrides } from '../scripts/companion-view.mjs';

const workspace = '10000000-0000-4000-8000-000000000001';
const source = '20000000-0000-4000-8000-000000000002';
const surface = '30000000-0000-4000-8000-000000000003';
const other = '40000000-0000-4000-8000-000000000004';
const url = 'http://127.0.0.1:4663/portfolios#fixture-private-view-token';
const env = { CMUX_WORKSPACE_ID: workspace, CMUX_SURFACE_ID: source };
const sessionId = 'claude:fixture-session';
const json = (value: unknown) => ({ stdout: JSON.stringify(value) });

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const rootDir = await mkdtemp(join(tmpdir(), 'rebalance-companion-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const calls: string[][] = [];
  let currentUrl = url;
  const execute: NonNullable<CompanionOverrides['execute']> = async (command, args, options) => {
    assert.equal(command, '/fixture/cmux');
    assert.deepEqual(args.slice(0, 3), ['--json', '--id-format', 'uuids']);
    assert.equal(options.timeout, 5000); assert.equal(options.killSignal, 'SIGKILL');
    assert.equal(options.maxBuffer, 65536); assert.deepEqual(options.env, env);
    const operation = args.slice(3); calls.push(operation);
    if (operation[0] === 'identify') return json({ caller: { workspace_id: workspace, surface_id: operation[4] } });
    if (operation[3] === 'open-split') return json({ surface_id: surface.toUpperCase(), workspace_id: workspace, created_split: true });
    if (operation[3] === 'url') return json({ url: currentUrl });
    if (operation[3] === 'navigate') { currentUrl = operation[4]!; return json({}); }
    assert.fail('unexpected native command');
  };
  const input = { url, rootDir, sessionId };
  const deps = { command: '/fixture/cmux', env, execute };
  const recordPath = async () => {
    const names = await readdir(join(rootDir, 'companion-views'));
    assert.equal(names.length, 1);
    return join(rootDir, 'companion-views', names[0]!);
  };
  return { rootDir, input, deps, execute, calls, recordPath, setUrl: (value: string) => { currentUrl = value; } };
}

test('non-cmux hosts get an explicit native-pane handoff without invoking a browser or writing state', async t => {
  const f = await fixture(t);
  for (const variables of [{}, { CMUX_WORKSPACE_ID: workspace }, { ...env, CMUX_SURFACE_ID: 'surface:1' }]) {
    assert.deepEqual(await openCompanionView(f.input, { ...f.deps, env: variables,
      execute: async () => assert.fail('no native call') }), { host: 'host', opened: false, reason: 'native-pane-required' });
  }
  assert.deepEqual(await readdir(f.rootDir), []);
});

test('rejects external, credentialed and malformed URLs before native calls', async t => {
  const f = await fixture(t);
  for (const badUrl of ['https://example.com', 'file:///tmp/a', 'http://localhost.example.com',
    'http://user:secret@localhost:4663', 'javascript:alert(1)', 'http://localhost:4663/\nunsafe', 'x'.repeat(8193)]) {
    const result = await openCompanionView({ ...f.input, url: badUrl }, f.deps);
    assert.equal(result.reason, 'invalid-view-url');
  }
  for (const update of [{ rootDir: 'relative' }, { sessionId: '' }, { sessionId: 'bad\nidentity' }]) {
    assert.equal((await openCompanionView({ ...f.input, ...update }, f.deps)).reason, 'invalid-view-context');
  }
  assert.deepEqual(f.calls, []); assert.deepEqual(await readdir(f.rootDir), []);
});

test('opens beside the verified source terminal without stealing focus and stores only owned public metadata', async t => {
  const f = await fixture(t);
  assert.deepEqual(await openCompanionView(f.input, f.deps), { host: 'cmux', opened: true, reused: false });
  assert.deepEqual(f.calls, [
    ['identify', '--workspace', workspace, '--surface', source],
    ['browser', '--surface', source, 'open-split', url, '--workspace', workspace, '--focus', 'false'],
  ]);
  const path = await f.recordPath(); const text = await readFile(path, 'utf8');
  assert.deepEqual(JSON.parse(text), { version: 1, state: 'ready', workspaceId: workspace, sourceId: source,
    origin: 'http://127.0.0.1:4663', surfaceId: surface });
  assert.doesNotMatch(text, /fixture-private|fixture-session|portfolios/);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test('reuses only the recorded browser and carries a fresh session URL as one literal argument', async t => {
  const f = await fixture(t); await openCompanionView(f.input, f.deps); f.calls.length = 0;
  const next = 'http://127.0.0.1:4664/?wallet=public#literal-$()-token';
  assert.deepEqual(await openCompanionView({ ...f.input, url: next }, f.deps), { host: 'cmux', opened: true, reused: true });
  assert.deepEqual(f.calls, [
    ['identify', '--workspace', workspace, '--surface', source],
    ['identify', '--workspace', workspace, '--surface', surface],
    ['browser', '--surface', surface, 'url'],
    ['browser', '--surface', surface, 'navigate', next],
  ]);
  assert.equal(JSON.parse(await readFile(await f.recordPath(), 'utf8')).origin, 'http://127.0.0.1:4664');
});

test('never falls back to the focused workspace when caller identity is stale or mismatched', async t => {
  const f = await fixture(t);
  for (const caller of [null, {}, { workspace_id: other, surface_id: source }, { workspace_id: workspace, surface_id: other }]) {
    let count = 0;
    const result = await openCompanionView(f.input, { ...f.deps, execute: async () => { count++; return json({ caller,
      focused: { workspace_id: workspace, surface_id: source } }); } });
    assert.equal(count, 1); assert.equal(result.reason, 'workspace-unavailable');
  }
  assert.deepEqual(await readdir(f.rootDir), []);
});

test('leaves an owned pane untouched if the user repurposed it to another origin', async t => {
  const f = await fixture(t); await openCompanionView(f.input, f.deps); f.calls.length = 0;
  f.setUrl('https://example.com/private-page');
  assert.equal((await openCompanionView(f.input, f.deps)).reason, 'view-repurposed');
  assert.equal(f.calls.length, 3); assert.equal(f.calls.some(args => args.includes('navigate') || args.includes('open-split')), false);
});

test('creates a replacement from the caller when the owned browser no longer belongs to the workspace', async t => {
  const f = await fixture(t); await openCompanionView(f.input, f.deps); f.calls.length = 0;
  const execute: NonNullable<CompanionOverrides['execute']> = async (command, args, options) => {
    if (args[3] === 'identify' && args[7] === surface) return json({ caller: null });
    return f.execute(command, args, options);
  };
  assert.deepEqual(await openCompanionView(f.input, { ...f.deps, execute }), { host: 'cmux', opened: true, reused: false });
  assert.equal(f.calls.some(args => args.includes('navigate')), false);
  assert.equal(f.calls.at(-1)?.[2], source);
});

test('lost native create output leaves a durable no-duplicate barrier and never leaks raw errors', async t => {
  const f = await fixture(t); let creates = 0;
  const execute: NonNullable<CompanionOverrides['execute']> = async (command, args, options) => {
    if (args.includes('open-split')) { creates++; throw new Error('fixture-private-native-error'); }
    return f.execute(command, args, options);
  };
  const first = await openCompanionView(f.input, { ...f.deps, execute });
  assert.equal(first.opened, false); assert.doesNotMatch(JSON.stringify(first), /fixture-private/);
  assert.equal(JSON.parse(await readFile(await f.recordPath(), 'utf8')).state, 'opening');
  const replay = await openCompanionView(f.input, { ...f.deps, execute });
  assert.equal(replay.reason, 'open-unverified'); assert.equal(creates, 1);
});

test('rejects ambiguous or wrongly routed create responses instead of claiming a pane opened', async t => {
  const f = await fixture(t);
  for (const response of [null, [], { surface_id: source, workspace_id: workspace },
    { surface_id: surface, workspace_id: other }, { surface_id: 'surface:1', workspace_id: workspace }]) {
    await rm(join(f.rootDir, 'companion-views'), { recursive: true, force: true });
    const execute: NonNullable<CompanionOverrides['execute']> = async (command, args, options) => {
      if (args.includes('open-split')) return json(response);
      return f.execute(command, args, options);
    };
    assert.equal((await openCompanionView(f.input, { ...f.deps, execute })).opened, false);
  }
});

test('native failure, invalid JSON and oversized output return sanitized bounded failures', async t => {
  const f = await fixture(t);
  for (const stdout of ['fixture-private-not-json', 'x'.repeat(65537), '[]', '{"error":"fixture-private-error"}', '{"ok":false}']) {
    const result = await openCompanionView(f.input, { ...f.deps, execute: async () => ({ stdout }) });
    assert.deepEqual(result, { host: 'cmux', opened: false, reason: 'view-unavailable' });
  }
  assert.deepEqual(await readdir(f.rootDir), []);
});

test('corrupt or foreign receipt blocks before any browser mutation', async t => {
  const f = await fixture(t); await openCompanionView(f.input, f.deps);
  const path = await f.recordPath();
  for (const value of ['{bad', 'x'.repeat(8193), JSON.stringify({ version: 1, state: 'ready', workspaceId: other })]) {
    await writeFile(path, value); f.calls.length = 0;
    assert.equal((await openCompanionView(f.input, f.deps)).opened, false);
    assert.deepEqual(f.calls, [['identify', '--workspace', workspace, '--surface', source]]);
  }
});

test('concurrent calls serialize browser creation and a second arrival cannot open a duplicate', async t => {
  const f = await fixture(t);
  let started!: () => void; const entered = new Promise<void>(resolve => { started = resolve; });
  let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
  const execute: NonNullable<CompanionOverrides['execute']> = async (command, args, options) => {
    if (args.includes('open-split')) { started(); await blocked; }
    return f.execute(command, args, options);
  };
  const first = openCompanionView(f.input, { ...f.deps, execute }); await entered;
  assert.equal((await openCompanionView(f.input, { ...f.deps, execute })).reason, 'view-busy');
  release(); assert.equal((await first).opened, true);
  assert.equal(f.calls.filter(args => args.includes('open-split')).length, 1);
});
