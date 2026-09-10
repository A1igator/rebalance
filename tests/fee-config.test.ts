import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  await atomicWriteJson(join(root, 'config.json'), configuration());
  const preload = join(root, 'offline.mjs');
  await writeFile(preload, `import {writeFileSync} from 'node:fs'; import {join} from 'node:path';
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

test('fee mutations share the configuration lock while fee status stays read-only', async t => {
  const f = await fixture(t); const before = await f.bytes();
  const release = await acquireLock(f.root, 'config.lock');
  try {
    for (const args of [['fees', 'target', '0.05'], ['fees', 'clear']]) {
      await assert.rejects(f.command(args)); assert.equal(await f.bytes(), before);
    }
    assert.equal(JSON.parse((await f.command(['fees', 'status'])).stdout).rebalanceFeeTargetUsdE8, null);
    assert.equal(await f.bytes(), before);
  } finally { await release(); }
  await f.command(['fees', 'target', '0.05']);
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
