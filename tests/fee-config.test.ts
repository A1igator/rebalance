import { assertTemporaryTestDirectory } from '../src/test-isolation.js';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { withAllocation } from '../src/allocation-management.js';
import { validateConfig } from '../src/config.js';
import { addPortfolio, connectPortfolio } from '../src/profiles.js';
import { acquireLock, atomicWriteJson, readJson } from '../src/storage.js';

const execute = promisify(execFile);
const repository = fileURLToPath(new URL('..', import.meta.url));
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const one = '0x0000000000000000000000000000000000000001';
const two = '0x0000000000000000000000000000000000000002';
const targets = { USDG: 500, AAPL: 2375, NVDA: 2375, MSFT: 2375, AMD: 2375 };
const configuration = (wallet: string = one) => validateConfig({
  version: 1, chainId: 4663, wallet, mode: 'private-key', rpcUrl: 'http://fee-config-fixture.invalid', targets,
  driftThresholdBps: 500, slippageBps: 50, deadlineSeconds: 120, pollSeconds: 30, rebalanceIntervalSeconds: 3600,
});

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'rebalance-fee-config-'));
  assertTemporaryTestDirectory(root);
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  await atomicWriteJson(join(root, 'config.json'), configuration());
  const preload = join(root, 'offline.mjs');
  await writeFile(preload, `import {existsSync,writeFileSync} from 'node:fs'; import {join,basename} from 'node:path';
import filesystem from 'node:fs/promises'; import {syncBuiltinESMExports} from 'node:module';
const originalOpen=filesystem.open;
filesystem.open=async function(path,...args){
  if(process.env.REBALANCE_TEST_CONFIG_WAIT && basename(String(path))==='config.lock' && args[0]==='wx') {
    const marker=join(process.env.REBALANCE_DATA_DIR,'config-attempt-'+process.env.REBALANCE_TEST_CONFIG_WAIT);
    if(!existsSync(marker))writeFileSync(marker,'attempted');
  }
  return originalOpen.call(this,path,...args);
};
syncBuiltinESMExports();
globalThis.fetch=async()=>{writeFileSync(join(process.env.REBALANCE_DATA_DIR,'unexpected-network'),'blocked');throw new Error('Fee config fixture network is disabled');};`);
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of ['REBALANCE_PRIVATE_KEY', 'REBALANCE_SESSION_ID', 'CODEX_THREAD_ID', 'REBALANCE_PROFILE_WALLET', 'REBALANCE_CHART_PORT']) delete env[name];
  Object.assign(env, { REBALANCE_ROOT_DIR: root, REBALANCE_DATA_DIR: root,
    REBALANCE_PROFILE_PINNED: '1', REBALANCE_PROFILE_WALLET: one, NODE_OPTIONS: `--import=${preload}` });
  const command = (args: string[], extra: NodeJS.ProcessEnv = {}) => execute(process.execPath,
    ['--import', 'tsx', cli, ...args], { cwd: repository, env: { ...env, ...extra }, timeout: 15_000 });
  const saved = (directory = root) => readJson<Record<string, any>>(join(directory, 'config.json'));
  const bytes = (directory = root) => readFile(join(directory, 'config.json'), 'utf8');
  const isolated = (...directories: string[]) => {
    for (const directory of directories.length ? directories : [root]) {
      for (const file of ['unexpected-network', 'private-key', 'wallet.json', 'run.lock', 'chart.lock', 'start.log', 'chart.log']) {
        assert.equal(existsSync(join(directory, file)), false, file);
      }
    }
  };
  return { root, command, saved, bytes, isolated };
}

test('fee commands preserve public allocation, cadence and pending records without signer or network access', async t => {
  const f = await fixture(t);
  const managed = withAllocation(configuration(), {
    version: 1, objective: 'user-risk', horizonMonths: 60, stepBps: 500, benchmarkReturnBps: 0,
    assets: Object.fromEntries(Object.keys(targets).map(id => [id,
      { riskScore: id === 'USDG' ? 2 : 40, expectedReturnBps: id === 'USDG' ? 0 : 500,
        minBps: id === 'USDG' ? 500 : 0, maxBps: id === 'USDG' ? 500 : 4000 }])),
  });
  await atomicWriteJson(join(f.root, 'config.json'), managed);
  const records = { 'cycle.json': { startedAt: 1000, activeUntil: 601000, nextEligibleAt: 3601000 },
    'pending.json': { fixture: 'unresolved-operation' }, 'stop.json': { requestId: 'preserve-stop' } };
  for (const [name, value] of Object.entries(records)) await atomicWriteJson(join(f.root, name), value);
  const before = await f.bytes();
  const unset = JSON.parse((await f.command(['fees', 'status'])).stdout);
  assert.equal(unset.rebalanceFeeTargetUsdE8, null); assert.equal(unset.targetUsd, null);
  assert.equal(await f.bytes(), before);
  const result = JSON.parse((await f.command(['fees', 'target', '0.05'])).stdout);
  assert.equal(result.wallet.toLowerCase(), one); assert.equal(result.chainId, 4663);
  assert.equal(result.rebalanceFeeTargetUsdE8, '5000000'); assert.equal(result.targetUsd, '0.05');
  assert.match(result.description, /estimates are not guaranteed/);
  assert.deepEqual(await f.saved(), { ...managed, rebalanceFeeTargetUsdE8: '5000000' });
  const statusBytes = await f.bytes();
  assert.deepEqual(JSON.parse((await f.command(['fees', 'status'])).stdout), result);
  assert.equal(await f.bytes(), statusBytes);
  const cleared = JSON.parse((await f.command(['fees', 'clear'])).stdout);
  assert.equal(cleared.rebalanceFeeTargetUsdE8, null); assert.equal(cleared.targetUsd, null);
  assert.deepEqual(await f.saved(), managed);
  for (const [name, value] of Object.entries(records)) assert.deepEqual(await readJson(join(f.root, name)), value);
  f.isolated();
});

