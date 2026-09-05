import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { promisify } from 'node:util';
import { atomicWriteJson, readJson, type PendingTransaction } from '../src/storage.js';

const directory = await mkdtemp(join(tmpdir(), 'rebalance-cadence-test-'));
process.env.REBALANCE_DATA_DIR = directory;
delete process.env.REBALANCE_PRIVATE_KEY;
const { validateConfig } = await import('../src/config.js');
const { CYCLE_PATH, beginRebalanceCycle, finishRebalanceCycle, noteSuccessfulSwap, readCycle,
  rebalanceInterval } = await import('../src/cadence.js');
const wallet = '0x0000000000000000000000000000000000000001';
const config = validateConfig({ version: 1, chainId: 4663, wallet, mode: 'ledger', rpcUrl: 'http://fixture.invalid',
  targets: { USDG: 2000, TSLA: 2000, AAPL: 2000, NVDA: 2000, AMZN: 2000 },
  driftThresholdBps: 500, slippageBps: 50, deadlineSeconds: 120, pollSeconds: 30, rebalanceIntervalSeconds: 3600 });
const start = 2_000_000_000_000;
const swap = (createdAt = start): PendingTransaction => ({ chainId: 4663, wallet, hash: `0x${'ab'.repeat(32)}`,
  nonce: 1, kind: 'swap', createdAt: new Date(createdAt).toISOString(), status: 'broadcast' });

beforeEach(async () => {
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
});
after(() => rm(directory, { recursive: true, force: true }));

test('an attempt with no successful swap can restart after its fixed ten-minute window even if closed early', async t => {
  let now = start;
  t.mock.method(Date, 'now', () => now);
  const first = await beginRebalanceCycle(config);
  assert.equal(Date.parse(first.nextEligibleAt), start + 600_000);
  assert.equal((await readCycle())!.swapConfirmed, false);
  now += 90_000;
  await noteSuccessfulSwap({ ...swap(), kind: 'approval' });
  assert.equal((await readCycle())!.swapConfirmed, false, 'approval gas does not mean a swap succeeded');
  assert.equal((await rebalanceInterval(config)).operation, null);
  await finishRebalanceCycle();
  const closed = await readCycle();
  assert.equal(closed!.activeUntil, now);
  const edited = { ...config, rebalanceIntervalSeconds: 1 };
  assert.equal(Date.parse((await rebalanceInterval(edited)).cycle!.nextEligibleAt), start + 600_000);
  await assert.rejects(beginRebalanceCycle(edited), /no new trades before/);
  now = start + 599_999;
  assert.equal((await rebalanceInterval(config)).operation?.status, 'cooling-down');
  now++;
  assert.equal((await rebalanceInterval(config)).operation, null);
  const next = await beginRebalanceCycle(config);
  assert.equal(Date.parse(next.startedAt), now);
  assert.equal(Date.parse(next.nextEligibleAt), now + 600_000);
  assert.equal((await readCycle())!.swapConfirmed, false);
});

