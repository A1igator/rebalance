import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { decodeFunctionData, encodeFunctionData, erc20Abi, keccak256, parseAbi, parseTransaction,
  type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { recoverAuthorizationAddress } from 'viem/utils';
import { ASSETS } from '../src/assets.js';
import { CALIBUR_ABI, CALIBUR_ADDRESS, CALIBUR_DELEGATION_CODE, buildCaliburSelfTransaction } from '../src/calibur.js';
import { ROUTER, type ChainTransaction } from '../src/chain.js';
import type { CaliburAuthorizationRequest, PreparedTransaction } from '../src/privy.js';
import type { FeeCheck } from '../src/fee-target.js';
import { atomicWriteJson, readJson, type PendingTransaction } from '../src/storage.js';
import { assertTemporaryTestDirectory } from '../src/test-isolation.js';

// Public disposable vectors only. No signer/device/provider/transport is loaded.
const account = privateKeyToAccount(`0x${'1'.padStart(64, '0')}`);
const wallet = account.address;
const data = await mkdtemp(join(tmpdir(), 'rebalance-calibur-dispatch-'));
assertTemporaryTestDirectory(data);
process.env.REBALANCE_DATA_DIR = data;
const { CONFIG_PATH, PENDING_PATH, DATA, validateConfig } = await import('../src/config.js');
assert.equal(DATA, data);
for (const path of [CONFIG_PATH, PENDING_PATH]) assert.ok(path.startsWith(`${data}/`));
const { dispatch, ConfigChangedError } = await import('../src/transactions.js');
type Chain = Parameters<typeof dispatch>[1];
const evidence = JSON.parse(await readFile(new URL('../docs/evidence/calibur-deployment.json', import.meta.url), 'utf8'));
const implementationCode = evidence.runtimeBytecode as Hex;
assert.match(implementationCode, /^0x[0-9a-f]+$/i, 'Committed public Calibur runtime fixture is required');
const routerAbi = parseAbi([
  'function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)',
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
]);
function configuration(feeTarget?: string) {
  return validateConfig({ version: 1, chainId: 4663, wallet, mode: 'ledger', execution: 'calibur', rpcUrl: 'http://127.0.0.1:1',
    targets: { USDG: 500, AAPL: 2375, AMD: 2375, NVDA: 2375, MSFT: 2375 }, driftThresholdBps: 500,
    slippageBps: 50, deadlineSeconds: 120, pollSeconds: 5,
    ...(feeTarget === undefined ? {} : { rebalanceFeeTargetUsdE8: feeTarget }) });
}
beforeEach(async () => { await rm(data, { recursive: true, force: true }); await mkdir(data, { mode: 0o700 }); await atomicWriteJson(CONFIG_PATH, configuration()); });
after(() => rm(data, { recursive: true, force: true }));
function transaction(): ChainTransaction {
  const trades = [
    { sellAssetId: 'AAPL', buyAssetId: 'USDG', amountIn: 10n ** 18n, reason: 'fixture sale' },
    ...['AMD', 'NVDA', 'MSFT'].map(id => ({ sellAssetId: 'USDG', buyAssetId: id, amountIn: 300_000n, reason: 'fixture buy' })),
  ];
  const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 120);
  const swaps = trades.map(trade => encodeFunctionData({ abi: routerAbi, functionName: 'exactInputSingle', args: [{
    tokenIn: ASSETS[trade.sellAssetId as keyof typeof ASSETS].address, tokenOut: ASSETS[trade.buyAssetId as keyof typeof ASSETS].address,
    fee: 500, recipient: wallet, amountIn: trade.amountIn, amountOutMinimum: 1n, sqrtPriceLimitX96: 0n,
  }] }));
  const calls = [
    { to: ASSETS.AAPL.address, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [ROUTER, 10n ** 18n] }) },
    { to: ASSETS.USDG.address, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [ROUTER, 900_000n] }) },
    { to: ROUTER, value: 0n, data: encodeFunctionData({ abi: routerAbi, functionName: 'multicall', args: [expiresAt, swaps] }) },
  ];
  return { ...buildCaliburSelfTransaction(wallet, calls), kind: 'swap', expiresAt, swapCount: 4, approvalCount: 0,
    plan: { trades, reason: 'public offline combined fixture' }, calibur: { approvalCount: 2 } };
}
function fixture(delegated = false) {
  const state = { nonce: 7, accountCode: delegated ? CALIBUR_DELEGATION_CODE as Hex | undefined : undefined,
    implementation: implementationCode, balance: 10n ** 18n };
  const sent: Hex[] = [], authorizations: CaliburAuthorizationRequest[] = [], signed: PreparedTransaction[] = [], estimates: unknown[] = [], trace: string[] = [];
  let afterAuthorization: (() => Promise<void>) | undefined, afterSignature: (() => Promise<void>) | undefined;
  const rpc = {
    getChainId: async () => 4663, getBlockNumber: async () => 100n,
    getCode: async ({ address }: { address: Address }) => address.toLowerCase() === CALIBUR_ADDRESS.toLowerCase() ? state.implementation : state.accountCode,
    getTransactionCount: async () => state.nonce,
    estimateGas: async (request: unknown) => { estimates.push(request); trace.push('estimate'); return 400_000n; },
    getGasPrice: async () => 500_000_000n,
    getBalance: async () => { trace.push('balance'); return state.balance; },
    sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
      const pending = await readJson<PendingTransaction>(PENDING_PATH);
      assert.equal(pending?.hash, keccak256(serializedTransaction)); assert.equal(pending?.status, 'prepared');
      trace.push('send'); sent.push(serializedTransaction); return keccak256(serializedTransaction);
    },
  };
  const signer = async () => ({ address: wallet,
    async signDelegationAuthorization(request: CaliburAuthorizationRequest) {
      trace.push('authorize'); authorizations.push(request);
      const result = await account.signAuthorization(request); await afterAuthorization?.(); return result;
    },
    async signTransaction(input: PreparedTransaction) {
      trace.push('sign'); signed.push(input);
      const result = await account.signTransaction(input); await afterSignature?.(); return result;
    },
  });
  const ledger = { async assertReady() {} };
  return { state, rpc, signer, ledger, chain: { publicClient: rpc } as unknown as Chain, sent, authorizations, signed, estimates, trace,
    afterAuthorization(callback: () => Promise<void>) { afterAuthorization = callback; },
    afterSignature(callback: () => Promise<void>) { afterSignature = callback; } };
}

