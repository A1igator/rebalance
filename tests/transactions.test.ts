import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { ExecutionRevertedError, FeeCapTooLowError, InsufficientFundsError, IntrinsicGasTooLowError,
  keccak256, NonceTooLowError, parseTransaction, recoverTransactionAddress, RpcRequestError,
  TransactionReceiptNotFoundError, type Hex, type TransactionSerialized } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { atomicWriteJson, readJson, type PendingTransaction } from '../src/storage.js';
import type { ChainTransaction } from '../src/chain.js';

// Disposable public fixtures only. No client below has a network transport.
const key = `0x${'1'.padStart(64, '0')}` as const;
const otherKey = `0x${'2'.padStart(64, '0')}` as const;
const wallet = privateKeyToAccount(key).address;
const otherWallet = privateKeyToAccount(otherKey).address;
const data = await mkdtemp(join(tmpdir(), 'rebalance-transactions-'));
process.env.REBALANCE_DATA_DIR = data;
process.env.REBALANCE_PRIVATE_KEY = key;
// These modules capture DATA at import time, after the isolated environment exists.
const { CONFIG_PATH, KEY_PATH, PENDING_PATH, LAST_TRANSACTION_PATH, validateConfig } = await import('../src/config.js');
const { classifyDispatchFailure, dispatch, reconcile, validatePending } = await import('../src/transactions.js');
type Chain = Parameters<typeof dispatch>[1];
const blockHash = `0x${'ab'.repeat(32)}` as Hex;
const fixtureHash = `0x${'cd'.repeat(32)}` as Hex;
const stopPath = join(data, 'stop.json');

function configuration() {
  return validateConfig({
    version: 1, chainId: 4663, wallet, mode: 'private-key', rpcUrl: 'http://127.0.0.1:1',
    targets: { USDG: 10_000, TSLA: 0, AAPL: 0, NVDA: 0, AMZN: 0 },
    driftThresholdBps: 500, slippageBps: 50, deadlineSeconds: 120, pollSeconds: 30,
  });
}

beforeEach(async () => {
  await rm(data, { recursive: true, force: true });
  await mkdir(data, { mode: 0o700 });
  process.env.REBALANCE_PRIVATE_KEY = key;
  await writeFile(KEY_PATH, `${key}\n`, { mode: 0o600 });
  await atomicWriteJson(CONFIG_PATH, configuration());
});
after(() => rm(data, { recursive: true, force: true }));

const transaction: ChainTransaction = { to: otherWallet, data: '0x1234', value: 0n, kind: 'approval' };

function mockedChain() {
  const sent: Hex[] = [];
  const rpc = {
    getChainId: async () => 4663,
    getTransactionCount: async (_args: { blockTag: string }) => 7,
    estimateGas: async () => 21_000n,
    getGasPrice: async () => 2n,
    getBalance: async () => 10n ** 18n,
    sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }): Promise<Hex> => {
      sent.push(serializedTransaction);
      return keccak256(serializedTransaction);
    },
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => ({
      transactionHash: hash, from: wallet, status: 'success', blockNumber: 100n, blockHash,
    }),
    getBlock: async () => ({ hash: blockHash }),
    getBlockNumber: async () => 101n,
  };
  return { rpc, sent, chain: { publicClient: rpc } as unknown as Chain };
}

async function pending(): Promise<PendingTransaction> {
  const record: PendingTransaction = {
    chainId: 4663, wallet, hash: fixtureHash, nonce: 7, kind: 'swap',
    createdAt: new Date().toISOString(), status: 'broadcast',
  };
  await atomicWriteJson(PENDING_PATH, record);
  return record;
}

