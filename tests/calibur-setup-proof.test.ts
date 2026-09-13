import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { encodeFunctionData, TransactionReceiptNotFoundError, type Address, type Hex, type TransactionReceipt } from 'viem';
import { buildCaliburSelfTransaction, buildCaliburSetupTransaction, CALIBUR_ABI, CALIBUR_ADDRESS, CALIBUR_DELEGATION_CODE } from '../src/calibur.js';
import { assertTemporaryTestDirectory } from '../src/test-isolation.js';
import { acquireLock, readJson, type PendingTransaction } from '../src/storage.js';

// All provider methods are local mocks. No device, account loader, signer,
// network transport or real application directory participates in these tests.
const data = await mkdtemp(join(tmpdir(), 'rebalance-calibur-proof-'));
assertTemporaryTestDirectory(data); process.env.REBALANCE_DATA_DIR = data;
const { DATA, CONFIG_PATH, PENDING_PATH, LAST_TRANSACTION_PATH, validateConfig } = await import('../src/config.js');
assert.equal(DATA, data);
const { verifyCaliburSetupReceipt } = await import('../src/calibur-setup-proof.js');
const { reconcile } = await import('../src/transactions.js');
const { recover, automaticRecovery } = await import('../src/recovery.js');
const evidence = JSON.parse(await readFile(new URL('../docs/evidence/calibur-deployment.json', import.meta.url), 'utf8'));
type Chain = Parameters<typeof reconcile>[1];
const wallet = '0x1000000000000000000000000000000000000001' as Address;
const other = '0x1000000000000000000000000000000000000002' as Address;
const hash = `0x${'12'.repeat(32)}` as Hex, blockHash = `0x${'34'.repeat(32)}` as Hex, otherHash = `0x${'56'.repeat(32)}` as Hex;
const config = validateConfig({ version: 1, chainId: 4663, mode: 'ledger', execution: 'calibur', wallet,
  rpcUrl: 'http://127.0.0.1:1', targets: { USDG: 500, AAPL: 2375, AMD: 2375, NVDA: 2375, MSFT: 2375 },
  driftThresholdBps: 500, slippageBps: 50, deadlineSeconds: 120, pollSeconds: 5, rebalanceIntervalSeconds: 3600 });
const pending: PendingTransaction = { chainId: 4663, wallet, hash, kind: 'calibur-setup', nonce: 7, status: 'broadcast', createdAt: '2026-09-13T06:00:00.000Z' };
const protectedNames = ['config.json', 'cycle.json', 'status.json', 'stop.json', 'runner-preference.json'];
const cycle = { wallet, startedAt: Date.parse(pending.createdAt), activeUntil: Date.parse(pending.createdAt) + 600_000,
  nextEligibleAt: Date.parse(pending.createdAt) + 3_600_000, swapConfirmed: false };
const previousOperation = { status: 'confirmed', kind: 'approval', wallet, chainId: 4663, hash: otherHash };
async function protectedState() { return Promise.all(protectedNames.map(name => readFile(join(data, name), 'utf8'))); }
const writeFixture = (path: string, value: unknown) => writeFile(path, JSON.stringify(value), { mode: 0o600 });
async function seed() {
  await rm(data, { recursive: true, force: true }); await mkdir(data, { mode: 0o700 });
  await writeFixture(CONFIG_PATH, config); await writeFixture(PENDING_PATH, pending);
  await writeFixture(LAST_TRANSACTION_PATH, previousOperation); await writeFixture(join(data, 'cycle.json'), cycle);
  await writeFixture(join(data, 'status.json'), { wallet, armed: false, fixture: 'retained holdings' });
  await writeFixture(join(data, 'stop.json'), { requestId: 'existing-stop', requestedAt: pending.createdAt });
  await writeFixture(join(data, 'runner-preference.json'), { enabled: false, wallet });
}
beforeEach(seed); after(() => rm(data, { recursive: true, force: true }));