test('first Calibur use simulates full call before nonce+1 authorization and sends one type4 transaction', async () => {
  const f = fixture(), tx = transaction();
  const result = await dispatch(configuration(), f.chain, tx, f.signer, f.ledger);
  assert.equal(result.status, 'pending'); assert.equal(f.authorizations.length, 1); assert.equal(f.signed.length, 1); assert.equal(f.sent.length, 1);
  assert.deepEqual(f.authorizations[0], { chainId: 4663, address: CALIBUR_ADDRESS, nonce: 8 });
  assert.deepEqual(f.trace, ['estimate', 'balance', 'authorize', 'sign', 'send']);
  assert.deepEqual(f.estimates, [{ account: wallet, to: wallet, data: tx.data, value: 0n,
    stateOverride: [{ address: wallet, code: CALIBUR_DELEGATION_CODE }] }]);
  const parsed = parseTransaction(f.sent[0]!);
  assert.equal(parsed.type, 'eip7702'); assert.equal(parsed.chainId, 4663); assert.equal(parsed.nonce, 7);
  assert.equal(parsed.to?.toLowerCase(), wallet.toLowerCase()); assert.equal(parsed.data, tx.data); assert.equal(parsed.gas, 510_000n);
  assert.equal(parsed.maxFeePerGas, 600_000_000n); assert.equal(parsed.maxPriorityFeePerGas, 600_000_000n);
  assert.equal(parsed.authorizationList?.length, 1);
  assert.equal(await recoverAuthorizationAddress({ authorization: parsed.authorizationList![0]! }), wallet);
  const batch = decodeFunctionData({ abi: CALIBUR_ABI, data: parsed.data! }).args[0];
  assert.equal(batch.revertOnFailure, true); assert.equal(batch.calls.length, 3);
  const router = decodeFunctionData({ abi: routerAbi, data: batch.calls[2]!.data });
  assert.equal(router.functionName, 'multicall');
  assert.ok(router.functionName === 'multicall'); assert.equal(router.args[1].length, 4);
  const saved = await readJson<PendingTransaction>(PENDING_PATH);
  assert.equal(saved?.nonce, 7); assert.equal(saved?.kind, 'swap'); assert.equal(saved?.gas, '510000');
  assert.ok(!JSON.stringify(saved).includes('authorization'));
  assert.deepEqual((await readdir(data)).sort(), ['config.json', 'pending.json']);
});