test('dispatch persists the prepared hash before sending and signs the intended chain/account/fields', async () => {
  const h = mockedChain();
  h.rpc.sendRawTransaction = async ({ serializedTransaction }) => {
    const record = await readJson<PendingTransaction>(PENDING_PATH);
    assert.ok(record);
    assert.equal(record.status, 'prepared');
    assert.equal(record.hash, keccak256(serializedTransaction));
    assert.equal(record.wallet, wallet);
    assert.equal(record.chainId, 4663);
    assert.equal(record.nonce, 7);
    const decoded = parseTransaction(serializedTransaction);
    assert.equal(decoded.chainId, 4663);
    assert.equal(decoded.nonce, 7);
    assert.equal(decoded.to?.toLowerCase(), transaction.to.toLowerCase());
    assert.equal(decoded.data, transaction.data);
    assert.equal(decoded.gas, 25_200n);
    assert.equal(decoded.gasPrice, 3n);
    assert.equal(record.gas, decoded.gas.toString());
    assert.equal(record.gasPrice, decoded.gasPrice.toString());
    assert.equal((await recoverTransactionAddress({ serializedTransaction: serializedTransaction as TransactionSerialized })).toLowerCase(), wallet.toLowerCase());
    h.sent.push(serializedTransaction);
    return keccak256(serializedTransaction);
  };
  const result = await dispatch(configuration(), h.chain, transaction);
  assert.equal(h.sent.length, 1);
  assert.equal(result.hash, keccak256(h.sent[0]!));
  assert.equal(result.status, 'pending');
  assert.equal((await readJson<PendingTransaction>(PENDING_PATH))!.status, 'broadcast');
});

test('initial legacy fee headroom uses exact ceiling arithmetic including beyond Number precision', async () => {
  for (const [suggested, expected] of [
    [1n, 2n], [5n, 6n], [101n, 122n], [9_007_199_254_740_993n, 10_808_639_105_689_192n],
  ]) {
    await rm(PENDING_PATH, { force: true });
    const h = mockedChain();
    h.rpc.getGasPrice = async () => suggested!;
    h.rpc.getBalance = async () => 25_200n * expected!;
    await dispatch(configuration(), h.chain, transaction);
    assert.equal(h.sent.length, 1);
    assert.equal(parseTransaction(h.sent[0]!).gasPrice, expected);
    assert.equal((await readJson<PendingTransaction>(PENDING_PATH))!.gasPrice, expected!.toString());
  }
});

test('balance must cover the buffered fee and invalid or overflowing suggestions never dispatch', async () => {
  const h = mockedChain();
  h.rpc.getGasPrice = async () => 5n;
  h.rpc.getBalance = async () => 25_200n * 6n - 1n;
  await assert.rejects(dispatch(configuration(), h.chain, transaction), /Insufficient native ETH/);
  h.rpc.getBalance = async () => 25_200n * 6n;
  await assert.rejects(dispatch(configuration(), h.chain, { ...transaction, value: 1n }), /Insufficient native ETH/);
  h.rpc.getBalance = async () => 2n ** 256n - 1n;
  for (const suggestion of [0n, -1n, 2n ** 256n, 2n ** 256n - 1n]) {
    h.rpc.getGasPrice = async () => suggestion;
    await assert.rejects(dispatch(configuration(), h.chain, transaction), /invalid gas-price|exceeds uint256/);
  }
  assert.equal(h.sent.length, 0);
  assert.equal(await readJson(PENDING_PATH), null);
});

test('optional fee provenance validates without invalidating legacy pending records', async () => {
  const legacy = await pending();
  validatePending(legacy, configuration());
  validatePending({ ...legacy, gas: '25200', gasPrice: '2' }, configuration());
  validatePending({ ...legacy, gasPrice: '2', sendFailure: 'underpriced' }, configuration());
  for (const field of ['gas', 'gasPrice'] as const) {
    for (const value of ['0', '-1', '01', '1.5', '0x20', '', 'fixture-secret', (2n ** 256n).toString(), 123]) {
      assert.throws(() => validatePending({ ...legacy, [field]: value } as PendingTransaction, configuration()),
        /Pending transaction.*invalid/);
    }
  }
  assert.throws(() => validatePending({ ...legacy, sendFailure: 'fixture-secret' } as never, configuration()), /invalid/);
  assert.deepEqual(await readJson(PENDING_PATH), legacy, 'validation must not rewrite the pending record');
});

