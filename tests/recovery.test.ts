import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { keccak256, parseTransaction, TransactionNotFoundError, TransactionReceiptNotFoundError, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { validateConfig } from '../src/config.js';
import { automaticRecovery, AUTO_RECOVERY_GRACE_MS, recover, type AutomaticRecoveryDependencies, type RecoveryDependencies, type RecoveryRecord } from '../src/recovery.js';
import { acquireLock, atomicWriteJson, readJson, type PendingTransaction } from '../src/storage.js';
import type { LaunchResult } from '../src/launch.js';
import type { Status } from '../src/runtime.js';

// Public disposable fixture account. Every provider method below is mocked;
// neither the real application directory nor a network transport is used.
const account = privateKeyToAccount(`0x${'7'.padStart(64, '0')}`);
const originalHash = `0x${'ab'.repeat(32)}` as Hex;
const blockHash = `0x${'cd'.repeat(32)}` as Hex;
const config = validateConfig({ version: 1, chainId: 4663, wallet: account.address, mode: 'private-key',
  rpcUrl: 'http://127.0.0.1:1', targets: { USDG: 500, AAPL: 2375, NVDA: 2375, MSFT: 2375, AMD: 2375 },
  driftThresholdBps: 500, slippageBps: 50, deadlineSeconds: 120, pollSeconds: 30, rebalanceIntervalSeconds: 3600 });
type FixtureTx = { hash: Hex; from: string; to: string; nonce: number; value: bigint; input: Hex;
  chainId: number; gasPrice: bigint; blockNumber: bigint | null; blockHash: Hex | null };
type FixtureReceipt = { transactionHash: Hex; from: string; to: string; status: 'success' | 'reverted'; blockNumber: bigint; blockHash: Hex };

async function fixture(t: TestContext, active = false) {
  const dataDir = await mkdtemp(join(tmpdir(), 'rebalance-recovery-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const path = (name: string) => join(dataDir, name);
  const pending: PendingTransaction = { chainId: 4663, wallet: account.address, hash: originalHash,
    nonce: 3, kind: 'swap', createdAt: '2026-09-05T20:00:00Z', status: 'unknown' };
  await atomicWriteJson(path('pending.json'), pending);
  const cycle = { wallet: account.address, startedAt: 100, activeUntil: 200, nextEligibleAt: 300, swapConfirmed: false };
  await atomicWriteJson(path('cycle.json'), cycle);
  const txs = new Map<Hex, FixtureTx>();
  const receipts = new Map<Hex, FixtureReceipt>();
  const sent: Hex[] = [];
  let armed = active;
  let resumeCalls = 0;
  let keyReads = 0;
  let mineOnSend = true;
  let throwOnSend = false;
  let head = 101n;
  let latestNonce = 3;
  let queuedNonce = 3;
  let expectedFee = 20n;
  let successfulNotes = 0;
  const publicStatus = (isArmed: boolean): Status => ({ app: 'Rebalance', chain: { id: 4663, name: 'Robinhood' },
    mode: 'private-key', wallet: account.address, config: { targets: config.targets, rebalanceIntervalSeconds: 3600 },
    cycle: null, portfolio: null, operation: null, updatedAt: null, error: null,
    graph: { node: 'wait', trace: ['config', 'reconcile', 'wait'] }, armed: isArmed });
  const originalTx = (): FixtureTx => ({ hash: originalHash, from: account.address, to: '0x0000000000000000000000000000000000000001',
    nonce: 3, value: 0n, input: '0x1234', chainId: 4663, gasPrice: 5n, blockNumber: 100n, blockHash });
  const mineOriginal = (status: 'success' | 'reverted' = 'success') => {
    txs.set(originalHash, originalTx());
    receipts.set(originalHash, { transactionHash: originalHash, from: account.address, to: originalTx().to, status, blockNumber: 100n, blockHash });
  };
  const rpc = {
    getChainId: async () => 4663,
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      if (!receipts.has(hash)) throw new TransactionReceiptNotFoundError({ hash });
      return receipts.get(hash)!;
    },
    getTransaction: async ({ hash }: { hash: Hex }) => {
      if (!txs.has(hash)) throw new TransactionNotFoundError({ hash });
      return txs.get(hash)!;
    },
    getTransactionCount: async ({ blockTag }: { blockTag: string }) => blockTag === 'latest' ? latestNonce : queuedNonce,
    getBlock: async () => ({ hash: blockHash }), getBlockNumber: async () => head,
    getCode: async () => '0x' as Hex, getGasPrice: async () => 10n,
    estimateGas: async (tx: { account: string; to: string; data: string; value: bigint }) => {
      assert.equal(tx.account, account.address); assert.equal(tx.to, account.address);
      assert.equal(tx.data, '0x'); assert.equal(tx.value, 0n); return 21_000n;
    },
    getBalance: async () => 10n ** 18n,
    sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
      assert.ok(await readJson(path('run.lock')), 'signing/sending holds execution lock');
      assert.ok(await readJson(path('config.lock')), 'configuration is locked through send');
      const hash = keccak256(serializedTransaction);
      const record = await readJson<RecoveryRecord>(path('recovery.json'));
      assert.equal(record?.original.hash, originalHash);
      assert.equal(record?.cancellation?.hash, hash);
      assert.equal(record?.cancellation?.status, 'prepared');
      assert.deepEqual(await readJson(path('pending.json')), pending);
      const parsed = parseTransaction(serializedTransaction);
      assert.equal(parsed.nonce, 3); assert.equal(parsed.chainId, 4663);
      assert.equal(parsed.to?.toLowerCase(), account.address.toLowerCase());
      assert.equal(parsed.value ?? 0n, 0n); assert.equal(parsed.data ?? '0x', '0x');
      assert.equal(parsed.gas, 25_200n); assert.equal(parsed.gasPrice, expectedFee);
      sent.push(serializedTransaction);
      txs.set(hash, { hash, from: account.address, to: account.address, nonce: 3, value: 0n, input: '0x',
        chainId: 4663, gasPrice: 20n, blockNumber: mineOnSend ? 100n : null, blockHash: mineOnSend ? blockHash : null });
      if (mineOnSend) receipts.set(hash, { transactionHash: hash, from: account.address, to: account.address,
        status: 'success', blockNumber: 100n, blockHash });
      if (throwOnSend) throw new Error('fixture-sensitive-provider-error');
      return hash;
    },
  };
  const deps: RecoveryDependencies = { dataDir, config: async () => config, armed: async () => armed,
    rpc: () => rpc as unknown as ReturnType<RecoveryDependencies['rpc']>,
    account: async () => { keyReads++; return account; },
    noteSuccessfulSwap: async original => {
      assert.equal(original.hash, originalHash); assert.equal(original.kind, 'swap');
      successfulNotes++;
      await atomicWriteJson(path('cycle.json'), { ...cycle, swapConfirmed: true });
    },
    refresh: async () => {
      assert.ok(await readJson(path('run.lock')));
      assert.equal(await readJson(path('pending.json')), null);
      const current = (await readJson<typeof cycle>(path('cycle.json')))!;
      assert.equal(current.startedAt, cycle.startedAt); assert.equal(current.activeUntil, cycle.activeUntil);
      assert.equal(current.nextEligibleAt, cycle.nextEligibleAt);
      return publicStatus(false);
    },
    resume: async expectedStop => {
      const saved = await readJson(path('stop.json'));
      assert.equal(expectedStop, createHash('sha256').update(JSON.stringify(saved)).digest('hex'));
      assert.ok((await readJson<RecoveryRecord>(path('recovery.json')))?.resumeAttemptedAt);
      assert.equal(await readJson(path('run.lock')), null);
      assert.equal(await readJson(path('config.lock')), null);
      resumeCalls++; armed = true;
      await rm(path('stop.json'));
      return { app: 'Rebalance', requested: 'full', outcome: 'armed', status: publicStatus(true),
        chart: { state: 'ready', url: 'fixture' }, messages: [] } satisfies LaunchResult;
    }, pause: async () => {}, attempts: 2 };
  return { path, pending, cycle, rpc, deps, sent, receipts, txs, mineOriginal,
    get keyReads() { return keyReads; }, get resumeCalls() { return resumeCalls; },
    get successfulNotes() { return successfulNotes; },
    set armed(value: boolean) { armed = value; }, set mineOnSend(value: boolean) { mineOnSend = value; },
    set throwOnSend(value: boolean) { throwOnSend = value; }, set head(value: bigint) { head = value; },
    set expectedFee(value: bigint) { expectedFee = value; },
    set latestNonce(value: number) { latestNonce = value; }, set queuedNonce(value: number) { queuedNonce = value; } };
}

async function auto(f: Awaited<ReturnType<typeof fixture>>, overrides: Partial<AutomaticRecoveryDependencies> = {}) {
  const release = await acquireLock(f.deps.dataDir, 'run.lock');
  try {
    return await automaticRecovery(config, { publicClient: f.rpc as unknown as ReturnType<RecoveryDependencies['rpc']> }, {
      dataDir: f.deps.dataDir, config: f.deps.config, account: f.deps.account,
      now: () => Date.parse(f.pending.createdAt) + AUTO_RECOVERY_GRACE_MS,
      noteSuccessfulSwap: f.deps.noteSuccessfulSwap, ...overrides });
  } finally { await release(); }
}

test('read-only recovery assessment never stops, signs, reconciles files or resumes', async t => {
  const f = await fixture(t, true);
  const before = await readdir(f.deps.dataDir);
  const result = await recover({}, f.deps);
  assert.equal(result.outcome, 'cancellation-needed'); assert.equal(result.armed, true);
  assert.deepEqual(await readdir(f.deps.dataDir), before);
  assert.deepEqual(await readJson(f.path('pending.json')), f.pending);
  assert.equal(f.sent.length, 0); assert.equal(f.keyReads, 0); assert.equal(f.resumeCalls, 0);
});

test('explicit recovery cancels only the original nonce and audits confirmed receipt before clearing', async t => {
  const f = await fixture(t);
  const result = await recover({ cancel: true, requestId: 'first' }, f.deps);
  assert.equal(result.outcome, 'cancelled'); assert.equal(result.armed, false);
  assert.equal(f.sent.length, 1); assert.equal(f.resumeCalls, 0);
  assert.equal(await readJson(f.path('pending.json')), null);
  assert.deepEqual(await readJson(f.path('cycle.json')), f.cycle);
  const audit = await readJson<RecoveryRecord>(f.path(`recovery-history/${originalHash}.json`));
  assert.equal(audit?.resolution, 'cancelled'); assert.equal(audit?.original.hash, originalHash);
  assert.equal(audit?.cancellation?.hash, result.cancellationHash);
  assert.equal((await readJson<{ kind: string }>(f.path('last-transaction.json')))?.kind, 'cancellation');
});

test('cooperative stop captures original activity, waits for runner and resumes once after confirmation', async t => {
  const f = await fixture(t, true);
  const release = await acquireLock(f.deps.dataDir, 'run.lock');
  f.deps.pause = async () => {
    const record = await readJson<RecoveryRecord>(f.path('recovery.json'));
    assert.equal(record?.originallyArmed, true);
    assert.deepEqual(await readJson(f.path('stop.json')), record?.stop);
    f.armed = false; await release();
  };
  const result = await recover({ cancel: true }, f.deps);
  assert.equal(result.outcome, 'cancelled'); assert.equal(result.armed, true);
  assert.equal(f.resumeCalls, 1);
  const replay = await recover({ cancel: true }, f.deps);
  assert.equal(replay.outcome, 'cancelled'); assert.equal(f.sent.length, 1); assert.equal(f.resumeCalls, 1);
  assert.equal(await readJson(f.path('stop.json')), null);
});

test('original receipt winning before cancellation clears truthfully without signing or sending', async t => {
  const f = await fixture(t);
  f.mineOriginal();
  const result = await recover({ cancel: true }, f.deps);
  assert.equal(result.outcome, 'original-confirmed'); assert.equal(f.sent.length, 0); assert.equal(f.keyReads, 0);
  assert.equal(await readJson(f.path('pending.json')), null);
  assert.equal((await readJson<{ kind: string }>(f.path('last-transaction.json')))?.kind, 'swap');
});

test('original receipt winning during cancellation preparation prevents the cancellation send', async t => {
  const f = await fixture(t);
  f.deps.account = async () => { f.mineOriginal(); return account; };
  const result = await recover({ cancel: true }, f.deps);
  assert.equal(result.outcome, 'original-confirmed'); assert.equal(f.sent.length, 0);
  assert.equal(await readJson(f.path('pending.json')), null);
});

test('unknown cancellation stays a barrier and later commands reconcile without another signature or send', async t => {
  const f = await fixture(t);
  f.mineOnSend = false; f.throwOnSend = true;
  const first = await recover({ cancel: true, requestId: 'first' }, f.deps);
  assert.equal(first.outcome, 'pending'); assert.equal(f.sent.length, 1); assert.equal(f.keyReads, 1);
  assert.equal((await readJson<RecoveryRecord>(f.path('recovery.json')))?.cancellation?.status, 'unknown');
  assert.deepEqual(await readJson(f.path('pending.json')), f.pending);
  const duplicate = await recover({ cancel: true, requestId: 'first' }, f.deps);
  assert.equal(duplicate.outcome, 'already-handled');
  assert.equal((await recover({ cancel: true, requestId: 'second' }, f.deps)).outcome, 'pending');
  assert.equal(f.sent.length, 1); assert.equal(f.keyReads, 1);
  const hash = first.cancellationHash as Hex;
  Object.assign(f.txs.get(hash)!, { blockNumber: 100n, blockHash });
  f.receipts.set(hash, { transactionHash: hash, from: account.address, to: account.address, status: 'success', blockNumber: 100n, blockHash });
  assert.equal((await recover({ cancel: true, requestId: 'third' }, f.deps)).outcome, 'cancelled');
  assert.equal(f.sent.length, 1); assert.equal(f.keyReads, 1);
});

test('cancellation receipt must match self-transfer fields and canonical two-confirmation block', async t => {
  for (const field of ['nonce', 'from', 'to', 'value', 'input', 'head', 'block']) {
    const f = await fixture(t);
    const send = f.rpc.sendRawTransaction;
    f.rpc.sendRawTransaction = async args => {
      const hash = await send(args);
      const tx = f.txs.get(hash)!;
      if (field === 'nonce') tx.nonce++;
      if (field === 'from') tx.from = '0x0000000000000000000000000000000000000001';
      if (field === 'to') tx.to = '0x0000000000000000000000000000000000000001';
      if (field === 'value') tx.value = 1n;
      if (field === 'input') tx.input = '0x01';
      if (field === 'head') f.head = 100n;
      if (field === 'block') f.rpc.getBlock = async () => ({ hash: originalHash });
      return hash;
    };
    const result = await recover({ cancel: true }, f.deps);
    assert.ok(['confirming', 'unknown'].includes(result.outcome), field);
    assert.deepEqual(await readJson(f.path('pending.json')), f.pending);
    assert.equal(f.resumeCalls, 0);
  }
});

test('newer stop during preparation prevents cancellation and remains intact', async t => {
  const f = await fixture(t, true);
  const stop = { requestedAt: 'later', requestId: 'newer-stop' };
  f.rpc.getBalance = async () => { await atomicWriteJson(f.path('stop.json'), stop); return 10n ** 18n; };
  const result = await recover({ cancel: true }, f.deps);
  assert.equal(result.outcome, 'blocked'); assert.equal(f.keyReads, 0); assert.equal(f.sent.length, 0);
  assert.deepEqual(await readJson(f.path('stop.json')), stop); assert.equal(f.resumeCalls, 0);
});

test('newer stop after cancellation send permits receipt reconciliation but prevents resume', async t => {
  const f = await fixture(t, true);
  const stop = { requestedAt: 'later', requestId: 'newer-stop' };
  const send = f.rpc.sendRawTransaction;
  f.rpc.sendRawTransaction = async args => { const hash = await send(args); await atomicWriteJson(f.path('stop.json'), stop); return hash; };
  const result = await recover({ cancel: true }, f.deps);
  assert.equal(result.outcome, 'cancelled'); assert.equal(f.resumeCalls, 0);
  assert.deepEqual(await readJson(f.path('stop.json')), stop);
});

test('unknown resume result is durably marked and never restarted by a later recovery invocation', async t => {
  const f = await fixture(t, true);
  f.deps.resume = async () => { f.armed = false; await rm(f.path('stop.json')); throw new Error('fixture unknown spawn'); };
  const result = await recover({ cancel: true }, f.deps);
  assert.equal(result.outcome, 'cancelled'); assert.equal(result.armed, null);
  assert.ok((await readJson<RecoveryRecord>(f.path('recovery.json')))?.resumeAttemptedAt);
  f.deps.resume = async () => assert.fail('must not repeat an uncertain resume');
  assert.equal((await recover({ cancel: true }, f.deps)).outcome, 'cancelled');
  assert.equal(await readJson(f.path('stop.json')), null);
});

test('inconsistent consumed nonce or executable account blocks cancellation without key access', async t => {
  for (const condition of ['consumed', 'other-queued', 'code', 'chain']) {
    const f = await fixture(t);
    if (condition === 'consumed') f.latestNonce = 4;
    if (condition === 'other-queued') f.queuedNonce = 4;
    if (condition === 'code') f.rpc.getCode = async () => '0x1234';
    if (condition === 'chain') f.rpc.getChainId = async () => 1;
    assert.equal((await recover({ cancel: true }, f.deps)).outcome, 'blocked', condition);
    assert.equal(f.keyReads, 0); assert.equal(f.sent.length, 0);
    assert.deepEqual(await readJson(f.path('pending.json')), f.pending);
  }
});

test('a durable prepared cancellation is never signed or sent again after an interrupted attempt', async t => {
  const f = await fixture(t);
  f.mineOnSend = false; f.throwOnSend = true;
  await recover({ cancel: true }, f.deps);
  const record = (await readJson<RecoveryRecord>(f.path('recovery.json')))!;
  record.cancellation!.status = 'prepared';
  await atomicWriteJson(f.path('recovery.json'), record);
  assert.equal((await recover({ cancel: true }, f.deps)).outcome, 'pending');
  assert.equal(f.keyReads, 1); assert.equal(f.sent.length, 1);
  assert.deepEqual(await readJson(f.path('pending.json')), f.pending);
});

test('same-hash changed nonce cannot redefine an existing recovery identity', async t => {
  const f = await fixture(t);
  f.mineOnSend = false;
  await recover({ cancel: true }, f.deps);
  await atomicWriteJson(f.path('pending.json'), { ...f.pending, nonce: 4 });
  const result = await recover({ cancel: true }, f.deps);
  assert.equal(result.outcome, 'blocked'); assert.match(result.messages.join(' '), /identity differs/);
  assert.equal(f.sent.length, 1); assert.equal(f.keyReads, 1);
});

test('original reverted receipt resolves the nonce without cancellation or a fake completion', async t => {
  const f = await fixture(t);
  f.mineOriginal('reverted');
  assert.equal((await recover({ cancel: true }, f.deps)).outcome, 'original-reverted');
  assert.equal(f.keyReads, 0); assert.equal(f.sent.length, 0);
  assert.equal(await readJson(f.path('pending.json')), null);
  assert.equal((await readJson<{ status: string }>(f.path('last-transaction.json')))?.status, 'reverted');
});

test('concurrent recovery requests cannot sign or send twice', async t => {
  const f = await fixture(t);
  const release = await acquireLock(f.deps.dataDir, 'recovery.lock');
  const blocked = await recover({ cancel: true, requestId: 'second' }, f.deps);
  assert.equal(blocked.outcome, 'blocked'); assert.equal(f.sent.length, 0); assert.equal(f.keyReads, 0);
  assert.equal(await readJson(f.path('stop.json')), null);
  await release();
  assert.equal((await recover({ cancel: true, requestId: 'first' }, f.deps)).outcome, 'cancelled');
  assert.equal(f.sent.length, 1);
});

test('a newer retained stop permits receipt-only cleanup but never resumes the earlier runner', async t => {
  const f = await fixture(t, true);
  f.mineOnSend = false;
  const first = await recover({ cancel: true }, f.deps);
  const stop = { requestedAt: 'after-first-recovery', requestId: 'new-stop' };
  await atomicWriteJson(f.path('stop.json'), stop);
  const hash = first.cancellationHash as Hex;
  Object.assign(f.txs.get(hash)!, { blockNumber: 100n, blockHash });
  f.receipts.set(hash, { transactionHash: hash, from: account.address, to: account.address, status: 'success', blockNumber: 100n, blockHash });
  assert.equal((await recover({ cancel: true }, f.deps)).outcome, 'cancelled');
  assert.equal(f.sent.length, 1); assert.equal(f.keyReads, 1); assert.equal(f.resumeCalls, 0);
  assert.deepEqual(await readJson(f.path('stop.json')), stop);
  assert.equal(await readJson(f.path('pending.json')), null);
});

test('automatic recovery waits a fixed five-minute grace without signing or changing cycle/stop', async t => {
  const f = await fixture(t);
  const result = await auto(f, { now: () => Date.parse(f.pending.createdAt) + AUTO_RECOVERY_GRACE_MS - 1 });
  assert.equal(result?.blocked, true); assert.equal(result?.operation?.status, 'recovery-wait');
  assert.match(result?.operation?.message ?? '', /five-minute/);
  assert.equal(f.keyReads, 0); assert.equal(f.sent.length, 0); assert.equal(f.resumeCalls, 0);
  assert.equal(await readJson(f.path('stop.json')), null);
  assert.equal(await readJson(f.path('recovery.json')), null);
  assert.deepEqual(await readJson(f.path('cycle.json')), f.cycle);
});

test('automatic stale prepared/unknown/broadcast cancellation preserves the active window and success state', async t => {
  for (const status of ['prepared', 'unknown', 'broadcast'] as const) {
    const f = await fixture(t);
    f.pending.status = status;
    await atomicWriteJson(f.path('pending.json'), f.pending);
    const result = await auto(f);
    assert.equal(result?.blocked, false); assert.equal(result?.operation?.status, 'cancelled');
    assert.equal(f.sent.length, 1); assert.equal(f.keyReads, 1); assert.equal(f.resumeCalls, 0);
    assert.equal(await readJson(f.path('stop.json')), null);
    assert.equal(await readJson(f.path('pending.json')), null);
    const cycle = (await readJson<typeof f.cycle>(f.path('cycle.json')))!;
    assert.deepEqual(cycle, f.cycle); assert.equal(f.successfulNotes, 0);
    const record = (await readJson<RecoveryRecord>(f.path('recovery.json')))!;
    assert.equal(record.automatic, true); assert.equal(record.stop, undefined); assert.equal(record.swapNotedAt, undefined);
    assert.equal(await auto(f), null, 'a completed journal must not change a later cycle or send again');
  }
});

test('automatic pending cancellation is receipt-only across restarts and prepared crash records', async t => {
  const f = await fixture(t);
  f.mineOnSend = false; f.throwOnSend = true;
  assert.equal((await auto(f))?.blocked, true);
  const record = (await readJson<RecoveryRecord>(f.path('recovery.json')))!;
  assert.equal(record.cancellation?.status, 'unknown');
  record.cancellation!.status = 'prepared';
  await atomicWriteJson(f.path('recovery.json'), record);
  assert.equal((await auto(f))?.blocked, true);
  assert.equal(f.sent.length, 1); assert.equal(f.keyReads, 1);
  const hash = record.cancellation!.hash;
  Object.assign(f.txs.get(hash)!, { blockNumber: 100n, blockHash });
  f.receipts.set(hash, { transactionHash: hash, from: account.address, to: account.address, status: 'success', blockNumber: 100n, blockHash });
  assert.equal((await auto(f))?.operation?.status, 'cancelled');
  assert.equal(f.sent.length, 1); assert.equal(f.keyReads, 1);
});

test('automatic recovery yields immediately to manual recovery without changing its stop', async t => {
  const f = await fixture(t);
  const release = await acquireLock(f.deps.dataDir, 'recovery.lock');
  const stop = { requestedAt: 'manual-stop', requestId: 'manual-recovery' };
  await atomicWriteJson(f.path('stop.json'), stop);
  const result = await auto(f);
  assert.equal(result?.operation?.status, 'recovery-busy');
  assert.deepEqual(await readJson(f.path('stop.json')), stop);
  assert.equal(f.sent.length, 0); assert.equal(f.keyReads, 0);
  await release();
});

test('automatic original revert preserves the current window without recording successful trading', async t => {
  const f = await fixture(t);
  f.mineOriginal('reverted');
  const result = await auto(f, { now: () => Date.parse(f.pending.createdAt) + 1 });
  assert.equal(result?.blocked, false); assert.equal(result?.operation?.status, 'recovered-revert');
  assert.equal(f.sent.length, 0); assert.equal(f.keyReads, 0);
  assert.equal((await readJson<{status: string}>(f.path('last-transaction.json')))?.status, 'recovered-revert');
  assert.deepEqual(await readJson(f.path('cycle.json')), f.cycle);
  assert.equal(f.successfulNotes, 0); assert.doesNotMatch(result?.operation?.message ?? '', /cycle is closed/);
});

test('automatic recovery resolves an outstanding journal after ordinary reconcile cleared the winning original', async t => {
  const f = await fixture(t);
  f.mineOnSend = false;
  await auto(f);
  f.mineOriginal();
  await rm(f.path('pending.json'));
  const result = await auto(f);
  assert.equal(result?.operation?.status, 'confirmed'); assert.equal(result?.blocked, false);
  assert.equal((await readJson<RecoveryRecord>(f.path('recovery.json')))?.resolution, 'original-confirmed');
  assert.equal(f.successfulNotes, 1);
  assert.deepEqual(await readJson(f.path('cycle.json')), { ...f.cycle, swapConfirmed: true });
  assert.equal(f.sent.length, 1);
});

test('automatic stop/config/timestamp/signer checks never call the signing key', async t => {
  for (const condition of ['stop', 'changed-config', 'future', 'invalid-time', 'ledger'] as const) {
    const f = await fixture(t);
    if (condition === 'stop') await atomicWriteJson(f.path('stop.json'), { stopped: true });
    if (condition === 'changed-config') f.deps.config = async () => ({ ...config, pollSeconds: 10 });
    if (condition === 'future') f.pending.createdAt = '2099-01-01T00:00:00Z';
    if (condition === 'invalid-time') f.pending.createdAt = 'invalid';
    await atomicWriteJson(f.path('pending.json'), f.pending);
    let result;
    if (condition === 'ledger') {
      const release = await acquireLock(f.deps.dataDir, 'run.lock');
      const selected = { ...config, mode: 'ledger' as const };
      try { result = await automaticRecovery(selected,
        { publicClient: f.rpc as unknown as ReturnType<RecoveryDependencies['rpc']> },
        { dataDir: f.deps.dataDir, account: f.deps.account, config: async () => selected }); }
      finally { await release(); }
      assert.match(result?.operation?.message ?? '', /ledger.*no signer fallback/);
    } else result = await auto(f, { now: () => Date.parse('2026-09-05T20:10:00Z') });
    assert.equal(result?.blocked, true, condition); assert.equal(f.keyReads, 0); assert.equal(f.sent.length, 0);
    assert.deepEqual(await readJson(f.path('pending.json')), f.pending);
  }
});

test('successful-swap marker failure retains pending and retries only receipt resolution', async t => {
  const f = await fixture(t);
  f.mineOriginal();
  const first = await auto(f, { noteSuccessfulSwap: async () => { throw new Error('fixture cycle write failure'); } });
  assert.equal(first?.blocked, true);
  assert.deepEqual(await readJson(f.path('pending.json')), f.pending);
  assert.equal(f.sent.length, 0);
  assert.equal((await auto(f))?.operation?.status, 'confirmed');
  assert.equal(f.sent.length, 0); assert.equal(f.successfulNotes, 1);
  assert.equal(await readJson(f.path('pending.json')), null);
});

test('automatic effects require the current process execution lock', async t => {
  for (const lock of [null, { pid: process.pid + 100, token: 'another-runner' }, { pid: process.pid }] as const) {
    const f = await fixture(t);
    if (lock) await atomicWriteJson(f.path('run.lock'), lock);
    const result = await automaticRecovery(config, { publicClient: f.rpc as unknown as ReturnType<RecoveryDependencies['rpc']> }, {
      dataDir: f.deps.dataDir, config: f.deps.config, account: f.deps.account });
    assert.equal(result?.blocked, true); assert.match(result?.operation?.message ?? '', /execution lock/);
    assert.equal(f.keyReads, 0); assert.equal(f.sent.length, 0);
    assert.equal(await readJson(f.path('recovery.json')), null);
  }
});

test('manual completion of an interrupted automatic resolution marks successful trading before clearing', async t => {
  const f = await fixture(t);
  f.mineOriginal();
  await auto(f, { noteSuccessfulSwap: async () => { throw new Error('interrupted success marker'); } });
  const record = (await readJson<RecoveryRecord>(f.path('recovery.json')))!;
  assert.equal(record.automatic, true); assert.equal(record.resolution, 'original-confirmed');
  assert.equal(record.swapNotedAt, undefined);
  assert.deepEqual(await readJson(f.path('pending.json')), f.pending);
  const note = f.deps.noteSuccessfulSwap;
  f.deps.noteSuccessfulSwap = async original => { assert.ok(await readJson(f.path('pending.json'))); await note(original); };
  assert.equal((await recover({ cancel: true }, f.deps)).outcome, 'original-confirmed');
  assert.ok((await readJson<RecoveryRecord>(f.path('recovery.json')))?.swapNotedAt);
  assert.deepEqual(await readJson(f.path('cycle.json')), { ...f.cycle, swapConfirmed: true });
  assert.equal(await readJson(f.path('pending.json')), null); assert.equal(f.sent.length, 0);
  assert.equal(f.successfulNotes, 1);
});

test('changed configuration cannot resolve a receipt or mutate its cycle', async t => {
  const f = await fixture(t);
  f.mineOriginal('reverted');
  const result = await auto(f, { config: async () => ({ ...config, pollSeconds: 10 }) });
  assert.equal(result?.blocked, true);
  assert.equal(await readJson(f.path('recovery.json')), null);
  assert.deepEqual(await readJson(f.path('pending.json')), f.pending);
  assert.deepEqual(await readJson(f.path('cycle.json')), f.cycle);
});

test('automatic recovery retains safe send diagnostics and bumps above the saved original fee', async t => {
  const f = await fixture(t);
  f.pending.gasPrice = '30'; f.pending.sendFailure = 'underpriced'; f.expectedFee = 60n;
  await atomicWriteJson(f.path('pending.json'), f.pending);
  const waiting = await auto(f, { now: () => Date.parse(f.pending.createdAt) + 1000 });
  assert.equal(waiting?.operation?.sendFailure, 'underpriced');
  assert.equal((await auto(f))?.operation?.status, 'cancelled');
  assert.equal(parseTransaction(f.sent[0]!).gasPrice, 60n);
});

test('confirmed approval recovery never marks a cycle as having a successful swap', async t => {
  for (const automatic of [false, true]) {
    const f = await fixture(t);
    f.pending.kind = 'approval'; await atomicWriteJson(f.path('pending.json'), f.pending);
    f.mineOriginal();
    if (automatic) assert.equal((await auto(f))?.operation?.status, 'confirmed');
    else assert.equal((await recover({ cancel: true }, f.deps)).outcome, 'original-confirmed');
    assert.equal(f.successfulNotes, 0); assert.deepEqual(await readJson(f.path('cycle.json')), f.cycle);
    assert.equal((await readJson<RecoveryRecord>(f.path('recovery.json')))?.swapNotedAt, undefined);
  }
});

test('legacy closure markers do not suppress a successful swap marker or mutate cycle timing', async t => {
  const f = await fixture(t);
  f.mineOnSend = false;
  await auto(f);
  const record = (await readJson<RecoveryRecord>(f.path('recovery.json')))!;
  record.cycleClosedAt = '2026-09-05T20:01:00Z';
  await atomicWriteJson(f.path('recovery.json'), record);
  f.mineOriginal();
  assert.equal((await auto(f))?.operation?.status, 'confirmed');
  assert.equal(f.successfulNotes, 1);
  assert.deepEqual(await readJson(f.path('cycle.json')), { ...f.cycle, swapConfirmed: true });
  assert.equal(await auto(f), null);
  assert.equal(f.successfulNotes, 1, 'completed journal replay cannot mark a later cycle');
});
