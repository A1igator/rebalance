import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { connectionPath, type RoutedProfile } from '../scripts/profile-routing.mjs';
import { captureAppEntryInputs, readAppEntryInputs } from '../scripts/app-entry-inputs.mjs';
import { restoreApp } from '../src/app-launch.js';
import { atomicWriteJson } from '../src/storage.js';

const { handlePrompt, selectLaunchRequest, hookReply } = await import(new URL('../scripts/rebalance-hook.mjs', import.meta.url).href);
const sessionId = 'hook-selection-fixture';
const walletA = `0x${'a'.repeat(40)}`, walletB = `0x${'b'.repeat(40)}`;
const publicResult = (value: { hookSpecificOutput: { additionalContext: string } }) => {
  const context = value.hookSpecificOutput.additionalContext;
  return JSON.parse(context.slice(context.indexOf('\n') + 1));
};
async function fixture(t: TestContext, count = 2, legacy = true) {
  const repository = await realpath(await mkdtemp(join(tmpdir(), 'rebalance-hook-selection-')));
  const rootDir = join(repository, '.local');
  const previous = process.env.REBALANCE_ROOT_DIR; process.env.REBALANCE_ROOT_DIR = rootDir;
  t.after(async () => {
    if (previous === undefined) delete process.env.REBALANCE_ROOT_DIR;
    else process.env.REBALANCE_ROOT_DIR = previous;
    await rm(repository, { recursive: true, force: true });
  });
  await atomicWriteJson(join(rootDir, 'portfolios.json'), { version: 1, profiles: [
    { wallet: walletA, chainId: 4663, directory: '.', chartPort: 4663 },
    { wallet: walletB, chainId: 4663, directory: `wallets/${walletB}`, chartPort: 4664 },
  ].slice(0, count) });
  const input = { hook_event_name: 'UserPromptSubmit', prompt: '$rebalance', permission_mode: 'default',
    session_id: sessionId, turn_id: 'original-selection-request', cwd: repository };
  const selected = selectLaunchRequest(input, repository);
  const path = join(rootDir, 'hook-routes', `${selected.requestId}.json`);
  if (legacy) await atomicWriteJson(path, { version: 1, requestId: selected.requestId, sessionId, selectionRequired: true });
  const profile = { wallet: walletB, rootDir, dataDir: join(rootDir, 'wallets', walletB), chartPort: 4664 };
  return { repository, rootDir, input, path, profile,
    connect: () => atomicWriteJson(connectionPath(rootDir, sessionId), { version: 1, chainId: 4663, wallet: walletB }),
    dependencies: { repository, ensureDependencies: async () => {}, runView: async () => undefined,
      runRecovery: () => assert.fail('selection must never invoke transaction recovery') },
  };
}
async function until(condition: () => boolean) {
  for (let i = 0; i < 500; i++) { if (condition()) return; await delay(2); }
  assert.fail('Fixture did not settle');
}

test('a completed selection-only native invocation cannot acquire fresh launch authority after wallet attachment and a newer stop', async t => {
  const f = await fixture(t);
  let stopReads = 0, launches = 0, restores = 0;
  const stopped = { requestedAt: '2026-09-07T12:00:00.000Z', token: 'newer-fixture-stop' };
  const expectedStop = createHash('sha256').update(JSON.stringify(stopped)).digest('hex');
  const options = { ...f.dependencies,
    runRestore: async () => { restores++; return { app: 'Rebalance', outcome: 'ready', status: null, messages: [] }; },
    readStopToken: async (_root: string, profile: typeof f.profile) => {
      stopReads++; assert.equal(profile.wallet, walletB);
      assert.deepEqual(JSON.parse(await readFile(join(profile.dataDir, 'stop.json'), 'utf8')), stopped);
      return expectedStop;
    },
    runLaunch: async (_root: string, _id: string, stop: string, profile: typeof f.profile) => {
      launches++; assert.equal(stop, expectedStop); assert.equal(profile.wallet, walletB);
      return { app: 'Rebalance', outcome: 'fixture-launch-only', status: { armed: false }, messages: [] };
    },
  };
  assert.equal(publicResult(await handlePrompt(f.input, options)).outcome, 'select-portfolio');
  const terminal = await readFile(f.path, 'utf8');
  assert.equal((await stat(f.path)).mode & 0o777, 0o600);
  await f.connect();
  await atomicWriteJson(join(f.profile.dataDir, 'stop.json'), stopped);
  const replay = publicResult(await handlePrompt(f.input, options));
  assert.equal(replay.outcome, 'select-portfolio');
  assert.equal(stopReads, 0, 'an old selection-only request must not reinterpret a newer stop token');
  assert.equal(launches, 0, 'wallet selection is an attachment action, not a replayed launch');
  assert.equal(await readFile(f.path, 'utf8'), terminal);
  assert.deepEqual(JSON.parse(await readFile(join(f.profile.dataDir, 'stop.json'), 'utf8')), stopped);
  const fresh = publicResult(await handlePrompt({ ...f.input, turn_id: 'fresh-native-launch-request' }, options));
  assert.equal(fresh.outcome, 'ready'); assert.equal(restores, 1); assert.equal(stopReads, 0); assert.equal(launches, 0);
});

