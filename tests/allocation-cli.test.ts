import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { addPortfolio, connectPortfolio } from '../src/profiles.js';
import { atomicWriteJson, readJson } from '../src/storage.js';

const execute = promisify(execFile);
const repository = fileURLToPath(new URL('..', import.meta.url));
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const one = '0x0000000000000000000000000000000000000001';
const two = '0x0000000000000000000000000000000000000002';
const targets = { USDG: 500, AAPL: 2375, NVDA: 2375, MSFT: 2375, AMD: 2375 };
const targetArgument = 'USDG=5,AAPL=23.75,NVDA=23.75,MSFT=23.75,AMD=23.75';
const configuration = (wallet: string = one) => ({
  version: 1, chainId: 4663, wallet, mode: 'ledger', rpcUrl: 'http://allocation-fixture.invalid', targets,
  driftThresholdBps: 500, slippageBps: 50, deadlineSeconds: 120, pollSeconds: 30, rebalanceIntervalSeconds: 3600,
});
const policy = (reverse = false) => ({
  version: 1, objective: 'user-risk', horizonMonths: 60, stepBps: 500, benchmarkReturnBps: 0,
  assets: Object.fromEntries(Object.keys(targets).map((id, index) => [id, id === 'USDG'
    ? { riskScore: 2, expectedReturnBps: 0, minBps: 500, maxBps: 500 }
    : { riskScore: 40, expectedReturnBps: (reverse ? index : 5 - index) * 500, minBps: 0, maxBps: 4000 }])),
});

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'rebalance-allocation-cli-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  await atomicWriteJson(join(root, 'config.json'), configuration());
  const preload = join(root, 'offline.mjs');
  await writeFile(preload, `import {writeFileSync} from 'node:fs'; import {join} from 'node:path';
globalThis.fetch=async()=>{writeFileSync(join(process.env.REBALANCE_DATA_DIR,'unexpected-network'),'blocked');throw new Error('Allocation fixture network is disabled');};`);
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of ['REBALANCE_PRIVATE_KEY', 'REBALANCE_SESSION_ID', 'CODEX_THREAD_ID', 'REBALANCE_PROFILE_WALLET', 'REBALANCE_CHART_PORT']) delete env[name];
  Object.assign(env, { REBALANCE_ROOT_DIR: root, REBALANCE_DATA_DIR: root,
    REBALANCE_PROFILE_PINNED: '1', REBALANCE_PROFILE_WALLET: one, NODE_OPTIONS: `--import=${preload}` });
  const command = (args: string[], extra: NodeJS.ProcessEnv = {}) => execute(process.execPath,
    ['--import', 'tsx', cli, ...args], { cwd: repository, env: { ...env, ...extra }, timeout: 15_000 });
  const input = async (name: string, value: unknown) => {
    const path = join(root, `${name}.json`); await atomicWriteJson(path, value); return path;
  };
  const saved = (directory = root) => readJson<Record<string, any>>(join(directory, 'config.json'));
  const bytes = (directory = root) => readFile(join(directory, 'config.json'), 'utf8');
  const isolated = (...directories: string[]) => {
    for (const directory of directories.length ? directories : [root]) {
      for (const file of ['unexpected-network', 'private-key', 'run.lock', 'chart.lock', 'start.log', 'chart.log']) {
        assert.equal(existsSync(join(directory, file)), false, file);
      }
    }
  };
  return { root, command, input, saved, bytes, isolated };
}