test('unknown or mismatched send outcomes preserve the original hash and block another send', async () => {
  for (const outcome of ['timeout', 'different-hash']) {
    await rm(PENDING_PATH, { force: true });
    const h = mockedChain();
    h.rpc.sendRawTransaction = async ({ serializedTransaction }) => {
      h.sent.push(serializedTransaction);
      if (outcome === 'timeout') throw new Error('Simulated uncertain send');
      return fixtureHash;
    };
    const result = await dispatch(configuration(), h.chain, transaction);
    const record = await readJson<PendingTransaction>(PENDING_PATH);
    assert.equal(result.status, 'unresolved');
    assert.equal(record!.status, 'unknown');
    assert.equal(record!.hash, keccak256(h.sent[0]!));
    assert.equal(record!.gas, '25200');
    assert.equal(record!.gasPrice, '3');
    assert.equal(record!.sendFailure, 'unknown');
    await assert.rejects(dispatch(configuration(), h.chain, transaction), /pending transaction/);
    assert.equal(h.sent.length, 1);
  }
});

test('recognized rejection diagnostics remain unknown sends, retain fee/hash identity and exclude provider payloads', async () => {
  const secret = 'fixture-secret-provider-body';
  const rejection = (code: number, message: string, serialized: Hex) => new RpcRequestError({
    body: { method: 'eth_sendRawTransaction', params: [serialized], credential: secret },
    error: { code, message: `${message} ${secret}`, data: { privateKey: key } },
    url: `https://fixture.invalid/${secret}`,
  });
  const cases: { failure: string; error: (serialized: Hex) => unknown }[] = [
    { failure: 'underpriced', error: () => new FeeCapTooLowError() },
    { failure: 'gas', error: () => new IntrinsicGasTooLowError() },
    { failure: 'nonce', error: () => new NonceTooLowError() },
    { failure: 'balance', error: () => new Error(secret, { cause: new InsufficientFundsError() }) },
    { failure: 'reverted', error: () => new ExecutionRevertedError({ message: secret }) },
    { failure: 'underpriced', error: serialized => rejection(-32000, 'replacement transaction underpriced', serialized) },
    { failure: 'gas', error: serialized => rejection(-32003, 'intrinsic gas too low', serialized) },
    { failure: 'nonce', error: serialized => rejection(-32000, 'already known', serialized) },
    { failure: 'balance', error: serialized => rejection(-32003, 'insufficient funds', serialized) },
    { failure: 'reverted', error: serialized => rejection(3, 'provider custom text', serialized) },
    { failure: 'unknown', error: serialized => rejection(-32000, 'provider custom text', serialized) },
    { failure: 'unknown', error: () => new Error(secret) },
  ];
  for (const example of cases) {
    await rm(PENDING_PATH, { force: true });
    const h = mockedChain();
    h.rpc.sendRawTransaction = async ({ serializedTransaction }) => {
      h.sent.push(serializedTransaction);
      throw example.error(serializedTransaction);
    };
    const result = await dispatch(configuration(), h.chain, transaction);
    const record = await readJson<PendingTransaction>(PENDING_PATH);
    assert.equal(result.status, 'unresolved');
    assert.equal(result.sendFailure, example.failure);
    assert.equal(record!.status, 'unknown');
    assert.equal(record!.sendFailure, example.failure);
    assert.equal(record!.hash, keccak256(h.sent[0]!));
    assert.equal(record!.gas, '25200');
    assert.equal(record!.gasPrice, '3');
    h.rpc.getTransactionReceipt = async () => { throw new TransactionReceiptNotFoundError({ hash: record!.hash as Hex }); };
    const reconciled = await reconcile(configuration(), h.chain);
    assert.equal(reconciled.blocked, true);
    assert.equal(reconciled.operation?.sendFailure, example.failure);
    assert.equal(reconciled.operation?.status, 'unresolved');
    assert.match(reconciled.operation!.message!, /outcome remains unverified/);
    const publicText = JSON.stringify([result, reconciled]) + await readFile(PENDING_PATH, 'utf8');
    for (const value of [secret, key, h.sent[0]!]) assert.equal(publicText.includes(value), false);
    await assert.rejects(dispatch(configuration(), h.chain, transaction), /pending transaction/);
    assert.equal(h.sent.length, 1, 'a diagnostic classification must never trigger retry');
  }
});