function fixture(status: 'success' | 'reverted' = 'success') {
  const receipt = { transactionHash: hash, from: wallet, to: wallet, blockNumber: 100n, blockHash, status };
  const tx = { type: 'eip7702', hash, from: wallet, to: wallet, value: 0n, input: buildCaliburSetupTransaction(wallet).data,
    nonce: 7, chainId: 4663, blockNumber: 100n, blockHash,
    authorizationList: [{ chainId: 4663, nonce: 8, address: CALIBUR_ADDRESS as Address }] };
  const state = { code: CALIBUR_DELEGATION_CODE as Hex | undefined, implementation: evidence.runtimeBytecode as Hex,
    chainId: 4663, head: 101n, canonicalBlockHash: blockHash, missingReceipt: false };
  const calls: string[] = [];
  const forbidden = async (): Promise<never> => { throw new Error('Receipt-only fixture must not sign, send, load keys, refresh, pause or resume'); };
  const rpc = {
    async getChainId() { calls.push('chain'); return state.chainId; },
    async getTransactionReceipt(input: { hash: Hex }) {
      calls.push('receipt'); assert.equal(input.hash, hash);
      if (state.missingReceipt) throw new TransactionReceiptNotFoundError(input);
      return receipt;
    },
    async getTransaction(input: { hash: Hex }) { calls.push('transaction'); assert.equal(input.hash, hash); return tx; },
    async getBlock(input: { blockNumber: bigint }) { calls.push('block'); assert.equal(input.blockNumber, receipt.blockNumber); return { hash: state.canonicalBlockHash }; },
    async getBlockNumber() { calls.push('head'); return state.head; },
    async getCode(input: { address: Address; blockNumber: bigint }) {
      calls.push('code'); assert.equal(input.blockNumber, state.head, 'both code reads use the freshly observed block');
      if (input.address.toLowerCase() === CALIBUR_ADDRESS.toLowerCase()) return state.implementation;
      assert.equal(input.address.toLowerCase(), wallet.toLowerCase()); return state.code;
    },
    sendRawTransaction: forbidden, estimateGas: forbidden, getBalance: forbidden,
  };
  const chain = { publicClient: rpc } as unknown as Chain;
  return { tx, receipt, state, calls, chain,
    inspect: () => recover({}, { dataDir: data, config: async () => config, armed: async () => false, rpc: () => chain.publicClient,
      account: forbidden, signer: forbidden, refresh: forbidden, resume: forbidden, pause: forbidden, noteSuccessfulSwap: forbidden, attempts: 1 }),
    resolve: () => automaticRecovery(config, chain, { dataDir: data, config: async () => config, account: forbidden, signer: forbidden,
      noteSuccessfulSwap: forbidden, now: () => Date.parse(pending.createdAt) + 60_000 }),
  };
}
type Fixture = ReturnType<typeof fixture>;
const mismatches: [string, (f: Fixture) => void][] = [
  ['empty account code', f => { f.state.code = '0x'; }],
  ['missing account code', f => { f.state.code = undefined; }],
  ['another delegate', f => { f.state.code = `0xef0100${other.slice(2)}`; }],
  ['changed canonical runtime', f => { f.state.implementation = `${evidence.runtimeBytecode.slice(0, -2)}ff` as Hex; }],
  ['wrong RPC chain', f => { f.state.chainId = 1; }],
  ['plain transfer payload', f => { f.tx.input = '0x'; }],
  ['extra trailing calldata', f => { f.tx.input = `${f.tx.input}00`; }],
  ['nonempty batch', f => { f.tx.input = buildCaliburSelfTransaction(wallet, [{ to: other, value: 0n, data: '0x12345678' }]).data; }],
  ['non-atomic empty batch', f => { f.tx.input = encodeFunctionData({ abi: CALIBUR_ABI, functionName: 'execute', args: [{ calls: [], revertOnFailure: false }] }); }],
  ['nonzero native value', f => { f.tx.value = 1n; }],
  ['wrong transaction nonce', f => { f.tx.nonce = 8; }],
  ['wrong transaction type', f => { f.tx.type = 'legacy'; }],
  ['wrong transaction chain', f => { f.tx.chainId = 1; }],
  ['wrong transaction hash', f => { f.tx.hash = otherHash; }],
  ['wrong transaction sender', f => { f.tx.from = other; }],
  ['wrong transaction target', f => { f.tx.to = other; }],
  ['wrong transaction block', f => { f.tx.blockNumber = 99n; }],
  ['wrong transaction block hash', f => { f.tx.blockHash = otherHash; }],
  ['wrong receipt hash', f => { f.receipt.transactionHash = otherHash; }],
  ['wrong receipt sender', f => { f.receipt.from = other; }],
  ['wrong receipt target', f => { f.receipt.to = other; }],
  ['no authorization', f => { f.tx.authorizationList = []; }],
  ['multiple authorizations', f => { f.tx.authorizationList.push({ ...f.tx.authorizationList[0]! }); }],
  ['unscoped authorization', f => { f.tx.authorizationList[0]!.chainId = 0; }],
  ['wrong authorization chain', f => { f.tx.authorizationList[0]!.chainId = 1; }],
  ['wrong authorization nonce', f => { f.tx.authorizationList[0]!.nonce = 7; }],
  ['wrong authorization target', f => { f.tx.authorizationList[0]!.address = other; }],
];