test('caller changes during deferred authorization cannot replace the validated calldata or input plan', async () => {
  const f = fixture(), tx = transaction();
  const validatedData = tx.data;
  let entered!: () => void, release!: () => void;
  const authorizing = new Promise<void>(resolve => { entered = resolve; });
  const authorized = new Promise<void>(resolve => { release = resolve; });
  f.afterAuthorization(async () => { entered(); await authorized; });
  const dispatching = dispatch(configuration(), f.chain, tx, f.signer, f.ledger);
  await authorizing;
  try {
    // The caller retains its original object while physical authorization waits.
    // None of these edits may alter the already validated transaction snapshot.
    tx.data = '0xdeadbeef';
    tx.to = ASSETS.USDG.address;
    tx.plan!.trades[0]!.amountIn = 2n * 10n ** 18n;
    tx.plan!.trades.splice(1);
    tx.calibur!.approvalCount = 0;
    tx.expiresAt = 0n;
  } finally { release(); }
  assert.equal((await dispatching).status, 'pending');
  assert.equal(f.authorizations.length, 1); assert.equal(f.signed.length, 1); assert.equal(f.sent.length, 1);
  assert.equal(f.signed[0]!.data, validatedData); assert.equal(f.signed[0]!.to, wallet);
  const parsed = parseTransaction(f.sent[0]!);
  assert.equal(parsed.type, 'eip7702'); assert.equal(parsed.data, validatedData);
  assert.equal(parsed.to?.toLowerCase(), wallet.toLowerCase());
  const batch = decodeFunctionData({ abi: CALIBUR_ABI, data: parsed.data! }).args[0];
  assert.equal(batch.calls.length, 3);
  const approval = decodeFunctionData({ abi: erc20Abi, data: batch.calls[0]!.data });
  assert.equal(approval.functionName, 'approve');
  assert.deepEqual(approval.args, [ROUTER, 10n ** 18n]);
  const router = decodeFunctionData({ abi: routerAbi, data: batch.calls[2]!.data });
  assert.ok(router.functionName === 'multicall'); assert.equal(router.args[1].length, 4);
});

test('existing pinned delegation uses one legacy self-call without another authorization', async () => {
  const f = fixture(true), tx = transaction();
  await dispatch(configuration(), f.chain, tx, f.signer, f.ledger);
  assert.equal(f.authorizations.length, 0); assert.equal(f.signed.length, 1); assert.equal(f.sent.length, 1);
  const parsed = parseTransaction(f.sent[0]!);
  assert.equal(parsed.type, 'legacy'); assert.equal(parsed.to?.toLowerCase(), wallet.toLowerCase()); assert.equal(parsed.data, tx.data); assert.equal(parsed.gas, 480_000n);
  assert.deepEqual(f.estimates, [{ account: wallet, to: wallet, data: tx.data, value: 0n }]);
});

test('foreign account code and changed implementation fail before authorization, signing or send', async () => {
  for (const bad of ['account', 'implementation']) {
    const f = fixture();
    if (bad === 'account') f.state.accountCode = `0xef0100${'ab'.repeat(20)}`;
    else f.state.implementation = '0x6000';
    await assert.rejects(dispatch(configuration(), f.chain, transaction(), f.signer, f.ledger), /unsupported account code|pinned runtime/);
    assert.equal(f.authorizations.length, 0); assert.equal(f.signed.length, 0); assert.equal(f.sent.length, 0); assert.equal(await readJson(PENDING_PATH), null);
  }
});