test('cyclic or malformed provider error objects safely fall back without inspecting request bodies', () => {
  const cycle: { cause?: unknown } = {};
  cycle.cause = cycle;
  assert.equal(classifyDispatchFailure(cycle), 'unknown');
  assert.equal(classifyDispatchFailure({ get name() { throw new Error('fixture-secret-getter'); } }), 'unknown');
  assert.equal(classifyDispatchFailure({ name: 'Error', message: 'insufficient funds',
    get body() { return assert.fail('request bodies must never be read'); } }), 'unknown');
  assert.equal(classifyDispatchFailure({ code: -32003, message: 'provider custom text' }), 'unknown');
});

test('successful receipts clear pending only after two observed confirmations and durable result storage', async () => {
  const h = mockedChain();
  await pending();
  h.rpc.getBlockNumber = async () => 100n;
  assert.equal((await reconcile(configuration(), h.chain)).operation!.status, 'confirming');
  assert.ok(await readJson(PENDING_PATH));
  assert.equal(await readJson(LAST_TRANSACTION_PATH), null);
  h.rpc.getBlockNumber = async () => 101n;
  const result = await reconcile(configuration(), h.chain);
  assert.equal(result.blocked, false);
  assert.equal(result.operation!.status, 'confirmed');
  assert.equal(result.operation!.wallet, wallet);
  assert.equal(result.operation!.chainId, 4663);
  assert.equal(await readJson(PENDING_PATH), null);
  assert.deepEqual(await readJson(LAST_TRANSACTION_PATH), result.operation);
  assert.equal(h.sent.length, 0);
});

test('last receipts remain scoped to their wallet/network; legacy records do not imply completion', async () => {
  const h = mockedChain();
  const confirmed = { status: 'confirmed', kind: 'swap', hash: fixtureHash, wallet, chainId: 4663 };
  await atomicWriteJson(LAST_TRANSACTION_PATH, confirmed);
  assert.deepEqual((await reconcile(configuration(), h.chain)).operation, confirmed);
  assert.equal((await reconcile({ ...configuration(), wallet: otherWallet }, h.chain)).operation, null);
  for (const unscoped of [
    { status: 'confirmed', kind: 'swap', hash: fixtureHash },
    { ...confirmed, chainId: 1 },
    { ...confirmed, wallet: otherWallet },
  ]) {
    await atomicWriteJson(LAST_TRANSACTION_PATH, unscoped);
    assert.deepEqual(await reconcile(configuration(), h.chain), { blocked: false, operation: null });
    assert.deepEqual(await readJson(LAST_TRANSACTION_PATH), unscoped, 'history must remain on disk');
  }
  assert.equal(h.sent.length, 0);
});

test('missing, reverted, or reorganized receipts retain the barrier', async () => {
  const h = mockedChain();
  const record = await pending();
  h.rpc.getTransactionReceipt = async () => { throw new TransactionReceiptNotFoundError({ hash: fixtureHash }); };
  assert.equal((await reconcile(configuration(), h.chain)).operation!.status, 'pending');
  assert.deepEqual(await readJson(PENDING_PATH), record);
  h.rpc.getTransactionReceipt = async ({ hash }) => ({ transactionHash: hash, from: wallet, status: 'reverted', blockNumber: 100n, blockHash });
  assert.equal((await reconcile(configuration(), h.chain)).operation!.status, 'reverted');
  assert.deepEqual(await readJson(PENDING_PATH), record);
  h.rpc.getTransactionReceipt = async ({ hash }) => ({ transactionHash: hash, from: wallet, status: 'success', blockNumber: 100n, blockHash });
  h.rpc.getBlock = async () => ({ hash: fixtureHash });
  assert.equal((await reconcile(configuration(), h.chain)).operation!.status, 'confirming');
  assert.deepEqual(await readJson(PENDING_PATH), record);
  assert.equal(h.sent.length, 0);
});