test('one successful leg preserves the recorded hour through later failures, edits and a fresh process', async t => {
  let now = start;
  t.mock.method(Date, 'now', () => now);
  await beginRebalanceCycle(config);
  now += 30_000;
  await noteSuccessfulSwap(swap());
  const marked = await readCycle();
  assert.equal(marked!.swapConfirmed, true);
  assert.equal(Date.parse((await rebalanceInterval(config)).cycle!.nextEligibleAt), start + 3_600_000);
  await noteSuccessfulSwap(swap());
  assert.deepEqual(await readCycle(), marked, 'receipt replay cannot shift the recorded hour');
  now = start + 600_000;
  const edited = { ...config, rebalanceIntervalSeconds: 1, targets: { ...config.targets, USDG: 3000, TSLA: 1000 } };
  assert.equal((await rebalanceInterval(edited)).operation?.status, 'cooling-down');
  await assert.rejects(beginRebalanceCycle(edited), /no new trades before/);
  assert.deepEqual(await readCycle(), marked);
  const restarted = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    const { rebalanceInterval } = await import(process.argv[1]);
    Date.now = () => Number(process.argv[2]);
    process.stdout.write(JSON.stringify(await rebalanceInterval(JSON.parse(process.argv[3]))));
  `, '--', new URL('../src/cadence.ts', import.meta.url).href, String(now), JSON.stringify(edited)],
  { env: { ...process.env, REBALANCE_DATA_DIR: directory }, timeout: 10_000 });
  const result = JSON.parse(restarted.stdout);
  assert.equal(result.operation.status, 'cooling-down');
  assert.equal(Date.parse(result.cycle.nextEligibleAt), start + 3_600_000);
  now = start + 3_600_000;
  const next = await beginRebalanceCycle(config);
  assert.equal(Date.parse(next.nextEligibleAt), now + 600_000);
  assert.equal((await readCycle())!.swapConfirmed, false, 'a new attempt must not inherit the prior success marker');
});

test('legacy cycles retain their hour and malformed success markers cannot erase the recorded wait', async t => {
  t.mock.method(Date, 'now', () => start + 600_000);
  const legacy = { wallet, startedAt: start, activeUntil: start + 600_000, nextEligibleAt: start + 3_600_000 };
  await atomicWriteJson(CYCLE_PATH, legacy);
  assert.equal(Date.parse((await rebalanceInterval(config)).cycle!.nextEligibleAt), legacy.nextEligibleAt);
  assert.equal((await rebalanceInterval(config)).operation?.status, 'cooling-down');
  for (const swapConfirmed of [null, 0, 1, 'false', {}]) {
    const corrupt = { ...legacy, swapConfirmed };
    await atomicWriteJson(CYCLE_PATH, corrupt);
    await assert.rejects(readCycle(), /Invalid rebalance cycle/);
    await assert.rejects(beginRebalanceCycle(config), /Invalid rebalance cycle/);
    assert.deepEqual(await readJson(CYCLE_PATH), corrupt);
  }
});

test('successful-swap notes cannot mark another wallet, a historical or later attempt, or an approval', async t => {
  t.mock.method(Date, 'now', () => start);
  await beginRebalanceCycle(config);
  const original = await readCycle();
  for (const receipt of [
    { ...swap(), wallet: '0x0000000000000000000000000000000000000002' },
    swap(start - 1), swap(start + 600_000), { ...swap(), kind: 'approval' as const },
  ]) {
    await noteSuccessfulSwap(receipt);
    assert.deepEqual(await readCycle(), original);
  }
  await assert.rejects(noteSuccessfulSwap({ ...swap(), createdAt: 'invalid-date' }), /Invalid transaction timestamp/);
  assert.deepEqual(await readCycle(), original);
  await noteSuccessfulSwap(swap(start + 599_999));
  assert.equal((await readCycle())!.swapConfirmed, true);
});

test('normal receipt reconciliation marks success before clearing pending, and marker failure retains the barrier', async () => {
  const script = `
    import assert from 'node:assert/strict';
    import { mock } from 'node:test';
    globalThis.fetch = () => { throw new Error('This fixture cannot use a network'); };
    const storage = await import(process.argv[1]);
    const cadence = await import(process.argv[2]);
    const configModule = await import(process.argv[4]);
    const config = JSON.parse(process.argv[5]);
    let now = ${start}; Date.now = () => now;
    let fail = true; let marks = 0;
    mock.module(process.argv[2], { namedExports: { ...cadence, noteSuccessfulSwap: async original => {
      assert.equal((await storage.readJson(configModule.PENDING_PATH)).hash, original.hash);
      if (fail) throw new Error('Fixture cadence persistence failure');
      await cadence.noteSuccessfulSwap(original);
      assert.equal((await cadence.readCycle()).swapConfirmed, true);
      assert.equal((await storage.readJson(configModule.PENDING_PATH)).hash, original.hash);
      marks++;
    } } });
    const { reconcile } = await import(process.argv[3]);
    await cadence.beginRebalanceCycle(config);
    const original = { chainId: 4663, wallet: config.wallet, hash: '0x' + 'ab'.repeat(32), nonce: 1,
      kind: 'swap', status: 'broadcast', createdAt: new Date(now).toISOString() };
    await storage.atomicWriteJson(configModule.PENDING_PATH, original);
    const blockHash = '0x' + 'cd'.repeat(32);
    const chain = { publicClient: { getChainId: async () => 4663,
      getTransactionReceipt: async ({ hash }) => ({ transactionHash: hash, from: config.wallet,
        status: 'success', blockNumber: 10n, blockHash }),
      getBlock: async () => ({ hash: blockHash }), getBlockNumber: async () => 11n,
    } };
    const release = await storage.acquireLock(configModule.DATA);
    try {
      await assert.rejects(reconcile(config, chain), /Fixture cadence persistence failure/);
      assert.deepEqual(await storage.readJson(configModule.PENDING_PATH), original);
      assert.equal((await cadence.readCycle()).swapConfirmed, false);
      fail = false;
      assert.equal((await reconcile(config, chain)).operation.status, 'confirmed');
      assert.equal(await storage.readJson(configModule.PENDING_PATH), null);
      assert.equal((await cadence.readCycle()).swapConfirmed, true);
      assert.equal(marks, 1);
      now += 3600000;
      await cadence.beginRebalanceCycle(config);
      assert.equal((await cadence.readCycle()).swapConfirmed, false);
      await reconcile(config, chain);
      assert.equal((await cadence.readCycle()).swapConfirmed, false, 'a cached old receipt cannot mark a new attempt');
      assert.equal(marks, 1);
      process.stdout.write(JSON.stringify({ outcome: 'marker-before-pending-clear' }));
    } finally { await release(); }
  `;
  const result = await promisify(execFile)(process.execPath, ['--experimental-test-module-mocks', '--import', 'tsx',
    '--input-type=module', '-e', script, '--', ...['storage', 'cadence', 'transactions', 'config']
      .map(name => new URL(`../src/${name}.ts`, import.meta.url).href), JSON.stringify(config)],
  { env: { ...process.env, REBALANCE_DATA_DIR: directory }, timeout: 10_000 });
  assert.deepEqual(JSON.parse(result.stdout), { outcome: 'marker-before-pending-clear' });
});
