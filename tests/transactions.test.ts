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
const { CONFIG_PATH, KEY_PATH, PENDING_PATH, LAST_TRANSACTION_PATH, loadConfig, validateConfig } = await import('../src/config.js');
const { acquireConfigLock } = await import('../src/config-lock.js');
// Fail before any fixture write if a future static import captures config early.
for (const [name, path] of Object.entries({ CONFIG_PATH, KEY_PATH, PENDING_PATH, LAST_TRANSACTION_PATH })) {
  assert.equal(path.startsWith(`${data}/`), true, `${name} must belong to this disposable fixture`);
}
const { ConfigChangedError, classifyDispatchFailure, dispatch, reconcile, validatePending } = await import('../src/transactions.js');
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
  await assert.rejects(dispatch({ ...configuration(), mode: 'privy' }, h.chain, transaction), /Configuration changed/);
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


test('Privy dispatch uses its selected signer, persists before broadcast and reconciles without a second signature', async () => {
  const c = { ...configuration(), mode: 'privy' as const };
  await atomicWriteJson(CONFIG_PATH, c);
  const { privySigner } = await import('../src/privy.js');
  const h = mockedChain(); let signatures = 0;
  // A deliberately unusable raw-key override proves this mode never falls back to it.
  process.env.REBALANCE_PRIVATE_KEY = 'NOT-A-KEY';
  const signer = await privySigner(wallet, async (args, input) => {
    if (args[0] === 'list-wallets') return `  ethereum: ${wallet} (fixture-wallet)\n`;
    assert.deepEqual(args, ['rpc']);
    const body = JSON.parse(input!); const tx = body.params.transaction;
    assert.equal(body.caip2, 'eip155:4663');
    signatures++;
    const raw = await privateKeyToAccount(key).signTransaction({ chainId: tx.chain_id, type: 'legacy', nonce: tx.nonce,
      gas: BigInt(tx.gas_limit), gasPrice: BigInt(tx.gas_price), value: BigInt(tx.value), data: tx.data, to: tx.to });
    return JSON.stringify({ method: 'eth_signTransaction', data: { encoding: 'rlp', signed_transaction: raw } });
  });
  h.rpc.sendRawTransaction = async ({ serializedTransaction }) => {
    const saved = await readJson<PendingTransaction>(PENDING_PATH);
    assert.equal(saved?.status, 'prepared');
    assert.equal(saved?.hash, keccak256(serializedTransaction));
    h.sent.push(serializedTransaction);
    return keccak256(serializedTransaction);
  };
  const result = await dispatch(c, h.chain, transaction, async () => signer);
  assert.equal(result.status, 'pending');
  await assert.rejects(dispatch(c, h.chain, transaction, async () => { throw new Error('must not sign twice'); }), /Reconcile/);
  assert.equal(signatures, 1);
  assert.equal(h.sent.length, 1);
  const recovered = await reconcile(c, h.chain);
  assert.equal(recovered.operation?.status, 'confirmed');
  assert.equal(await readJson(PENDING_PATH), null);
});

test('Privy signer failure, wrong wallet and stop arriving during signing cannot broadcast', async () => {
  const c = { ...configuration(), mode: 'privy' as const }; await atomicWriteJson(CONFIG_PATH, c);
  const h = mockedChain();
  await assert.rejects(dispatch(c, h.chain, transaction, async () => { throw new Error('Privy unavailable'); }), /Privy unavailable/);
  await assert.rejects(dispatch(c, h.chain, transaction, async () => ({ address: otherWallet, signTransaction: async () => { throw new Error('must not sign'); } })), /key does not match/);
  await assert.rejects(dispatch(c, h.chain, transaction, async () => ({ address: wallet, signTransaction: async tx => {
    await atomicWriteJson(stopPath, { stopped: true });
    return privateKeyToAccount(key).signTransaction(tx);
  } })), /Execution was stopped/);
  assert.equal(h.sent.length, 0);
  assert.equal(await readJson(PENDING_PATH), null);
});