test('allocation preview is read-only and set persists policy with its exact targets without starting services', async t => {
  const f = await fixture(t); const path = await f.input('policy', policy());
  const stop = { requestId: 'preserve-user-stop' };
  await atomicWriteJson(join(f.root, 'stop.json'), stop);
  const before = await f.bytes();
  const preview = JSON.parse((await f.command(['allocation', 'preview', path])).stdout);
  assert.equal(preview.mode, 'preview'); assert.equal(preview.wallet.toLowerCase(), one);
  assert.equal(preview.changesTargets, false); assert.equal(preview.result.targets.USDG, 500);
  assert.equal(await f.bytes(), before);
  const applied = JSON.parse((await f.command(['allocation', 'set', path])).stdout);
  assert.equal(applied.mode, 'managed'); assert.deepEqual(applied.targets, preview.result.targets);
  const stored = (await f.saved())!;
  assert.deepEqual(stored.targets, applied.targets); assert.deepEqual(stored.allocation.policy, policy());
  assert.equal(stored.allocation.version, 1); assert.equal(typeof stored.allocation.policyHash, 'string');
  assert.ok(Number.isFinite(Date.parse(stored.allocation.computedAt)));
  assert.deepEqual(stored.allocation.result.targets, stored.targets);
  assert.equal(Object.values(stored.targets as Record<string, number>).reduce((sum, value) => sum + value, 0), 10_000);
  const status = JSON.parse((await f.command(['allocation', 'status'])).stdout);
  assert.equal(status.mode, 'managed'); assert.deepEqual(status.targets, stored.targets);
  assert.deepEqual(status.allocation, stored.allocation);
  assert.deepEqual(await readJson(join(f.root, 'stop.json')), stop);
  assert.equal(await readJson(join(f.root, 'pending.json')), null); f.isolated();
});

test('unrelated configuration preserves allocation while all explicit manual target operations clear it', async t => {
  const f = await fixture(t); const path = await f.input('policy', policy());
  await f.command(['allocation', 'set', path]); const managed = (await f.saved())!;
  const cycle = { wallet: one, startedAt: 1000, activeUntil: 1000, nextEligibleAt: 3_601_000 };
  await atomicWriteJson(join(f.root, 'cycle.json'), cycle);
  await f.command(['configure', '--rebalance-interval-seconds', '7200', '--slippage', '0.75']);
  const unrelated = (await f.saved())!;
  assert.deepEqual(unrelated.allocation, managed.allocation); assert.deepEqual(unrelated.targets, managed.targets);
  assert.equal(unrelated.rebalanceIntervalSeconds, 7200); assert.equal(unrelated.slippageBps, 75);
  const manual = JSON.parse((await f.command(['allocation', 'manual'])).stdout);
  assert.equal(manual.mode, 'manual'); assert.deepEqual(manual.targets, managed.targets);
  assert.equal(manual.allocation, null); assert.equal((await f.saved())!.allocation, undefined);
  for (const args of [
    ['targets', 'set', 'AAPL', '30'], ['targets', 'replace', targetArgument], ['configure', '--targets', targetArgument],
  ]) {
    await f.command(['allocation', 'set', path]);
    await f.command(args);
    const saved = (await f.saved())!;
    assert.equal(saved.allocation, undefined, args.join(' '));
    if (args[1] === 'set') assert.equal(saved.targets.AAPL, 3000);
    else assert.deepEqual(saved.targets, targets);
    assert.equal(JSON.parse((await f.command(['allocation', 'status'])).stdout).mode, 'manual');
  }
  assert.deepEqual(await readJson(join(f.root, 'cycle.json')), cycle); f.isolated();
});

test('invalid and infeasible allocation requests preserve configuration bytes', async t => {
  const f = await fixture(t); await f.command(['allocation', 'set', await f.input('valid', policy())]);
  const before = await f.bytes();
  const unknown = policy(); delete unknown.assets.AMD;
  unknown.assets.UNKNOWN = { riskScore: 40, expectedReturnBps: 500, minBps: 0, maxBps: 4000 };
  const infeasible = policy();
  for (const [id, asset] of Object.entries(infeasible.assets)) if (id !== 'USDG') asset.maxBps = 1000;
  const missing = policy(); delete (missing.assets.AAPL as Partial<typeof missing.assets.AAPL>).riskScore;
  for (const [index, value] of [unknown, infeasible, missing, { ...policy(), maxRiskScore: 0 }].entries()) {
    const path = await f.input(`invalid-${index}`, value);
    await assert.rejects(f.command(['allocation', 'set', path]));
    assert.equal(await f.bytes(), before);
  }
  await assert.rejects(f.command(['configure', '--targets', '']));
  assert.equal(await f.bytes(), before);
  const malformed = join(f.root, 'malformed.json'); await writeFile(malformed, '{invalid');
  await assert.rejects(f.command(['allocation', 'set', malformed]));
  assert.equal(await f.bytes(), before); f.isolated();
});

