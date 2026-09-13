import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { connectionPath } from '../scripts/profile-routing.mjs';
import { atomicWriteJson, readJson } from '../src/storage.js';

const execute = promisify(execFile);
const repository = fileURLToPath(new URL('..', import.meta.url));
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const walletA = `0x${'a'.repeat(40)}`, walletB = `0x${'b'.repeat(40)}`;
const session = 'cli-selector-fixture';
async function fixture(t: TestContext, count: number) {
  const root = await mkdtemp(join(tmpdir(), 'rebalance-cli-selector-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await atomicWriteJson(join(root, 'portfolios.json'), { version: 1, profiles: [
    { wallet: walletA, chainId: 4663, directory: '.', chartPort: 4663 },
    { wallet: walletB, chainId: 4663, directory: `wallets/${walletB}`, chartPort: 4664 },
  ].slice(0, count) });
  // Execute real CLI argument/routing code, replacing only the service boundaries.
  // Any accidental application import is rejected before RPC, signer or runner code.
  const preload = join(root, 'boundary-fixture.mjs');
  await writeFile(preload, `
    import { registerHooks } from 'node:module';
    const view = ${JSON.stringify(new URL('../src/app-launch.ts', import.meta.url).href)};
    const commands = ${JSON.stringify(new URL('../src/commands.ts', import.meta.url).href)};
    const cli = ${JSON.stringify(new URL('../src/cli.ts', import.meta.url).href)};
    registerHooks({ resolve(specifier, context, nextResolve) {
      if (context.parentURL === cli && specifier === './app-launch.js') return { url: view, shortCircuit: true };
      if (context.parentURL === cli && specifier === './commands.js') return { url: commands, shortCircuit: true };
      return nextResolve(specifier, context);
    }, load(url, context, nextLoad) {
      if (url === view) return { format: 'module', shortCircuit: true, source:
        "export async function restoreApp(root, session, options) { return { app: 'Rebalance', boundary: 'restore', outcome: 'ready', status: null, restorationResults: [], restoration: 'not-requested', messages: ['Choose a portfolio to open.'], view: { state: 'ready', url: 'http://127.0.0.1:4663/#view=' + 'a'.repeat(64), connected: Boolean(session) }, fixture: { root, session, options } }; }" };
      if (url === commands) return { format: 'module', shortCircuit: true, source:
        "process.stdout.write(JSON.stringify({ boundary: 'commands', args: process.argv.slice(2), wallet: process.env.REBALANCE_PROFILE_WALLET, dataDir: process.env.REBALANCE_DATA_DIR }));" };
      if (url.includes('/src/') && url !== cli && !url.endsWith('/src/view-error.ts')) throw new Error('Unexpected application import in isolated CLI routing fixture');
      return nextLoad(url, context);
    } });
  `);
  const env: NodeJS.ProcessEnv = { ...process.env, REBALANCE_ROOT_DIR: root, REBALANCE_DATA_DIR: root,
    NODE_OPTIONS: `--import=${preload}` };
  for (const name of ['REBALANCE_PROFILE_PINNED', 'REBALANCE_PROFILE_WALLET', 'REBALANCE_CHART_PORT',
    'REBALANCE_SESSION_ID', 'CODEX_THREAD_ID', 'CLAUDE_CODE_SESSION_ID', 'REBALANCE_PRIVATE_KEY']) delete env[name];
  const command = (args: string[], extra: NodeJS.ProcessEnv = {}) => execute(process.execPath, ['--import', 'tsx', cli, ...args], {
    cwd: repository, env: { ...env, ...extra }, timeout: 10_000,
  });
  return { root, command };
}