test('verified empty type4 setup with canonical delegation clears the common receipt barrier without recording a swap', async () => {
  const f = fixture(), before = await protectedState();
  await verifyCaliburSetupReceipt(config, f.chain, pending, f.receipt as TransactionReceipt);
  assert.equal(await readJson(PENDING_PATH) !== null, true, 'proof alone is read-only');
  const result = await reconcile(config, f.chain);
  assert.equal(result.blocked, false); assert.equal(result.operation?.kind, 'calibur-setup'); assert.equal(result.operation?.status, 'confirmed');
  assert.equal(await readJson(PENDING_PATH), null);
  assert.equal((await readJson<{ kind: string }>(LAST_TRANSACTION_PATH))?.kind, 'calibur-setup');
  assert.deepEqual(await protectedState(), before); assert.ok(f.calls.filter(call => call === 'code').length >= 2);
});

test('every setup identity or code mismatch preserves the common pending barrier and prior operation', async t => {
  for (const [name, mutate] of mismatches) await t.test(name, async () => {
    await seed(); const f = fixture(); mutate(f); const before = await protectedState();
    await assert.rejects(reconcile(config, f.chain));
    assert.deepEqual(await readJson(PENDING_PATH), pending); assert.deepEqual(await readJson(LAST_TRANSACTION_PATH), previousOperation);
    assert.deepEqual(await protectedState(), before);
  });
});

test('missing, unconfirmed, reorged or reverted setup receipts never clear common pending state', async () => {
  for (const issue of ['missing', 'one-confirmation', 'reorg', 'reverted']) {
    await seed(); const f = fixture(issue === 'reverted' ? 'reverted' : 'success'); const before = await protectedState();
    if (issue === 'missing') f.state.missingReceipt = true;
    if (issue === 'one-confirmation') f.state.head = 100n;
    if (issue === 'reorg') f.state.canonicalBlockHash = otherHash;
    const result = await reconcile(config, f.chain);
    assert.equal(result.blocked, true, issue);
    assert.equal(result.operation?.status, issue === 'missing' ? 'pending' : issue === 'reverted' ? 'reverted' : 'confirming');
    assert.deepEqual(await readJson(PENDING_PATH), pending); assert.deepEqual(await protectedState(), before);
    assert.equal(f.calls.includes('code'), false, 'no setup completion is claimed ahead of the common receipt gate');
  }
});

test('recovery inspection applies the same setup proof to successful and reverted receipts without any writes', async t => {
  for (const status of ['success', 'reverted'] as const) {
    await t.test(`${status} receipt with correct proof is only an assessment`, async () => {
      await seed(); const f = fixture(status), before = await protectedState();
      const result = await f.inspect();
      assert.equal(result.outcome, status === 'success' ? 'original-confirmed' : 'original-reverted');
      assert.ok(f.calls.includes('code')); assert.deepEqual(await readJson(PENDING_PATH), pending);
      assert.deepEqual(await readJson(LAST_TRANSACTION_PATH), previousOperation); assert.deepEqual(await protectedState(), before);
    });
    for (const [name, mutate] of mismatches) await t.test(`${status}: ${name}`, async () => {
      await seed(); const f = fixture(status); mutate(f); const before = await protectedState();
      assert.equal((await f.inspect()).outcome, 'blocked');
      assert.deepEqual(await readJson(PENDING_PATH), pending); assert.deepEqual(await readJson(LAST_TRANSACTION_PATH), previousOperation);
      assert.deepEqual(await protectedState(), before);
    });
  }
});

test('receipt recovery clears only proven setup, including a reverted execution, and never changes cycle timing', async () => {
  for (const status of ['success', 'reverted'] as const) {
    await seed(); const f = fixture(status), before = await protectedState();
    const release = await acquireLock(data, 'run.lock');
    try {
      const result = await f.resolve();
      assert.equal(result?.blocked, false); assert.equal(result?.operation?.kind, 'calibur-setup');
      assert.equal(result?.operation?.status, status === 'success' ? 'confirmed' : 'recovered-revert');
      assert.equal(await readJson(PENDING_PATH), null);
      assert.equal((await readJson<{ kind: string }>(LAST_TRANSACTION_PATH))?.kind, 'calibur-setup');
      assert.deepEqual(await protectedState(), before);
      assert.ok(f.calls.includes('code'));
    } finally { await release(); }
  }
});

test('automatic receipt recovery retains setup pending for bad proof even when its execution reverted', async () => {
  for (const status of ['success', 'reverted'] as const) for (const [name, mutate] of mismatches) {
    await seed(); const f = fixture(status); mutate(f); const before = await protectedState();
    const release = await acquireLock(data, 'run.lock');
    try {
      assert.equal((await f.resolve())?.blocked, true, `${status}: ${name}`);
      assert.deepEqual(await readJson(PENDING_PATH), pending); assert.deepEqual(await readJson(LAST_TRANSACTION_PATH), previousOperation);
      assert.deepEqual(await protectedState(), before);
    } finally { await release(); }
  }
});
