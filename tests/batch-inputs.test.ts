import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const script = `
import assert from 'node:assert/strict';
const base = process.argv[1];
const path = name => new URL(name + '.ts', base).href;
globalThis.fetch = () => { throw new Error('Network forbidden in prepared-input fixture'); };
const { validateConfig } = await import(path('config'));
const { readJson, atomicWriteJson } = await import(path('storage'));
const { BATCH_INPUTS_PATH, readBatchInputLimits, retainBatchInputs } = await import(path('batch-inputs'));
assert.equal(BATCH_INPUTS_PATH.startsWith(process.env.REBALANCE_ROOT_DIR + '/'), true);
const wallet = '0x' + '12'.repeat(20);
const config = validateConfig({ version: 1, chainId: 4663, wallet, mode: 'ledger', rpcUrl: 'http://input-fixture.invalid',
  targets: { USDG: 2000, AAPL: 2000, NVDA: 2000, MSFT: 2000, AMD: 2000 }, driftThresholdBps: 500, slippageBps: 50,
  deadlineSeconds: 120, pollSeconds: 5, rebalanceIntervalSeconds: 3600 });
const now = Date.now();
const cycle = { startedAt: new Date(now - 1000).toISOString(), activeUntil: new Date(now + 599000).toISOString(), nextEligibleAt: new Date(now + 3599000).toISOString() };
const plan = (aapl, cash) => ({ reason: 'fixture', trades: [
  { sellAssetId: 'AAPL', buyAssetId: 'USDG', amountIn: aapl, reason: 'fixture' },
  { sellAssetId: 'USDG', buyAssetId: 'MSFT', amountIn: cash / 2n, reason: 'fixture' },
  { sellAssetId: 'USDG', buyAssetId: 'AMD', amountIn: cash - cash / 2n, reason: 'fixture' },
] });
const swap = id => ({ status: 'confirmed', kind: 'swap', hash: '0x' + id.repeat(64), wallet, chainId: 4663 });
const approval = { ...swap('2'), kind: 'approval' };
const oldSwap = swap('1');
assert.equal(await readBatchInputLimits(config, cycle, oldSwap), undefined);
await retainBatchInputs(config, cycle, oldSwap, plan(500n, 400n));
assert.deepEqual(await readBatchInputLimits(config, cycle, oldSwap), { AAPL: 500n, USDG: 400n });
// Reconciliation of an approval is not a new swap and cannot discard the saved
// preparation. A fresh module instance/process has no in-memory plan dependency.
assert.deepEqual(await readBatchInputLimits(config, cycle, approval), { AAPL: 500n, USDG: 400n });
const freshModule = await import(path('batch-inputs') + '?restart-fixture');
assert.deepEqual(await freshModule.readBatchInputLimits(config, cycle, approval), { AAPL: 500n, USDG: 400n });
await retainBatchInputs(config, cycle, approval, plan(490n, 380n));
const shrunk = await readJson(BATCH_INPUTS_PATH);
assert.equal(shrunk.lastConfirmedSwapHash, oldSwap.hash);
assert.deepEqual(await readBatchInputLimits(config, cycle, approval), { AAPL: 490n, USDG: 380n });
await assert.rejects(retainBatchInputs(config, cycle, approval, plan(491n, 380n)), /Invalid prepared/);
await assert.rejects(retainBatchInputs(config, cycle, approval, plan(490n, 381n)), /Invalid prepared/);
await assert.rejects(retainBatchInputs(config, cycle, approval, { reason: 'fixture', trades: [{ sellAssetId: 'NVDA', buyAssetId: 'USDG', amountIn: 1n, reason: 'fixture' }] }), /Invalid prepared/);
assert.deepEqual(await readJson(BATCH_INPUTS_PATH), shrunk, 'a rejected increase must preserve the existing durable bounds');
for (const status of ['pending', 'unresolved', 'reverted', 'recovered-revert', 'cancelled']) {
  assert.deepEqual(await readBatchInputLimits(config, cycle, { ...swap('3'), status }), { AAPL: 490n, USDG: 380n });
}
assert.deepEqual(await readBatchInputLimits(config, cycle, { ...swap('3'), wallet: '0x' + '34'.repeat(20) }), { AAPL: 490n, USDG: 380n });
assert.deepEqual(await readBatchInputLimits(config, cycle, { ...swap('3'), chainId: 1 }), { AAPL: 490n, USDG: 380n });
assert.equal(await readBatchInputLimits(config, cycle, swap('3')), undefined, 'only a confirmed new same-wallet/chain swap starts a new batch');
await retainBatchInputs(config, cycle, swap('3'), plan(700n, 600n));
assert.deepEqual(await readBatchInputLimits(config, cycle, approval), { AAPL: 700n, USDG: 600n });
assert.equal((await readJson(BATCH_INPUTS_PATH)).lastConfirmedSwapHash, swap('3').hash);
assert.equal(await readBatchInputLimits({ ...config, slippageBps: 75 }, cycle, approval), undefined);
assert.equal(await readBatchInputLimits({ ...config, wallet: '0x' + '34'.repeat(20) }, cycle, approval), undefined);
assert.equal(await readBatchInputLimits(config, { ...cycle, startedAt: new Date(now - 500).toISOString() }, approval), undefined);
assert.equal(await readBatchInputLimits(config, { ...cycle, activeUntil: new Date(now - 1).toISOString() }, approval), undefined);
assert.equal(await readBatchInputLimits(config, null, approval), undefined);
const original = await readJson(BATCH_INPUTS_PATH);
for (const patch of [{ inputs: { AAPL: '-1' } }, { inputs: { AAPL: (2n ** 256n).toString() } }, { inputs: { AAPL: '1e10' } }, { inputs: [] }, { version: 2 }]) {
  await atomicWriteJson(BATCH_INPUTS_PATH, { ...original, ...patch });
  await assert.rejects(readBatchInputLimits(config, cycle, approval), /Invalid prepared/);
}
console.log('ok');
`;

test('prepared batch amounts survive approvals/restart, tighten monotonically and reset only for their proper context', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rebalance-batch-inputs-'));
  try {
    const result = await promisify(execFile)(process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script, '--', new URL('../src/', import.meta.url).href], {
        env: { ...process.env, REBALANCE_DATA_DIR: directory, REBALANCE_ROOT_DIR: directory, REBALANCE_PROFILE_WALLET: '' }, timeout: 20_000,
      }).catch(error => { throw new Error(String(error.stderr || error.message).slice(-5000)); });
    assert.equal(result.stdout.trim(), 'ok');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