test('selection is durable before companion preparation and concurrent replays cannot replace it with a wallet route', async t => {
  const f = await fixture(t);
  let preparingView = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
  const forbidden = { readStopToken: () => assert.fail('terminal selection must not read stop state'),
    runLaunch: () => assert.fail('terminal selection must not invoke launcher') };
  const first = handlePrompt(f.input, { ...f.dependencies, ...forbidden,
    runView: async () => { preparingView = true; await gate; return undefined; },
  });
  await until(() => preparingView);
  const terminal = await readFile(f.path, 'utf8');
  await f.connect();
  const second = publicResult(await handlePrompt(f.input, { ...f.dependencies, ...forbidden,
    resolveProfile: () => assert.fail('the winning terminal record must be consulted before resolving a new profile'),
  }));
  assert.equal(second.outcome, 'select-portfolio'); assert.equal(await readFile(f.path, 'utf8'), terminal);
  release(); assert.equal(publicResult(await first).outcome, 'select-portfolio');
  assert.equal(await readFile(f.path, 'utf8'), terminal);
});

test('failed companion presentation cannot erase the terminal selection decision', async t => {
  const f = await fixture(t);
  const forbidden = { readStopToken: () => assert.fail('must not read stop'), runLaunch: () => assert.fail('must not launch') };
  const first = publicResult(await handlePrompt(f.input, { ...f.dependencies, ...forbidden,
    runView: async () => { throw new Error('fixture presentation unavailable'); },
  }));
  assert.equal(first.outcome, 'select-portfolio'); assert.equal(first.view.state, 'unavailable');
  const terminal = await readFile(f.path, 'utf8');
  await f.connect();
  assert.equal(publicResult(await handlePrompt(f.input, { ...f.dependencies, ...forbidden })).outcome, 'select-portfolio');
  assert.equal(await readFile(f.path, 'utf8'), terminal);
});


test('new native entries restore saved running intent independently of wallet count and present only the returned linked view', async t => {
  for (const count of [0, 1, 2]) await t.test(`${count} portfolios`, async t => {
    const f = await fixture(t, count, false);
    const view = { state: 'ready', url: `http://127.0.0.1:4663/#view=${'a'.repeat(64)}`, connected: true, tradingChanged: false };
    const calls: string[] = [];
    const result = publicResult(await handlePrompt(f.input, { ...f.dependencies,
      resolveProfile: () => assert.fail('new app entry must not select a trading wallet from chat attachment'),
      readStopToken: () => assert.fail('the restoration journal snapshots each eligible wallet stop token'),
      runLaunch: () => assert.fail('new app entry must not use the legacy wallet launcher'),
      runView: () => assert.fail('restoration already prepared the view'),
      ensureDependencies: async () => { calls.push('dependencies'); },
      runRestore: async (root: string, id: string, session: string) => {
        assert.equal(root, f.repository); assert.equal(session, sessionId);
        assert.equal(id, selectLaunchRequest(f.input, f.repository).requestId);
        calls.push('restore'); return { app: 'Rebalance', outcome: 'ready', status: null, restorationResults: [], view,
          messages: ['Choose a portfolio to open.'] };
      },
      openView: async (request: { url: string; sessionId: string }) => {
        assert.equal(request.url, view.url); assert.equal(request.sessionId, sessionId);
        calls.push('open'); return { opened: true, host: 'fixture' };
      },
    }));
    assert.equal(result.outcome, 'ready'); assert.equal(result.status, null);
    assert.deepEqual(result.view, { ...view, presentation: { opened: true, host: 'fixture' } });
    assert.deepEqual(calls, ['dependencies', 'restore', 'open']);
    await assert.rejects(readFile(f.path), { code: 'ENOENT' });
    await assert.rejects(readFile(connectionPath(f.rootDir, sessionId)), { code: 'ENOENT' });
  });
});