test('Ledger late stop, expiry or abort inside the final intent check cannot broadcast', async t => {
  for (const cause of ['stop', 'expiry', 'abort']) {
    const config = { ...configuration(), mode: 'ledger' as const };
    await atomicWriteJson(CONFIG_PATH, config);
    await rm(stopPath, { force: true });
    const h = mockedChain();
    const abort = new AbortController();
    const now = Date.now();
    let clock = now;
    const mockedDate = t.mock.method(Date, 'now', () => clock);
    let checks = 0;
    try {
      await assert.rejects(dispatch(config, h.chain, { ...transaction, expiresAt: BigInt(Math.floor(now / 1000) + 60) },
        async () => ({ address: wallet, signTransaction: tx => privateKeyToAccount(key).signTransaction(tx) }), {
          signal: abort.signal,
          assertReady: async () => {
            checks++;
            if (!await readJson(PENDING_PATH)) return;
            if (cause === 'stop') await atomicWriteJson(stopPath, { requestedAt: 'fixture' });
            if (cause === 'expiry') clock += 61000;
            if (cause === 'abort') abort.abort(new Error('Fixture cancellation'));
          },
        }));
      assert.ok(checks >= 4);
      assert.equal(h.sent.length, 0);
      assert.equal(await readJson(PENDING_PATH), null);
    } finally { mockedDate.mock.restore(); }
  }
});

// Fee tests use the same disposable public signer fixtures and in-memory RPC.
async function feeConfiguration(target = '1') {
  const config = validateConfig({ ...configuration(), rebalanceFeeTargetUsdE8: target });
  await atomicWriteJson(CONFIG_PATH, config);
  return config;
}
const feeResponse = (amount = '3000') => new Response(JSON.stringify({ data: { base: 'ETH', currency: 'USD', amount } }));

test('an estimated fee above the configured target blocks before signing or submitting', async t => {
  const config = await feeConfiguration(), h = mockedChain();
  h.rpc.getGasPrice = async () => 1_000_000_000n;
  const { FeeTargetError } = await import('../src/fee-target.js');
  t.mock.method(globalThis, 'fetch', async () => feeResponse());
  let signatures = 0;
  const checks: import('../src/fee-target.js').FeeCheck[] = [];
  await assert.rejects(dispatch(config, h.chain, transaction, async () => ({ address: wallet, signTransaction: async tx => {
    signatures++; return privateKeyToAccount(key).signTransaction(tx);
  } }), undefined, { swaps: 1, onCheck: async check => { checks.push(check); } }), error => {
    assert.ok(error instanceof FeeTargetError); assert.equal(error.check.state, 'above-target'); return true;
  });
  assert.equal(checks.length, 1); assert.equal(checks[0].estimatedUsdE8, '81987120');
  assert.equal(signatures, 0); assert.equal(h.sent.length, 0); assert.equal(await readJson(PENDING_PATH), null);
});

test('configured fee target fails closed before signer loading when projection context is missing', async t => {
  const config = await feeConfiguration(), h = mockedChain();
  const { FeeTargetError } = await import('../src/fee-target.js');
  t.mock.method(globalThis, 'fetch', () => assert.fail('Missing projection must not query pricing'));
  let signerLoads = 0;
  for (const fees of [undefined, { swaps: null, onCheck: async () => {} }, { swaps: 0, onCheck: async () => {} }]) {
    await assert.rejects(dispatch(config, h.chain, transaction, async () => {
      signerLoads++; return { address: wallet, signTransaction: async () => assert.fail('Must not sign') };
    }, undefined, fees), error => {
      assert.ok(error instanceof FeeTargetError); assert.equal(error.check.state, 'unavailable'); return true;
    });
  }
  assert.equal(signerLoads, 0); assert.equal(h.sent.length, 0); assert.equal(await readJson(PENDING_PATH), null);
});

test('fresh fee price unavailable blocks before signing and excludes provider text', async t => {
  const config = await feeConfiguration('500000000'), h = mockedChain();
  const { FeeTargetError } = await import('../src/fee-target.js');
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('private-provider-fixture'); });
  let signatures = 0;
  await assert.rejects(dispatch(config, h.chain, transaction, async () => ({ address: wallet, signTransaction: async tx => {
    signatures++; return privateKeyToAccount(key).signTransaction(tx);
  } }), undefined, { swaps: 1, onCheck: async () => {} }), error => {
    assert.ok(error instanceof FeeTargetError); assert.equal(error.check.state, 'unavailable');
    assert.ok(!error.message.includes('private-provider-fixture')); return true;
  });
  assert.equal(signatures, 0); assert.equal(h.sent.length, 0); assert.equal(await readJson(PENDING_PATH), null);
});

test('within-target fees permit the selected fixture signer and preserve ordinary pending tracking', async t => {
  const config = await feeConfiguration('500000000'), h = mockedChain();
  h.rpc.getGasPrice = async () => 1_000_000_000n;
  let quotes = 0, signatures = 0;
  t.mock.method(globalThis, 'fetch', async () => { quotes++; return feeResponse(); });
  const checks: import('../src/fee-target.js').FeeCheck[] = [];
  const result = await dispatch(config, h.chain, transaction, async () => ({ address: wallet, signTransaction: async tx => {
    signatures++; return privateKeyToAccount(key).signTransaction(tx);
  } }), undefined, { swaps: 1, onCheck: async check => { checks.push(check); } });
  assert.equal(result.status, 'pending'); assert.equal(signatures, 1); assert.equal(h.sent.length, 1);
  assert.equal(quotes, 1); assert.equal(checks[0].state, 'within-target');
  assert.equal((await readJson<PendingTransaction>(PENDING_PATH))?.status, 'broadcast');
});