test('zero fee target remains explicit through configure and allocation edits', async t => {
  const f = await fixture(t);
  const zero = JSON.parse((await f.command(['fees', 'target', '0'])).stdout);
  assert.equal(zero.rebalanceFeeTargetUsdE8, '0'); assert.equal(zero.targetUsd, '0');
  await f.command(['configure', '--rebalance-interval-seconds', '7200', '--slippage', '0.75']);
  const configured = (await f.saved())!;
  assert.equal(configured.rebalanceFeeTargetUsdE8, '0'); assert.equal(configured.rebalanceIntervalSeconds, 7200);
  assert.equal(configured.slippageBps, 75); assert.deepEqual(configured.targets, targets);
  await f.command(['targets', 'set', 'USDG', '10']);
  assert.equal((await f.saved())!.rebalanceFeeTargetUsdE8, '0');
  assert.equal((await f.saved())!.targets.USDG, 1000);
  assert.equal((await f.saved())!.rebalanceIntervalSeconds, 7200);
  const maximum = JSON.parse((await f.command(['fees', 'target', '999999999999.99999999'])).stdout);
  assert.equal(maximum.targetUsd, '999999999999.99999999');
  assert.equal(maximum.rebalanceFeeTargetUsdE8, '99999999999999999999');
  f.isolated();
});

test('invalid fee command arguments never change configuration', async t => {
  const f = await fixture(t);
  await f.command(['fees', 'target', '0.05']); const before = await f.bytes();
  for (const args of [
    ['fees', 'target'], ['fees', 'target', '1e2'], ['fees', 'target', '0.000000001'],
    ['fees', 'target', '1000000000000'], ['fees', 'clear', 'extra'], ['fees', 'status', 'extra'],
    ['fees', 'target', '0.10', '--wallet', two], ['fees', 'clear', '--background'],
  ]) {
    await assert.rejects(f.command(args), error => error instanceof Error, args.join(' '));
    assert.equal(await f.bytes(), before, args.join(' '));
  }
  f.isolated();
});

test('fee mutations wait for the short configuration boundary while status stays read-only', async t => {
  const f = await fixture(t); const before = await f.bytes();
  const release = await acquireLock(f.root, 'config.lock');
  t.after(release);
  const editing = f.command(['fees', 'target', '0.05'], { REBALANCE_TEST_CONFIG_WAIT: 'fee' });
  const completed = editing.then(() => true, () => true);
  await until(() => existsSync(join(f.root, 'config-attempt-fee')));
  assert.equal(await f.bytes(), before);
  assert.equal(await Promise.race([completed, delay(50).then(() => false)]), false);
  assert.equal(JSON.parse((await f.command(['fees', 'status'])).stdout).rebalanceFeeTargetUsdE8, null);
  await release(); await editing;
  assert.equal((await f.saved())!.rebalanceFeeTargetUsdE8, '5000000');
  f.isolated();
});

test('fee targets stay with the selected wallet across chat attachment and explicit profile changes', async t => {
  const f = await fixture(t); const second = await addPortfolio(f.root, configuration(two));
  const routed = { REBALANCE_PROFILE_PINNED: '', REBALANCE_PROFILE_WALLET: '' };
  const secondBefore = await f.bytes(second.dataDir);
  await f.command(['fees', 'target', '0.05', '--profile', one], routed);
  assert.equal(await f.bytes(second.dataDir), secondBefore);
  await connectPortfolio(f.root, 'fee-config-chat', two);
  const selected = JSON.parse((await f.command(['fees', 'status', '--session', 'fee-config-chat'], routed)).stdout);
  assert.equal(selected.wallet.toLowerCase(), two); assert.equal(selected.rebalanceFeeTargetUsdE8, null);
  const firstBefore = await f.bytes();
  await f.command(['fees', 'target', '0.10', '--session', 'fee-config-chat'], routed);
  assert.equal((await f.saved(second.dataDir))!.rebalanceFeeTargetUsdE8, '10000000');
  assert.equal(await f.bytes(), firstBefore);
  const secondConfigured = await f.bytes(second.dataDir);
  await f.command(['fees', 'clear', '--profile', one, '--session', 'fee-config-chat'], routed);
  assert.equal((await f.saved())!.rebalanceFeeTargetUsdE8, undefined);
  assert.equal(await f.bytes(second.dataDir), secondConfigured);
  f.isolated(f.root, second.dataDir);
});