test('wrong receipt hash or sender cannot clear pending', async () => {
  const h = mockedChain();
  await pending();
  h.rpc.getTransactionReceipt = async () => ({ transactionHash: blockHash, from: wallet, status: 'success', blockNumber: 100n, blockHash });
  await assert.rejects(reconcile(configuration(), h.chain), /Receipt hash differs/);
  h.rpc.getTransactionReceipt = async ({ hash }) => ({ transactionHash: hash, from: otherWallet, status: 'success', blockNumber: 100n, blockHash });
  await assert.rejects(reconcile(configuration(), h.chain), /Receipt sender differs/);
  assert.ok(await readJson(PENDING_PATH));
});

test('wrong key, wrong RPC chain, external pending nonce and failed estimation never send', async () => {
  const h = mockedChain();
  process.env.REBALANCE_PRIVATE_KEY = otherKey;
  await assert.rejects(dispatch(configuration(), h.chain, transaction), /key does not match/);
  process.env.REBALANCE_PRIVATE_KEY = key;
  h.rpc.getChainId = async () => 1;
  await assert.rejects(dispatch(configuration(), h.chain, transaction), /not Robinhood/);
  h.rpc.getChainId = async () => 4663;
  h.rpc.getTransactionCount = async ({ blockTag }) => blockTag === 'pending' ? 8 : 7;
  await assert.rejects(dispatch(configuration(), h.chain, transaction), /another pending transaction/);
  h.rpc.getTransactionCount = async () => 7;
  h.rpc.estimateGas = async () => { throw new Error('Simulated revert'); };
  await assert.rejects(dispatch(configuration(), h.chain, transaction), /estimation failed/);
  assert.equal(h.sent.length, 0);
  assert.equal(await readJson(PENDING_PATH), null);
});

test('configuration changes and unsupported signers cannot silently dispatch', async () => {
  const h = mockedChain();
  await assert.rejects(dispatch({ ...configuration(), pollSeconds: 60 }, h.chain, transaction), /Configuration changed/);
  await assert.rejects(dispatch({ ...configuration(), mode: 'ledger' }, h.chain, transaction), /no fallback/);
  await assert.rejects(dispatch({ ...configuration(), mode: 'privy' }, h.chain, transaction), /no fallback/);
  assert.equal(h.sent.length, 0);
});

test('stop or deadline after RPC preparation prevents signing and dispatch', async () => {
  const h = mockedChain();
  h.rpc.getBalance = async () => {
    await atomicWriteJson(stopPath, { stopped: true });
    return 10n ** 18n;
  };
  await assert.rejects(dispatch(configuration(), h.chain, transaction), /Execution was stopped/);
  await rm(stopPath);
  h.rpc.getBalance = async () => 10n ** 18n;
  await assert.rejects(dispatch(configuration(), h.chain, { ...transaction, kind: 'swap', expiresAt: 1n }), /deadline expired/);
  assert.equal(h.sent.length, 0);
  assert.equal(await readJson(PENDING_PATH), null);
});

test('expiry after durable preparation removes the known-unsent record without broadcasting', async (t) => {
  const h = mockedChain();
  const now = 2_000_000_000;
  t.mock.method(Date, 'now', () => (existsSync(PENDING_PATH) ? now + 60 : now) * 1_000);
  await assert.rejects(dispatch(configuration(), h.chain, { ...transaction, kind: 'swap', expiresAt: BigInt(now + 30) }), /deadline expired/);
  assert.equal(h.sent.length, 0);
  assert.equal(await readJson(PENDING_PATH), null);
});

test('stop arriving after durable preparation removes only the known-unsent barrier', async (t) => {
  const h = mockedChain();
  const now = 2_000_000_000;
  t.mock.method(Date, 'now', () => {
    if (existsSync(PENDING_PATH)) writeFileSync(stopPath, JSON.stringify({ stopped: true }), { mode: 0o600 });
    return now * 1_000;
  });
  await assert.rejects(dispatch(configuration(), h.chain, { ...transaction, kind: 'swap', expiresAt: BigInt(now + 30) }), /Execution was stopped/);
  assert.equal(h.sent.length, 0);
  assert.equal(await readJson(PENDING_PATH), null);
  assert.ok(await readJson(stopPath));
});