test('fee configuration never weakens the selected signer identity check', async t => {
  const config = await feeConfiguration('500000000'), h = mockedChain();
  t.mock.method(globalThis, 'fetch', () => assert.fail('Wrong signer must be rejected before fee pricing'));
  await assert.rejects(dispatch(config, h.chain, transaction, async () => ({ address: otherWallet,
    signTransaction: async () => assert.fail('Wrong signer must not sign') }), undefined, { swaps: 1, onCheck: async () => {} }), /key does not match/);
  assert.equal(h.sent.length, 0); assert.equal(await readJson(PENDING_PATH), null);
});

test('a quote older than 30 seconds after signing is refreshed and can veto broadcast', async t => {
  const config = await feeConfiguration('50000000'), h = mockedChain();
  h.rpc.getGasPrice = async () => 1_000_000_000n;
  const { FeeTargetError } = await import('../src/fee-target.js');
  let now = Date.now(), quotes = 0, signatures = 0;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async () => { quotes++; return feeResponse(quotes === 1 ? '1000' : '9999'); });
  const checks: import('../src/fee-target.js').FeeCheck[] = [];
  await assert.rejects(dispatch(config, h.chain, transaction, async () => ({ address: wallet, signTransaction: async tx => {
    signatures++; now += 31_000; return privateKeyToAccount(key).signTransaction(tx);
  } }), undefined, { swaps: 1, onCheck: async check => { checks.push(check); } }), error => {
    assert.ok(error instanceof FeeTargetError); assert.equal(error.check.state, 'above-target'); return true;
  });
  assert.equal(quotes, 2); assert.equal(signatures, 1);
  assert.deepEqual(checks.map(check => check.state), ['within-target', 'above-target']);
  assert.equal(h.sent.length, 0); assert.equal(await readJson(PENDING_PATH), null);
});

test('a fee recheck veto after durable preparation removes only the known-unsent pending record', async t => {
  const config = await feeConfiguration('50000000'), h = mockedChain();
  h.rpc.getGasPrice = async () => 1_000_000_000n;
  const { FeeTargetError } = await import('../src/fee-target.js');
  const base = Date.now(); let quotes = 0, aged = false;
  t.mock.method(Date, 'now', () => { aged ||= existsSync(PENDING_PATH); return base + (aged ? 31_000 : 0); });
  t.mock.method(globalThis, 'fetch', async () => { quotes++; return feeResponse(quotes === 1 ? '1000' : '9999'); });
  await assert.rejects(dispatch(config, h.chain, transaction, undefined, undefined, { swaps: 1, onCheck: async () => {} }), error => {
    assert.ok(error instanceof FeeTargetError); assert.equal(error.check.state, 'above-target'); return true;
  });
  assert.equal(quotes, 2); assert.equal(h.sent.length, 0); assert.equal(await readJson(PENDING_PATH), null);
});

test('an unset fee target preserves automatic dispatch without any price request', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Unset targets must not add a price dependency'));
  const h = mockedChain();
  assert.equal((await dispatch(configuration(), h.chain, transaction)).status, 'pending');
  assert.equal(h.sent.length, 1);
});

// Config edits use the same short lock as the CLI, with fixture public state.
const editConfig = async (next: ReturnType<typeof configuration>) => {
  const release = await acquireConfigLock(data);
  try { await atomicWriteJson(CONFIG_PATH, next); } finally { await release(); }
};
const liveChanges = {
  'fee target': (c: ReturnType<typeof configuration>) => ({ ...c, rebalanceFeeTargetUsdE8: '5000000' }),
  'target weights': (c: ReturnType<typeof configuration>) => ({ ...c, targets: { ...c.targets, USDG: 9000, AAPL: 1000 } }),
  'drift trigger': (c: ReturnType<typeof configuration>) => ({ ...c, driftThresholdBps: 750 }),
  'cycle interval': (c: ReturnType<typeof configuration>) => ({ ...c, rebalanceIntervalSeconds: 7200 }),
};
for (const [label, change] of Object.entries(liveChanges)) {
  for (const boundary of ['RPC preparation', 'signing'] as const) {
    test(`${label} can change during ${boundary} and prevents an obsolete broadcast`, async () => {
      const c = configuration(), h = mockedChain(); let signatures = 0;
      if (boundary === 'RPC preparation') h.rpc.getBalance = async () => {
        await editConfig(change(c)); return 10n ** 18n;
      };
      await assert.rejects(dispatch(c, h.chain, transaction, async () => ({ address: wallet, signTransaction: async tx => {
        signatures++;
        if (boundary === 'signing') await editConfig(change(c));
        return privateKeyToAccount(key).signTransaction(tx);
      } })), ConfigChangedError);
      assert.equal(signatures, boundary === 'signing' ? 1 : 0);
      assert.equal(h.sent.length, 0); assert.equal(await readJson(PENDING_PATH), null);
      assert.deepEqual(await readJson(CONFIG_PATH), change(c));
      assert.equal(await readJson(join(data, 'config.lock')), null);
    });
  }
}