test('pending transactions and active cycles prevent allocation adoption without changing their records', async t => {
  const f = await fixture(t); const path = await f.input('policy', policy()); const before = await f.bytes();
  const pending = { chainId: 4663, wallet: one, hash: `0x${'1'.repeat(64)}`, nonce: 1,
    kind: 'swap', status: 'broadcast', createdAt: new Date().toISOString() };
  await atomicWriteJson(join(f.root, 'pending.json'), pending);
  await assert.rejects(f.command(['allocation', 'set', path]));
  assert.equal(await f.bytes(), before); assert.deepEqual(await readJson(join(f.root, 'pending.json')), pending);
  await rm(join(f.root, 'pending.json'));
  const now = Date.now();
  const cycle = { wallet: one, startedAt: now, activeUntil: now + 600_000, nextEligibleAt: now + 3_600_000 };
  await atomicWriteJson(join(f.root, 'cycle.json'), cycle);
  await assert.rejects(f.command(['allocation', 'set', path]));
  assert.equal(await f.bytes(), before); assert.deepEqual(await readJson(join(f.root, 'cycle.json')), cycle);
  const corrupt = { ...cycle, activeUntil: 'not-a-date' };
  await atomicWriteJson(join(f.root, 'cycle.json'), corrupt);
  await assert.rejects(f.command(['allocation', 'set', path]));
  assert.equal(await f.bytes(), before); assert.deepEqual(await readJson(join(f.root, 'cycle.json')), corrupt);
  f.isolated();
});

test('synthetic return history is permitted for preview and cannot become managed targets', async t => {
  const f = await fixture(t); const candidate = { ...policy(), objective: 'sharpe', history: {
    source: 'Isolated synthetic test fixture', basis: 'synthetic', quoteCurrency: 'USDG', interval: 'daily',
    asOf: '2026-09-07', benchmarkPeriodReturn: 0,
    observations: Array.from({ length: 20 }, (_, day) => ({
      date: new Date(Date.UTC(2026, 7, 19 + day)).toISOString().slice(0, 10),
      returns: Object.fromEntries(Object.keys(targets).map((id, index) => [id, id === 'USDG' ? 0
        : 0.001 + ((day % 5) - 2) * 0.0001 * index])),
    })),
  } };
  const path = await f.input('synthetic', candidate); const before = await f.bytes();
  assert.equal(JSON.parse((await f.command(['allocation', 'preview', path])).stdout).mode, 'preview');
  await assert.rejects(f.command(['allocation', 'set', path]));
  assert.equal(await f.bytes(), before); f.isolated();
});

test('allocation policy and manual overrides stay with their wallet across chat attachment changes', async t => {
  const f = await fixture(t); const second = await addPortfolio(f.root, configuration(two));
  const routed = { REBALANCE_PROFILE_PINNED: '', REBALANCE_PROFILE_WALLET: '' };
  const firstPolicy = await f.input('first', policy()); const secondPolicy = await f.input('second', policy(true));
  await f.command(['allocation', 'set', firstPolicy, '--profile', one], routed);
  await f.command(['allocation', 'set', secondPolicy, '--profile', two], routed);
  const a = (await f.saved())!; const b = (await f.saved(second.dataDir))!;
  assert.notDeepEqual(a.targets, b.targets); assert.notEqual(a.allocation.policyHash, b.allocation.policyHash);
  const beforeSecond = await f.bytes(second.dataDir);
  await connectPortfolio(f.root, 'allocation-chat', two);
  await f.command(['allocation', 'manual', '--profile', one, '--session', 'allocation-chat'], routed);
  assert.equal((await f.saved())!.allocation, undefined); assert.equal(await f.bytes(second.dataDir), beforeSecond);
  const selected = JSON.parse((await f.command(['allocation', 'status', '--session', 'allocation-chat'], routed)).stdout);
  assert.equal(selected.wallet.toLowerCase(), two); assert.equal(selected.mode, 'managed'); assert.deepEqual(selected.targets, b.targets);
  const beforeFirst = await f.bytes();
  await f.command(['targets', 'set', 'USDG', '10', '--session', 'allocation-chat'], routed);
  assert.equal((await f.saved(second.dataDir))!.allocation, undefined);
  assert.equal((await f.saved(second.dataDir))!.targets.USDG, 1000);
  assert.equal(await f.bytes(), beforeFirst); f.isolated(f.root, second.dataDir);
});