test('new and replayed app requests keep the native identity and delegate durable deduplication without legacy routing', async t => {
  const f = await fixture(t, 2, false), selected = selectLaunchRequest(f.input, f.repository);
  const journal = join(f.rootDir, 'app-launch-requests', `${createHash('sha256').update(selected.requestId).digest('hex')}.json`);
  const record = { fixture: 'immutable restoration snapshot' };
  await atomicWriteJson(journal, record); await f.connect();
  const options = { ...f.dependencies,
    resolveProfile: () => assert.fail('app journal replays cannot acquire chat wallet authority'),
    readStopToken: () => assert.fail('hook cannot replace a snapshotted stop token'),
    runLaunch: () => assert.fail('app restore is distinct from legacy per-wallet launch'),
    runRestore: async (_root: string, id: string, session: string) => {
      assert.equal(id, selected.requestId); assert.equal(session, sessionId);
      return { app: 'Rebalance', outcome: 'already-handled', status: null, restorationResults: [], messages: [] };
    },
  };
  assert.equal(publicResult(await handlePrompt(f.input, options)).outcome, 'already-handled');
  assert.deepEqual(JSON.parse(await readFile(journal, 'utf8')), record);
  await assert.rejects(readFile(f.path), { code: 'ENOENT' });
});

test('restoration dispatch failure is uncertain and never leaks or falls back; presentation failure preserves the actual result', async t => {
  const f = await fixture(t, 0, false);
  const forbidden = { ...f.dependencies, runLaunch: () => assert.fail('must not launch a fallback'),
    runView: () => assert.fail('must not prepare another view'), readStopToken: () => assert.fail('must not reread stop') };
  const failed = publicResult(await handlePrompt(f.input, { ...forbidden,
    runRestore: async () => { throw new Error('fixture-secret-subprocess-output'); },
    openView: () => assert.fail('unknown restore has no view to open'),
  }));
  assert.equal(failed.outcome, 'starting'); assert.equal(failed.phase, 'restore'); assert.equal(failed.status, null);
  assert.doesNotMatch(JSON.stringify(failed), /fixture-secret|armed.*false/);
  const result = { app: 'Rebalance', outcome: 'partial', status: null, restorationResults: [], messages: ['One portfolio needs attention.'],
    view: { state: 'ready', url: `http://127.0.0.1:4663/#view=${'a'.repeat(64)}` } };
  const presented = publicResult(await handlePrompt(f.input, { ...forbidden, runRestore: async () => result,
    openView: async () => { throw new Error('fixture-secret-host-error'); },
  }));
  assert.equal(presented.outcome, 'partial'); assert.deepEqual(presented.messages, result.messages);
  assert.equal(presented.view.presentation.opened, false); assert.doesNotMatch(JSON.stringify(presented), /fixture-secret/);
});


test('native bootstrap freezes eligible inputs before newly enabled, newly registered, and Stop-then-Start wallets can enter restoration', async t => {
  const f = await fixture(t, 2, false);
  const walletC = `0x${'c'.repeat(40)}`, walletD = `0x${'d'.repeat(40)}`;
  const profiles = [
    { wallet: walletA, chainId: 4663, directory: '.', chartPort: 4663 },
    { wallet: walletB, chainId: 4663, directory: `wallets/${walletB}`, chartPort: 4664 },
    { wallet: walletC, chainId: 4663, directory: `wallets/${walletC}`, chartPort: 4665 },
  ];
  const pref = (wallet: string, enabled: boolean) => ({ version: 1, wallet, chainId: 4663, enabled, generation: randomUUID() });
  const dirs = { [walletA]: f.rootDir, [walletB]: join(f.rootDir, 'wallets', walletB),
    [walletC]: join(f.rootDir, 'wallets', walletC), [walletD]: join(f.rootDir, 'wallets', walletD) };
  await atomicWriteJson(join(f.rootDir, 'portfolios.json'), { version: 1, profiles });
  for (const wallet of [walletA, walletB, walletC]) await atomicWriteJson(join(dirs[wallet], 'runner-preference.json'), pref(wallet, wallet !== walletB));
  const selected = selectLaunchRequest(f.input, f.repository), calls: string[] = [], launched: string[] = [];
  let frozen = '', bootstraps = 0;
  const snapshotPath = join(f.rootDir, 'app-entry-inputs', `${createHash('sha256').update(selected.requestId).digest('hex')}.json`);
  const options = { ...f.dependencies,
    captureAppEntryInputs: async (root: string, id: string, session: string) => {
      calls.push('snapshot'); return captureAppEntryInputs(root, id, session);
    },
    ensureDependencies: async () => {
      calls.push('dependencies');
      const snapshot = await readAppEntryInputs(f.rootDir, selected.requestId, sessionId);
      assert.deepEqual(snapshot!.entries.map(entry => entry.profile.wallet), [walletA, walletB, walletC]);
      const current = await readFile(snapshotPath, 'utf8'); if (frozen) assert.equal(current, frozen); else frozen = current;
      if (++bootstraps > 1) return;
      await atomicWriteJson(join(dirs[walletB], 'runner-preference.json'), pref(walletB, true));
      await atomicWriteJson(join(dirs[walletC], 'stop.json'), { requestId: 'newer-user-stop' });
      await atomicWriteJson(join(dirs[walletC], 'runner-preference.json'), pref(walletC, false));
      await atomicWriteJson(join(dirs[walletC], 'runner-preference.json'), pref(walletC, true));
      await rm(join(dirs[walletC], 'stop.json'));
      await atomicWriteJson(join(dirs[walletD], 'runner-preference.json'), pref(walletD, true));
      await atomicWriteJson(join(f.rootDir, 'portfolios.json'), { version: 1, profiles: [...profiles,
        { wallet: walletD, chainId: 4663, directory: `wallets/${walletD}`, chartPort: 4666 }] });
    },
    runRestore: async (_repository: string, id: string, session: string) => {
      calls.push('restore');
      return restoreApp(f.rootDir, session, { requestId: id }, {
        view: async () => ({ state: 'ready', url: `http://127.0.0.1:4663/#view=${'a'.repeat(64)}`, connected: true, tradingChanged: false }),
        launch: async (profile: RoutedProfile) => { launched.push(profile.wallet!); return {
          app: 'Rebalance', outcome: 'armed', status: { armed: true, wallet: profile.wallet, chain: { id: 4663 } }, messages: [],
        }; },
      });
    },
    readStopToken: () => assert.fail('the hook must not create fresh per-wallet launch authority'),
    runLaunch: () => assert.fail('new requests restore through the app journal'),
    runView: () => assert.fail('restoration already prepared a view'),
  };
  const result = publicResult(await handlePrompt(f.input, options));
  assert.equal(result.outcome, 'ready'); assert.deepEqual(launched, [walletA]);
  assert.deepEqual(result.restorationResults.map((entry: {wallet: string}) => entry.wallet), [walletA, walletB, walletC]);
  assert.deepEqual(result.restorationResults.map((entry: {result: {outcome: string}}) => entry.result.outcome), ['armed', 'not-requested', 'not-requested']);
  assert.deepEqual(calls, ['snapshot', 'dependencies', 'restore']);
  assert.equal(publicResult(await handlePrompt(f.input, options)).outcome, 'already-handled');
  assert.deepEqual(launched, [walletA]); assert.equal(await readFile(snapshotPath, 'utf8'), frozen);
});