for (const mode of ['privy', 'ledger'] as const) test(`${mode} signing waits permit settings edits without broadcasting their old signature`, async () => {
  const c = { ...configuration(), mode }, h = mockedChain();
  await atomicWriteJson(CONFIG_PATH, c);
  let signatures = 0;
  await assert.rejects(dispatch(c, h.chain, transaction, async () => ({ address: wallet, signTransaction: async tx => {
    signatures++; await editConfig({ ...c, driftThresholdBps: 1000 });
    return privateKeyToAccount(key).signTransaction(tx);
  } }), mode === 'ledger' ? { assertReady: async () => {} } : undefined), ConfigChangedError);
  assert.equal(signatures, 1); assert.equal(h.sent.length, 0); assert.equal(await readJson(PENDING_PATH), null);
});

test('a setting saved while dispatch waits for the final lock wins over its prepared signature', async () => {
  const c = configuration(), h = mockedChain();
  let releaseWriter!: () => Promise<void>, signed!: () => void;
  const signatureReady = new Promise<void>(resolve => { signed = resolve; });
  const dispatching = dispatch(c, h.chain, transaction, async () => ({ address: wallet, signTransaction: async tx => {
    releaseWriter = await acquireConfigLock(data);
    const serialized = await privateKeyToAccount(key).signTransaction(tx);
    signed(); return serialized;
  } }));
  const rejected = assert.rejects(dispatching, ConfigChangedError);
  await signatureReady;
  try { await atomicWriteJson(CONFIG_PATH, { ...c, driftThresholdBps: 900 }); }
  finally { await releaseWriter(); }
  await rejected;
  assert.equal(h.sent.length, 0); assert.equal(await readJson(PENDING_PATH), null);
});

for (const response of ['success', 'unknown'] as const) test(`edits during an in-flight ${response} send preserve its original receipt barrier`, async () => {
  const c = configuration(), h = mockedChain();
  let invoked!: () => void, finish!: () => void;
  const started = new Promise<void>(resolve => { invoked = resolve; });
  const waitResponse = new Promise<void>(resolve => { finish = resolve; });
  h.rpc.sendRawTransaction = async ({ serializedTransaction }) => {
    assert.equal(existsSync(join(data, 'config.lock')), true, 'the actual invocation serializes with setting writers');
    assert.equal(existsSync(PENDING_PATH), true);
    h.sent.push(serializedTransaction); invoked();
    await waitResponse;
    if (response === 'unknown') throw new Error('fixture response lost');
    return keccak256(serializedTransaction);
  };
  const dispatching = dispatch(c, h.chain, transaction);
  await started;
  const barrier = await readJson<PendingTransaction>(PENDING_PATH);
  assert.equal(barrier?.status, 'prepared');
  const next = { ...c, driftThresholdBps: 900, rebalanceIntervalSeconds: 7200 };
  try {
    await editConfig(next);
    assert.deepEqual(await readJson(PENDING_PATH), barrier);
  } finally { finish(); }
  const result = await dispatching;
  assert.equal(result.status, response === 'success' ? 'pending' : 'unresolved');
  assert.equal(h.sent.length, 1);
  assert.equal((await readJson<PendingTransaction>(PENDING_PATH))?.hash, barrier?.hash);
  assert.deepEqual(await readJson(CONFIG_PATH), next);
  assert.equal((await reconcile(next, h.chain)).operation?.status, 'confirmed');
  assert.equal(await readJson(PENDING_PATH), null);
});

test('a synchronous send invocation failure remains uncertain after the config lock releases', async () => {
  const h = mockedChain();
  h.rpc.sendRawTransaction = () => { throw new Error('fixture synchronous transport failure'); };
  const result = await dispatch(configuration(), h.chain, transaction);
  assert.equal(result.status, 'unresolved');
  assert.equal((await readJson<PendingTransaction>(PENDING_PATH))?.status, 'unknown');
  assert.equal(await readJson(join(data, 'config.lock')), null);
});