async function until(condition: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, 'Fixture command did not reach its configuration lock');
    await delay(10);
  }
}

test('concurrent settings writers preserve each other and read changes made before lock release', async t => {
  const f = await fixture(t); const release = await acquireLock(f.root, 'config.lock'); t.after(release);
  const fee = f.command(['fees', 'target', '0.05'], { REBALANCE_TEST_CONFIG_WAIT: 'fee' });
  const settings = f.command(['configure', '--threshold', '7', '--deadline', '180'], { REBALANCE_TEST_CONFIG_WAIT: 'settings' });
  const complete = Promise.all([fee, settings]); complete.catch(() => {});
  await until(() => existsSync(join(f.root, 'config-attempt-fee')) && existsSync(join(f.root, 'config-attempt-settings')));
  await atomicWriteJson(join(f.root, 'config.json'), { ...configuration(), slippageBps: 99 });
  await release(); await complete;
  const saved = (await f.saved())!;
  assert.equal(saved.rebalanceFeeTargetUsdE8, '5000000'); assert.equal(saved.driftThresholdBps, 700);
  assert.equal(saved.deadlineSeconds, 180); assert.equal(saved.slippageBps, 99);
  assert.deepEqual(saved.targets, targets); f.isolated();
});

test('all ordinary configure settings and targets remain editable while active with pending recovery', async t => {
  const f = await fixture(t); const now = Date.now();
  const records = { 'pending.json': { fixture: 'unresolved-send' }, 'recovery.json': { fixture: 'retained-recovery' },
    'cycle.json': { wallet: one, startedAt: now, activeUntil: now + 600000, nextEligibleAt: now + 3600000 },
    'stop.json': { requestId: 'preserve-new-stop' } };
  for (const [name, value] of Object.entries(records)) await atomicWriteJson(join(f.root, name), value);
  const before = await Promise.all(Object.keys(records).map(name => readFile(join(f.root, name), 'utf8')));
  const release = await acquireLock(f.root); const runBytes = await readFile(join(f.root, 'run.lock'), 'utf8');
  try {
    await f.command(['fees', 'target', '0.05']);
    const changed = JSON.parse((await f.command(['configure', '--threshold', '3', '--slippage', '0.75',
      '--deadline', '240', '--poll', '45', '--rebalance-interval-seconds', '7200', '--rpc', 'http://edited-fixture.invalid',
      '--targets', 'USDG=20,AAPL=20,NVDA=20,MSFT=20,AMD=20', '--mode', 'private-key'])).stdout);
    const saved = (await f.saved())!;
    assert.equal(saved.wallet, one); assert.equal(saved.mode, 'private-key');
    assert.equal(saved.driftThresholdBps, 300); assert.equal(saved.slippageBps, 75);
    assert.equal(saved.deadlineSeconds, 240); assert.equal(saved.pollSeconds, 45);
    assert.equal(saved.rebalanceIntervalSeconds, 7200); assert.equal(saved.rebalanceFeeTargetUsdE8, '5000000');
    assert.equal(saved.rpcUrl, 'http://edited-fixture.invalid');
    assert.deepEqual(saved.targets, { USDG: 2000, AAPL: 2000, NVDA: 2000, MSFT: 2000, AMD: 2000 });
    assert.equal(changed.deadlineSeconds, 240);
    const configBytes = await f.bytes();
    for (const args of [['configure', '--deadline', '14'], ['configure', '--deadline', '601'],
      ['configure', '--wallet', two], ['configure', '--mode', 'ledger']]) {
      await assert.rejects(f.command(args)); assert.equal(await f.bytes(), configBytes);
    }
    assert.equal(await readFile(join(f.root, 'run.lock'), 'utf8'), runBytes);
    assert.deepEqual(await Promise.all(Object.keys(records).map(name => readFile(join(f.root, name), 'utf8'))), before);
  } finally { await release(); }
  const configBytes = await f.bytes();
  await assert.rejects(f.command(['configure', '--mode', 'ledger']), error => /pending operation/.test((error as { stderr: string }).stderr));
  assert.equal(await f.bytes(), configBytes);
  await rm(join(f.root, 'pending.json'));
  const changedMode = JSON.parse((await f.command(['configure', '--mode', 'ledger'])).stdout);
  assert.equal(changedMode.mode, 'ledger'); assert.equal((await f.saved())!.wallet, one);
  for (const [name, value] of Object.entries(records)) if (name !== 'pending.json') assert.deepEqual(await readJson(join(f.root, name)), value);
  f.isolated();
});