test('input snapshot failure blocks before dependency work, view preparation, or restoration with fixed public context', async t => {
  const f = await fixture(t, 0, false);
  const result = publicResult(await handlePrompt(f.input, { ...f.dependencies,
    captureAppEntryInputs: async () => { throw new Error('fixture-secret-snapshot-error'); },
    ensureDependencies: () => assert.fail('snapshot must precede dependencies'),
    runRestore: () => assert.fail('no restoration without a frozen input receipt'),
    runView: () => assert.fail('no view work on failed snapshot'), runLaunch: () => assert.fail('no legacy fallback'),
  }));
  assert.equal(result.outcome, 'blocked'); assert.equal(result.phase, 'snapshot'); assert.equal(result.status, null);
  assert.match(result.messages[0], /no restoration was attempted/); assert.doesNotMatch(JSON.stringify(result), /fixture-secret/);
});


test('app handoff opens a ready linked view before replying and does not duplicate a native pane or reinterpret restoration as inventory', () => {
  const view = { state: 'ready', url: `http://127.0.0.1:4663/#view=${'a'.repeat(64)}`, connected: true };
  const result = { app: 'Rebalance', outcome: 'ready', restoration: 'checked', restorationResults: [], view };
  const reply = hookReply(result);
  assert.deepEqual(publicResult(reply), result);
  assert.match(reply.hookSpecificOutput.additionalContext, /Before replying, open the exact returned view.url/);
  assert.match(reply.hookSpecificOutput.additionalContext, /open_in_codex with placement right/);
  assert.match(reply.hookSpecificOutput.additionalContext, /empty results array never establishes an empty registry/);
  const opened = hookReply({ ...result, view: { ...view, presentation: { opened: true, host: 'fixture' } } });
  assert.match(opened.hookSpecificOutput.additionalContext, /Reuse the browser pane already opened/);
  assert.doesNotMatch(opened.hookSpecificOutput.additionalContext, /Before replying, open/);
  const denied = { ...result, outcome: 'partial', view: { state: 'unavailable', code: 'local-access-denied' } };
  const unavailable = hookReply(denied);
  assert.deepEqual(publicResult(unavailable), denied);
  assert.match(unavailable.hookSpecificOutput.additionalContext, /Retry only the read-only view command/);
  assert.doesNotMatch(unavailable.hookSpecificOutput.additionalContext, /Before replying, open/);
  const unknown = hookReply({ ...denied, view: { state: 'unavailable', code: 'unavailable' } });
  assert.doesNotMatch(unknown.hookSpecificOutput.additionalContext, /Retry only the read-only view command/);
});