test('configuration change after durable preparation removes only the known-unsent barrier', async t => {
  const c = configuration(), h = mockedChain(), now = Date.now();
  const next = { ...c, driftThresholdBps: 900 };
  t.mock.method(Date, 'now', () => {
    if (existsSync(PENDING_PATH)) writeFileSync(CONFIG_PATH, JSON.stringify(next));
    return now;
  });
  await assert.rejects(dispatch(c, h.chain, { ...transaction, expiresAt: BigInt(Math.floor(now / 1000) + 60) }), ConfigChangedError);
  assert.equal(h.sent.length, 0); assert.equal(await readJson(PENDING_PATH), null);
  assert.deepEqual(await readJson(CONFIG_PATH), next);
});

test('a Ledger intent error caused by a settings edit is classified as a quiet config change', async () => {
  const c = { ...configuration(), mode: 'ledger' as const }, h = mockedChain();
  await atomicWriteJson(CONFIG_PATH, c);
  await assert.rejects(dispatch(c, h.chain, transaction, async () => assert.fail('No signer should be loaded'), {
    assertReady: async () => {
      await editConfig({ ...c, driftThresholdBps: 900 });
      throw new Error('The previous device intent ended');
    },
  }), ConfigChangedError);
  assert.equal(h.sent.length, 0); assert.equal(await readJson(PENDING_PATH), null);
});

test('an aborted Ledger signer after a config edit is classified without a stale broadcast', async () => {
  const c = { ...configuration(), mode: 'ledger' as const }, h = mockedChain();
  await atomicWriteJson(CONFIG_PATH, c);
  await assert.rejects(dispatch(c, h.chain, transaction, async () => ({ address: wallet, signTransaction: async () => {
    await editConfig({ ...c, driftThresholdBps: 900 });
    throw new Error('Fixture device prompt aborted');
  } }), { assertReady: async () => {} }), ConfigChangedError);
  assert.equal(h.sent.length, 0); assert.equal(await readJson(PENDING_PATH), null);
});


test('retired gas settings block persisted configuration and dispatch without native fallback or rewriting files', async () => {
  const selected = configuration();
  await atomicWriteJson(CONFIG_PATH, { ...selected, gasPayment: null });
  const before = await readFile(CONFIG_PATH, 'utf8');
  await assert.rejects(loadConfig(), /saved gasPayment setting is no longer supported/);
  const h = mockedChain();
  let rpcCalls = 0, signerLoads = 0;
  h.rpc.getChainId = async () => { rpcCalls++; return 4663; };
  await assert.rejects(dispatch(selected, h.chain, transaction, async () => {
    signerLoads++; throw new Error('Must not load a signer');
  }), /saved gasPayment setting is no longer supported/);
  assert.equal(rpcCalls, 0); assert.equal(signerLoads, 0); assert.deepEqual(h.sent, []);
  assert.equal(await readFile(CONFIG_PATH, 'utf8'), before);
  for (const path of [PENDING_PATH, LAST_TRANSACTION_PATH, stopPath]) assert.equal(existsSync(path), false);
});

test('retired and unknown pending transports retain their exact barrier before native receipt reads', async () => {
  const config = configuration();
  const original = await pending();
  const h = mockedChain();
  let chainReads = 0, receiptReads = 0;
  h.rpc.getChainId = async () => { chainReads++; return 4663; };
  h.rpc.getTransactionReceipt = async () => { receiptReads++; throw new Error('Must not read a native receipt'); };
  for (const marker of [{ transport: 'alchemy-usdg', userOperation: { callId: fixtureHash } },
    { transport: 'unknown' }, { transport: null }, { userOperation: null }, { userOperation: {} }]) {
    await atomicWriteJson(PENDING_PATH, { ...original, ...marker });
    const before = await readFile(PENDING_PATH, 'utf8');
    await assert.rejects(reconcile(config, h.chain), /Pending transport or user-operation metadata is unsupported/);
    assert.equal(await readFile(PENDING_PATH, 'utf8'), before);
    assert.equal(existsSync(LAST_TRANSACTION_PATH), false);
    assert.equal(existsSync(stopPath), false);
  }
  assert.throws(() => validatePending({ ...original, transport: undefined } as PendingTransaction, config), /metadata is unsupported/);
  assert.equal(chainReads, 0); assert.equal(receiptReads, 0); assert.deepEqual(h.sent, []);
});
