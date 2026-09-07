import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { connectionPath } from '../scripts/profile-routing.mjs';
import { atomicWriteJson } from '../src/storage.js';

const { handlePrompt, selectLaunchRequest } = await import(new URL('../scripts/rebalance-hook.mjs', import.meta.url).href);
const sessionId = 'hook-selection-fixture';
const walletA = `0x${'a'.repeat(40)}`, walletB = `0x${'b'.repeat(40)}`;
const publicResult = (value: { hookSpecificOutput: { additionalContext: string } }) => {
  const context = value.hookSpecificOutput.additionalContext;
  return JSON.parse(context.slice(context.indexOf('\n') + 1));
};
async function fixture(t: TestContext) {
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
  ] });
  const input = { hook_event_name: 'UserPromptSubmit', prompt: '$rebalance', permission_mode: 'default',
    session_id: sessionId, turn_id: 'original-selection-request', cwd: repository };
  const selected = selectLaunchRequest(input, repository);
  const path = join(rootDir, 'hook-routes', `${selected.requestId}.json`);
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
  let stopReads = 0, launches = 0;
  const stopped = { requestedAt: '2026-09-07T12:00:00.000Z', token: 'newer-fixture-stop' };
  const expectedStop = createHash('sha256').update(JSON.stringify(stopped)).digest('hex');
  const options = { ...f.dependencies,
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
  assert.equal(publicResult(await handlePrompt(f.input, options)).outcome, 'needs-input');
  const terminal = await readFile(f.path, 'utf8');
  assert.equal((await stat(f.path)).mode & 0o777, 0o600);
  await f.connect();
  await atomicWriteJson(join(f.profile.dataDir, 'stop.json'), stopped);
  const replay = publicResult(await handlePrompt(f.input, options));
  assert.equal(replay.outcome, 'needs-input');
  assert.equal(stopReads, 0, 'an old selection-only request must not reinterpret a newer stop token');
  assert.equal(launches, 0, 'wallet selection is an attachment action, not a replayed launch');
  assert.equal(await readFile(f.path, 'utf8'), terminal);
  assert.deepEqual(JSON.parse(await readFile(join(f.profile.dataDir, 'stop.json'), 'utf8')), stopped);
  const fresh = publicResult(await handlePrompt({ ...f.input, turn_id: 'fresh-native-launch-request' }, options));
  assert.equal(fresh.outcome, 'fixture-launch-only'); assert.equal(stopReads, 1); assert.equal(launches, 1);
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
  assert.equal(second.outcome, 'needs-input'); assert.equal(await readFile(f.path, 'utf8'), terminal);
  release(); assert.equal(publicResult(await first).outcome, 'needs-input');
  assert.equal(await readFile(f.path, 'utf8'), terminal);
});

test('failed companion presentation cannot erase the terminal selection decision', async t => {
  const f = await fixture(t);
  const forbidden = { readStopToken: () => assert.fail('must not read stop'), runLaunch: () => assert.fail('must not launch') };
  const first = publicResult(await handlePrompt(f.input, { ...f.dependencies, ...forbidden,
    runView: async () => { throw new Error('fixture presentation unavailable'); },
  }));
  assert.equal(first.outcome, 'needs-input'); assert.equal(first.view.state, 'unavailable');
  const terminal = await readFile(f.path, 'utf8');
  await f.connect();
  assert.equal(publicResult(await handlePrompt(f.input, { ...f.dependencies, ...forbidden })).outcome, 'needs-input');
  assert.equal(await readFile(f.path, 'utf8'), terminal);
});