test('Stop, settings, nonce or account changes after authorization prevent outer signing and broadcast', async () => {
  for (const change of ['stop', 'config', 'nonce', 'account', 'implementation']) {
    const f = fixture();
    await atomicWriteJson(CONFIG_PATH, configuration()); await rm(join(data, 'stop.json'), { force: true });
    f.afterAuthorization(async () => {
      if (change === 'stop') await atomicWriteJson(join(data, 'stop.json'), { requestedAt: Date.now() });
      if (change === 'config') await atomicWriteJson(CONFIG_PATH, { ...configuration(), slippageBps: 51 });
      if (change === 'nonce') f.state.nonce++;
      if (change === 'account') f.state.accountCode = CALIBUR_DELEGATION_CODE;
      if (change === 'implementation') f.state.implementation = '0x6000';
    });
    await assert.rejects(dispatch(configuration(), f.chain, transaction(), f.signer, f.ledger),
      error => error instanceof ConfigChangedError || /stopped|account or nonce changed|pinned runtime/.test(String(error)));
    assert.equal(f.authorizations.length, 1); assert.equal(f.signed.length, 0); assert.equal(f.sent.length, 0);
    assert.equal(await readJson(PENDING_PATH), null);
  }
});

test('post-sign nonce change prevents send and authorization rejection is never retried', async () => {
  const moved = fixture(); moved.afterSignature(async () => { moved.state.nonce++; });
  await assert.rejects(dispatch(configuration(), moved.chain, transaction(), moved.signer, moved.ledger), /account or nonce changed/);
  assert.equal(moved.authorizations.length, 1); assert.equal(moved.signed.length, 1); assert.equal(moved.sent.length, 0);
  assert.equal(await readJson(PENDING_PATH), null);
  const rejected = fixture(); rejected.afterAuthorization(async () => { throw new Error('fixture authorization rejected'); });
  await assert.rejects(dispatch(configuration(), rejected.chain, transaction(), rejected.signer, rejected.ledger), /authorization rejected/);
  assert.equal(rejected.authorizations.length, 1); assert.equal(rejected.signed.length, 0); assert.equal(rejected.sent.length, 0);
});

test('unknown Calibur send retains only one outer hash and prevents a second authorization or send', async () => {
  const f = fixture();
  f.rpc.sendRawTransaction = async ({ serializedTransaction }) => { f.sent.push(serializedTransaction); throw new Error('fixture lost response'); };
  const result = await dispatch(configuration(), f.chain, transaction(), f.signer, f.ledger);
  assert.equal(result.status, 'unresolved'); assert.equal(f.sent.length, 1);
  const pending = await readJson<PendingTransaction>(PENDING_PATH);
  assert.equal(pending?.status, 'unknown'); assert.equal(pending?.nonce, 7); assert.equal(pending?.hash, keccak256(f.sent[0]!));
  await assert.rejects(dispatch(configuration(), f.chain, transaction(), f.signer, f.ledger), /pending transaction/);
  assert.equal(f.authorizations.length, 1); assert.equal(f.signed.length, 1); assert.equal(f.sent.length, 1);
});

test('full atomic gas plus authorization cost and fee target are checked before authorizing', async t => {
  const f = fixture(), config = configuration('5000000'), checks: FeeCheck[] = [];
  await atomicWriteJson(CONFIG_PATH, config);
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ data: { base: 'ETH', currency: 'USD', amount: '3000' } })));
  await assert.rejects(dispatch(config, f.chain, transaction(), f.signer, f.ledger, { swaps: 4, async onCheck(check) { checks.push(check); } }), /above the configured target/);
  assert.equal(checks.at(-1)?.estimatedUsdE8, '91800000');
  assert.equal(f.estimates.length, 1); assert.equal(f.authorizations.length, 0); assert.equal(f.signed.length, 0); assert.equal(f.sent.length, 0);
  assert.equal(await readJson(PENDING_PATH), null);
});