test('bare full and setup-only CLI launch enter app restoration for zero, one or several portfolios', async t => {
  for (const count of [0, 1, 2]) await t.test(`${count} portfolios`, async t => {
    const f = await fixture(t, count);
    for (const args of [['launch'], ['launch', '--setup-only']]) {
      const result = JSON.parse((await f.command([...args, '--session', session])).stdout);
      assert.equal(result.boundary, 'restore'); assert.equal(result.outcome, 'ready'); assert.equal(result.status, null);
      assert.deepEqual(result.messages, ['Choose a portfolio to open.']);
      assert.equal(result.view.connected, true);
      assert.deepEqual(result.fixture, { root: f.root, session, options: { setupOnly: args.includes('--setup-only') } });
      assert.match(result.view.url, /^http:\/\/127\.0\.0\.1:4663\/#view=[a-f0-9]{64}$/);
    }
    assert.equal(await readJson(connectionPath(f.root, session)), null);
    assert.deepEqual((await readdir(f.root)).sort(), ['boundary-fixture.mjs', 'portfolios.json']);
  });
});

test('saved attachment does not scope app restoration; explicit, pinned and named commands retain wallet routing', async t => {
  const f = await fixture(t, 2);
  await atomicWriteJson(connectionPath(f.root, session), { version: 1, chainId: 4663, wallet: walletB });
  for (const args of [['launch', '--session', session], ['launch', '--setup-only', '--session', session],
    ['launch', '--restore', '--request-id', 'fixture-native-request', '--session', session]]) {
    const result = JSON.parse((await f.command(args)).stdout);
    assert.equal(result.boundary, 'restore'); assert.equal(result.fixture.session, session);
    if (args.includes('--restore')) assert.equal(result.fixture.options.requestId, 'fixture-native-request');
  }
  for (const [args, wallet, extra] of [
    [['launch', '--session', session, '--profile', walletA], walletA, {}],
    [['launch', '--profile', walletA], walletA, {}],
    [['launch', '--session', session], walletA, { REBALANCE_PROFILE_PINNED: '1', REBALANCE_PROFILE_WALLET: walletA }],
  ] as [string[], string, NodeJS.ProcessEnv][]) {
    const result = JSON.parse((await f.command(args, extra)).stdout);
    assert.equal(result.boundary, 'commands'); assert.equal(result.wallet, wallet);
  }
  await rm(connectionPath(f.root, session));
  await atomicWriteJson(join(f.root, 'portfolios.json'), { version: 1, profiles: [
    { wallet: walletA, chainId: 4663, directory: '.', chartPort: 4663 },
  ] });
  for (const args of [['launch', '--targets', 'fixture-targets'], ['launch', '--request-id', 'fixture-request'], ['status'], ['configure']]) {
    const result = JSON.parse((await f.command(args)).stdout);
    assert.equal(result.boundary, 'commands'); assert.equal(result.wallet, walletA); assert.deepEqual(result.args, args);
  }
  const all = JSON.parse((await f.command(['launch', '--all', '--setup-only'])).stdout);
  assert.equal(all.portfolios.length, 1); assert.equal(all.portfolios[0].result.wallet, walletA);
  assert.equal(all.portfolios[0].result.boundary, 'commands');
});

test('restoration leaves chat attachment validation to the view while explicit and malformed restoration scopes remain errors', async t => {
  const f = await fixture(t, 1);
  const path = connectionPath(f.root, session);
  for (const connection of [{ version: 2, chainId: 4663, wallet: walletA },
    { version: 1, chainId: 4663, wallet: 'invalid' }, { version: 1, chainId: 4663, wallet: walletB }]) {
    await atomicWriteJson(path, connection); const before = await readFile(path, 'utf8');
    assert.equal(JSON.parse((await f.command(['launch', '--session', session])).stdout).boundary, 'restore');
    assert.equal(await readFile(path, 'utf8'), before);
  }
  await assert.rejects(f.command(['launch', '--profile', walletB]));
  for (const args of [['launch', '--restore', '--profile', walletA], ['launch', '--restore', '--targets', 'fixture'],
    ['launch', '--restore', '--restore'], ['status', '--restore'], ['launch', '--restore', '--request-id']]) {
    await assert.rejects(f.command(args));
  }
  await assert.rejects(f.command(['launch', '--restore'], { REBALANCE_PROFILE_PINNED: '1' }));
});


test('real view probes preserve EPERM and EACCES through app entry and the direct CLI sanitizer', async t => {
 for (const code of ['EPERM', 'EACCES']) await t.test(code, async t => {
  const f = await fixture(t, 2);
  const preload = join(f.root, 'denied-network-fixture.mjs');
  await writeFile(preload, `
   import http from 'node:http';
   import child from 'node:child_process';
   import {EventEmitter} from 'node:events';
   import {syncBuiltinESMExports} from 'node:module';
   import {writeFileSync} from 'node:fs';
   http.get = () => {
    const request = new EventEmitter();
    request.setTimeout = () => request;
    request.destroy = () => request.emit('close');
    process.nextTick(() => request.emit('error', Object.assign(new Error('fixture-private-network-payload'), {code:${JSON.stringify(code)}})));
    return request;
   };
   child.execFile = () => {
    writeFileSync(${JSON.stringify(join(f.root, 'unexpected-chart-spawn'))}, 'spawn attempted');
    throw new Error('fixture unexpected child process');
   };
   syncBuiltinESMExports();
  `);
  const extra = {NODE_OPTIONS:`--import=${preload}`};
  await assert.rejects(f.command(['view','--session',session],extra), error => {
   const result = JSON.parse((error as {stderr:string}).stderr);
   assert.deepEqual(result,{error:'This process cannot access the local chart listener.',code:'local-access-denied'});
   return true;
  });
  const result = JSON.parse((await f.command(['launch','--setup-only','--session',session],extra)).stdout);
  assert.equal(result.outcome,'partial'); assert.equal(result.restoration,'not-requested');
  assert.deepEqual(result.restorationResults,[]); assert.equal('portfolios' in result,false);
  assert.deepEqual(result.view,{state:'unavailable',code:'local-access-denied',message:'This process cannot access the local chart listener.'});
  assert.deepEqual((await readdir(f.root)).sort(),['boundary-fixture.mjs','denied-network-fixture.mjs','portfolios.json']);
  assert.equal((await readJson<{profiles:unknown[]}>(join(f.root,'portfolios.json')))!.profiles.length,2);
 });
});