test('unsupported full-call simulation or insufficient whole-batch ETH never asks for authorization', async () => {
  const unsupported = fixture();
  unsupported.rpc.estimateGas = async () => { throw new Error('fixture state override unsupported'); };
  await assert.rejects(dispatch(configuration(), unsupported.chain, transaction(), unsupported.signer, unsupported.ledger), /simulation/);
  assert.equal(unsupported.authorizations.length, 0); assert.equal(unsupported.sent.length, 0);
  const poor = fixture(); poor.state.balance = 510_000n * 600_000_000n - 1n;
  await assert.rejects(dispatch(configuration(), poor.chain, transaction(), poor.signer, poor.ledger), /Insufficient native ETH/);
  assert.equal(poor.authorizations.length, 0); assert.equal(poor.sent.length, 0);
});

test('a reverted enrollment keeps its receipt barrier; explicit receipt recovery retries with the existing delegation and nonce N+2', async () => {
  const f = fixture(), config = configuration();
  await dispatch(config, f.chain, transaction(), f.signer, f.ledger);
  const original = await readJson<PendingTransaction>(PENDING_PATH);
  assert.ok(original);
  // EIP-7702 processes the authorization before the atomic call: a reverted call
  // retains delegation and the outer N plus authorization N+1 nonce increments.
  f.state.accountCode = CALIBUR_DELEGATION_CODE; f.state.nonce = 9;
  const blockHash = `0x${'ab'.repeat(32)}` as Hex;
  const receiptRpc = { ...f.rpc,
    async getTransactionReceipt() { return { transactionHash: original.hash, from: wallet, to: wallet, status: 'reverted', blockNumber: 100n, blockHash }; },
    async getTransaction() { return { hash: original.hash, from: wallet, to: wallet, chainId: 4663, nonce: 7, value: 0n, input: transaction().data, blockNumber: 100n, blockHash }; },
    async getBlock() { return { hash: blockHash }; }, async getBlockNumber() { return 101n; },
  };
  const chain = { publicClient: receiptRpc } as unknown as Chain;
  const { reconcile } = await import('../src/transactions.js');
  const observation = await reconcile(config, chain);
  assert.equal(observation.blocked, true); assert.equal(observation.operation?.status, 'reverted');
  await assert.rejects(dispatch(config, chain, transaction(), f.signer, f.ledger), /pending transaction/);
  assert.deepEqual(await readJson(PENDING_PATH), original);
  const { recover } = await import('../src/recovery.js');
  const recovered = await recover({ cancel: true, requestId: 'isolated-confirmed-enrollment-revert' }, {
    dataDir: data, config: async () => config, armed: async () => false, rpc: () => chain.publicClient,
    account: async () => assert.fail('Confirmed receipt recovery must not inspect keys'),
    signer: async () => assert.fail('Confirmed receipt recovery must not sign'),
    resume: async () => assert.fail('Stopped fixture must not resume'), refresh: async () => ({ error: null } as never),
    noteSuccessfulSwap: async () => assert.fail('Reverted enrollment is not a successful swap'), pause: async () => {}, attempts: 1,
  });
  assert.equal(recovered.outcome, 'original-reverted'); assert.equal(await readJson(PENDING_PATH), null);
  assert.equal((await readJson<{ status: string }>(join(data, 'last-transaction.json')))?.status, 'reverted');
  assert.equal(f.state.accountCode, CALIBUR_DELEGATION_CODE); assert.equal(f.state.nonce, 9);
  assert.equal(f.authorizations.length, 1); assert.equal(f.sent.length, 1);
  // Model a subsequent explicit owner Start in this isolated fixture only.
  await rm(join(data, 'stop.json'), { force: true });
  await dispatch(config, chain, transaction(), f.signer, f.ledger);
  assert.equal(f.authorizations.length, 1); assert.equal(f.sent.length, 2);
  const retry = parseTransaction(f.sent[1]!);
  assert.equal(retry.type, 'legacy'); assert.equal(retry.nonce, 9); assert.equal(retry.to?.toLowerCase(), wallet.toLowerCase());
});
