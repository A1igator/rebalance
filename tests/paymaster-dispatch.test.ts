import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test, type TestContext } from 'node:test';
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, hashMessage, parseAbi, recoverMessageAddress, serializeSignature, toHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { entryPoint07Abi, getUserOperationHash, type UserOperation } from 'viem/account-abstraction';
import { hashAuthorization } from 'viem/utils';
import { atomicWriteJson, readJson, type PendingTransaction } from '../src/storage.js';
import {
  PAYMASTER_ACCOUNT_ABI, PAYMASTER_ACCOUNT_ID, PAYMASTER_CHAIN_HEX, PAYMASTER_CHAIN_ID,
  PAYMASTER_DELEGATE, PAYMASTER_ENTRY_POINT, PAYMASTER_NONCE_KEY, PAYMASTER_USDG,
} from '../src/paymaster-protocol.js';
import { FeeTargetError } from '../src/fee-target.js';
import type { TradePlan } from '../src/core.js';
import type { ChainTransaction } from '../src/chain.js';
import type { PaymasterRpc } from '../src/paymaster-rpc.js';

// Every signature below uses this public offline fixture. No key file or network transport exists.
const owner = privateKeyToAccount(`0x${'33'.repeat(32)}`);
const wrongOwner = privateKeyToAccount(`0x${'44'.repeat(32)}`);
const PAYMASTER = '0x0000000000000000000000000000000000000010' as Address;
const ROUTER = '0x0000000000000000000000000000000000000020' as Address;
const NONCE = PAYMASTER_NONCE_KEY << 64n;
const FEE = 10_000n;
const APPROVE_ABI = parseAbi(['function approve(address spender, uint256 amount) returns (bool)']);
const data = await mkdtemp(join(tmpdir(), 'rebalance-paymaster-dispatch-'));
process.env.REBALANCE_DATA_DIR = data;
const { CONFIG_PATH, PENDING_PATH, LAST_TRANSACTION_PATH, validateConfig } = await import('../src/config.js');
for (const path of [CONFIG_PATH, PENDING_PATH, LAST_TRANSACTION_PATH]) assert.equal(path.startsWith(data + '/'), true, 'all state must belong to this disposable fixture');
const { dispatchPaymaster, paymasterPrepareRequest, preparePaymaster, preparePaymasterTrade, paymasterFeeCheck, PaymasterBalanceError, reconcilePaymaster, acknowledgePaymasterRevert } = await import('../src/paymaster.js');
const { ConfigChangedError, reconcile } = await import('../src/transactions.js');
type Config = ReturnType<typeof validateConfig>;
type Chain = Parameters<typeof dispatchPaymaster>[1];
type Signer = Exclude<Parameters<typeof dispatchPaymaster>[3], undefined>;
const transaction: ChainTransaction = {
  to: ROUTER, data: '0x12345678', value: 0n, kind: 'swap', usdgSpent: 1_000_000n,
  calls: [{ to: ROUTER, data: '0x12345678', value: 0n }],
};
function configuration(overrides: Partial<Config> = {}): Config {
  return validateConfig({
    version: 1, chainId: 4663, wallet: owner.address, mode: 'private-key', rpcUrl: 'http://127.0.0.1:1',
    targets: { USDG: 10_000, AAPL: 0, NVDA: 0, MSFT: 0, AMD: 0 },
    driftThresholdBps: 500, slippageBps: 50, deadlineSeconds: 120, pollSeconds: 30,
    gasPayment: { provider: 'alchemy', token: 'USDG', policyId: '11111111-2222-4333-8444-555555555555', paymaster: PAYMASTER },
    ...overrides,
  });
}
beforeEach(async () => {
  await rm(data, { recursive: true, force: true });
  await mkdir(data, { mode: 0o700 });
  await atomicWriteJson(CONFIG_PATH, configuration());
});
after(() => rm(data, { recursive: true, force: true }));

function harness() {
  const state = {
    delegated: true, nonce: 5, pendingNonce: 5, operationNonce: NONCE, balance: 2_000_000n, allowance: FEE,
    fee: FEE, chainId: 4663, delegateCode: '0x1234' as Hex,
  };
  const prepares: any[] = [];
  const sends: any[] = [];
  const signed: string[] = [];
  let mutatePreparation: (value: any) => void = () => {};
  let beforeSign: (kind: string) => Promise<void> = async () => {};
  let sendResult: (payload: any) => unknown | Promise<unknown> = payload => {
    const op = payload.type === 'array' ? payload.data[1] : payload;
    const uo = decodeUserOperation(op.data);
    const hash = getUserOperationHash({ userOperation: uo, chainId: 4663, entryPointAddress: PAYMASTER_ENTRY_POINT, entryPointVersion: '0.7' });
    return { id: `${toHex(4663, { size: 32 })}${hash.slice(2)}` };
  };
  const rpc = {
    getChainId: async () => state.chainId,
    getBlockNumber: async () => 100n,
    getTransactionCount: async (args: { blockTag: string }) => args.blockTag === 'pending' ? state.pendingNonce : state.nonce,
    getCode: async (args: { address: Address }) => {
      if (args.address.toLowerCase() === owner.address.toLowerCase()) return state.delegated ? `0xef0100${PAYMASTER_DELEGATE.slice(2)}` as Hex : '0x';
      return state.delegateCode;
    },
    readContract: async (args: { functionName: string; args?: unknown[] }): Promise<bigint | string> => {
      if (args.functionName === 'getNonce') { assert.equal(args.args?.[1], PAYMASTER_NONCE_KEY); return state.operationNonce; }
      if (args.functionName === 'balanceOf') return state.balance;
      if (args.functionName === 'allowance') return state.allowance;
      if (args.functionName === 'accountId') return PAYMASTER_ACCOUNT_ID;
      throw new Error('Unexpected contract read in fixture');
    },
    sendRawTransaction: async () => assert.fail('must never fall back to a native transaction'),
  };
  function response(request: any): any {
    const calls = request.calls.map((call: any) => ({ target: call.to, data: call.data, value: BigInt(call.value) }));
    if (state.allowance < state.fee) calls.unshift({ target: PAYMASTER_USDG, value: 0n,
      data: encodeFunctionData({ abi: APPROVE_ABI, functionName: 'approve', args: [PAYMASTER, state.fee] }) });
    const uo: UserOperation<'0.7'> = {
      sender: owner.address, nonce: state.operationNonce,
      callData: encodeFunctionData({ abi: PAYMASTER_ACCOUNT_ABI, functionName: 'executeBatch', args: [calls] }),
      callGasLimit: 350_000n, verificationGasLimit: 100_000n, preVerificationGas: 50_000n,
      maxFeePerGas: 20_000_000n, maxPriorityFeePerGas: 1_000_000n,
      paymaster: PAYMASTER, paymasterData: '0x1234', paymasterVerificationGasLimit: 100_000n, paymasterPostOpGasLimit: 50_000n,
      signature: '0x',
    };
    const hash = getUserOperationHash({ userOperation: uo, chainId: 4663, entryPointAddress: PAYMASTER_ENTRY_POINT, entryPointVersion: '0.7' });
    const op = { type: 'user-operation-v070', chainId: PAYMASTER_CHAIN_HEX,
      data: Object.fromEntries(Object.entries(uo).filter(([k]) => k !== 'signature').map(([k, v]) => [k, typeof v === 'bigint' ? toHex(v) : v])),
      feePayment: { sponsored: false, tokenAddress: PAYMASTER_USDG, maxAmount: toHex(state.fee) },
      ...(!request.capabilities.paymasterService.onlyEstimation ? {
        signatureRequest: { type: 'personal_sign', data: { raw: hash }, rawPayload: hashMessage({ raw: hash }) },
      } : {}),
    };
    const value = state.delegated ? op : { type: 'array', data: [
      { type: 'authorization', chainId: PAYMASTER_CHAIN_HEX, data: { address: PAYMASTER_DELEGATE, nonce: toHex(state.nonce) },
        signatureRequest: { type: 'eip7702Auth', rawPayload: hashAuthorization({ chainId: 4663, address: PAYMASTER_DELEGATE, nonce: state.nonce }) } }, op,
    ] };
    mutatePreparation(value);
    return value;
  }
  const provider: PaymasterRpc = async (method, params) => {
    if (method === 'wallet_prepareCalls') { prepares.push(params[0]); return response(params[0]); }
    if (method === 'wallet_sendPreparedCalls') {
      // This checks the invocation boundary synchronously, before the caller may release its lock.
      const pending = JSON.parse(readFileSync(PENDING_PATH, 'utf8'));
      assert.equal(pending.status, 'prepared');
      assert.equal(pending.transport, 'alchemy-usdg');
      assert.equal(pending.wallet, owner.address);
      assert.equal(pending.userOperation.userOperationNonce, NONCE.toString());
      assert.equal(pending.userOperation.maxTokenAmount, state.fee.toString());
      assert.equal(existsSync(join(data, 'config.lock')), true);
      assert.equal(readFileSync(PENDING_PATH, 'utf8').includes('signature'), false);
      sends.push(params[0]);
      return sendResult(params[0]);
    }
    throw new Error('Unexpected provider method in fixture');
  };
  const signer: Signer = async () => ({
    address: owner.address,
    signTransaction: async () => assert.fail('must never sign a native transaction'),
    signMessageHash: async hash => { signed.push('operation'); await beforeSign('operation'); return owner.signMessage({ message: { raw: hash } }); },
    signAuthorization: async input => { signed.push('authorization'); await beforeSign('authorization');
      return serializeSignature(await owner.signAuthorization({ chainId: input.chainId, contractAddress: input.address, nonce: input.nonce })); },
  });
  return { state, prepares, sends, signed, rpc, chain: { publicClient: rpc } as unknown as Chain, provider, signer,
    mutatePreparation: (fn: typeof mutatePreparation) => { mutatePreparation = fn; },
    beforeSign: (fn: typeof beforeSign) => { beforeSign = fn; },
    sendResult: (fn: typeof sendResult) => { sendResult = fn; },
  };
}
function decodeUserOperation(data: any): UserOperation<'0.7'> {
  const fields = ['nonce', 'callGasLimit', 'verificationGasLimit', 'preVerificationGas', 'maxFeePerGas', 'maxPriorityFeePerGas', 'paymasterVerificationGasLimit', 'paymasterPostOpGasLimit'];
  return { ...data, ...Object.fromEntries(fields.map(field => [field, BigInt(data[field])])), signature: '0x' };
}
const feeContext = { swaps: 1, onCheck: async () => {} };

test('request pins native EOA, delegate version, nonce lane and USDG postOp exact approval', () => {
  const req = paymasterPrepareRequest(configuration(), transaction, true);
  assert.equal(req.from, owner.address);
  assert.equal(req.chainId, '0x1237');
  assert.deepEqual(req.capabilities.eip7702Auth, { delegation: 'ModularAccountV2', version: 'v1.1.0' });
  assert.deepEqual(req.capabilities.nonceOverride, { nonceKey: '0x0' });
  assert.deepEqual(req.capabilities.paymasterService.erc20, { tokenAddress: PAYMASTER_USDG, postOpSettings: { autoApprove: true } });
  assert.equal(req.capabilities.paymasterService.onlyEstimation, true);
});

test('passive quotes never sign or send and include the fee-token reserve', async () => {
  const h = harness();
  const result = await preparePaymaster(configuration(), h.chain, transaction, true, h.provider);
  assert.equal(result.prepared.signingRequired, false);
  assert.equal(result.prepared.feeTokenAmount, FEE);
  assert.equal(h.prepares.length, 1); assert.deepEqual(h.signed, []); assert.deepEqual(h.sends, []);
  assert.equal(await readJson(PENDING_PATH), null);
  h.state.balance = transaction.usdgSpent! + FEE - 1n;
  await assert.rejects(preparePaymaster(configuration(), h.chain, transaction, true, h.provider), PaymasterBalanceError);
});

test('first-use delegation is sequential and signs only locally recomputed payloads', async () => {
  const h = harness(); h.state.delegated = false; h.state.allowance = 0n;
  const result = await dispatchPaymaster(configuration(), h.chain, transaction, h.signer, undefined, undefined, h.provider);
  assert.deepEqual(h.signed, ['authorization', 'operation']);
  assert.equal(h.prepares.length, 2);
  assert.equal(h.prepares[0].capabilities.paymasterService.onlyEstimation, true);
  assert.equal(h.prepares[1].capabilities.paymasterService.onlyEstimation, false);
  assert.equal(h.sends.length, 1);
  const sent = h.sends[0];
  assert.equal(sent.type, 'array'); assert.equal(sent.data.length, 2);
  assert.equal(sent.data[0].data.address, PAYMASTER_DELEGATE);
  assert.equal(sent.data[0].data.nonce, '0x5');
  const op = sent.data[1];
  const hash = getUserOperationHash({ userOperation: decodeUserOperation(op.data), chainId: 4663, entryPointAddress: PAYMASTER_ENTRY_POINT, entryPointVersion: '0.7' });
  assert.equal(await recoverMessageAddress({ message: { raw: hash }, signature: op.signature.data }), owner.address);
  assert.equal(result.hash, hash); assert.equal(result.status, 'pending');
  assert.equal((await readJson<any>(PENDING_PATH))?.status, 'broadcast');
});

test('existing delegation requires only the user-operation signature', async () => {
  const h = harness(); await dispatchPaymaster(configuration(), h.chain, transaction, h.signer, undefined, undefined, h.provider);
  assert.deepEqual(h.signed, ['operation']); assert.equal(h.sends[0].type, 'user-operation-v070');
});

test('above-target quote waits before policy reservation and signing', async () => {
  const h = harness(); const config = configuration({ rebalanceFeeTargetUsdE8: '999999' });
  await atomicWriteJson(CONFIG_PATH, config);
  await assert.rejects(dispatchPaymaster(config, h.chain, transaction, h.signer, undefined, feeContext, h.provider), FeeTargetError);
  assert.equal(h.prepares.length, 1); assert.deepEqual(h.signed, []); assert.deepEqual(h.sends, []);
});

test('fee projection uses the maximum USDG quote for every remaining swap', async () => {
  const h = harness(); const config = configuration({ rebalanceFeeTargetUsdE8: '2000000' });
  const quote = await preparePaymaster(config, h.chain, transaction, true, h.provider);
  assert.equal(paymasterFeeCheck(config, quote.prepared, 2, quote.observedAt).state, 'within-target');
  assert.equal(paymasterFeeCheck(config, quote.prepared, 3, quote.observedAt).state, 'above-target');
  assert.equal(paymasterFeeCheck(config, quote.prepared, null, quote.observedAt).state, 'unavailable');
});

test('config changes during signing invalidate the quote before submission', async () => {
  const h = harness(); h.beforeSign(async () => { await atomicWriteJson(CONFIG_PATH, configuration({ driftThresholdBps: 600 })); });
  await assert.rejects(dispatchPaymaster(configuration(), h.chain, transaction, h.signer, undefined, undefined, h.provider), ConfigChangedError);
  assert.deepEqual(h.sends, []); assert.equal(await readJson(PENDING_PATH), null);
});

test('stopping during signing prevents any submission', async () => {
  const h = harness(); h.beforeSign(async () => { await atomicWriteJson(join(data, 'stop.json'), { stopped: true }); });
  await assert.rejects(dispatchPaymaster(configuration(), h.chain, transaction, h.signer, undefined, undefined, h.provider), /stopped/);
  assert.deepEqual(h.sends, []); assert.equal(await readJson(PENDING_PATH), null);
});

test('fresh account nonce, balance and allowance are rechecked after signing', async () => {
  for (const mutate of [
    (h: ReturnType<typeof harness>) => { h.state.operationNonce++; },
    (h: ReturnType<typeof harness>) => { h.state.balance = transaction.usdgSpent!; },
    (h: ReturnType<typeof harness>) => { h.state.allowance = FEE - 1n; },
  ]) {
    const h = harness(); h.beforeSign(async () => { mutate(h); });
    await assert.rejects(dispatchPaymaster(configuration(), h.chain, transaction, h.signer, undefined, undefined, h.provider), /Wallet state changed|allowance/i);
    assert.deepEqual(h.sends, []); assert.equal(await readJson(PENDING_PATH), null);
  }
});

test('provider tampering is rejected before signer acquisition', async () => {
  const h = harness(); h.mutatePreparation(value => { value.data.sender = wrongOwner.address; });
  const forbiddenSigner: Signer = async () => assert.fail('must reject before loading a signer');
  await assert.rejects(dispatchPaymaster(configuration(), h.chain, transaction, forbiddenSigner, undefined, undefined, h.provider), /identity or nonce mismatch/);
  assert.deepEqual(h.sends, []); assert.equal(await readJson(PENDING_PATH), null);
});

test('missing signer capabilities cannot silently use a native fallback', async () => {
  const h = harness();
  const unsupported: Signer = async () => ({ address: owner.address, signTransaction: async () => assert.fail('native fallback forbidden') });
  await assert.rejects(dispatchPaymaster(configuration(), h.chain, transaction, unsupported, undefined, undefined, h.provider), /does not support/);
  assert.deepEqual(h.sends, []); assert.equal(await readJson(PENDING_PATH), null);
});

test('Ledger connection alone is insufficient to trigger signatures', async () => {
  const h = harness(); const config = configuration({ mode: 'ledger' }); await atomicWriteJson(CONFIG_PATH, config);
  await assert.rejects(dispatchPaymaster(config, h.chain, transaction, h.signer, undefined, undefined, h.provider), /explicit rebalance request/);
  assert.equal(h.prepares.length, 0); assert.deepEqual(h.signed, []); assert.deepEqual(h.sends, []);
});

test('lost send response preserves its exact operation barrier and prevents resubmission', async () => {
  const h = harness(); h.sendResult(() => { throw new Error('provider private diagnostics'); });
  const result = await dispatchPaymaster(configuration(), h.chain, transaction, h.signer, undefined, undefined, h.provider);
  const pending = await readJson<any>(PENDING_PATH);
  assert.equal(pending.status, 'unknown'); assert.equal(pending.hash, result.hash);
  assert.equal(pending.userOperation.userOperationNonce, NONCE.toString());
  assert.equal(pending.userOperation.callId, `${toHex(4663, { size: 32 })}${result.hash!.slice(2)}`);
  assert.equal(JSON.stringify(result).includes('provider private diagnostics'), false);
  await assert.rejects(dispatchPaymaster(configuration(), h.chain, transaction, h.signer, undefined, undefined, h.provider), /existing pending operation/);
  assert.equal(h.sends.length, 1);
});

test('an unrelated response id does not imply acceptance of our operation', async () => {
  const h = harness(); h.sendResult(() => ({ id: '0x1234' }));
  const result = await dispatchPaymaster(configuration(), h.chain, transaction, h.signer, undefined, undefined, h.provider);
  assert.equal((await readJson<any>(PENDING_PATH))?.status, 'unknown');
  assert.match(result.message!, /uncertain/);
});

test('a pending native transaction and wrong network fail before provider preparation', async () => {
  for (const mutate of [
    (h: ReturnType<typeof harness>) => { h.state.pendingNonce++; },
    (h: ReturnType<typeof harness>) => { h.state.chainId = 1; },
    (h: ReturnType<typeof harness>) => { h.state.delegateCode = '0x'; },
  ]) {
    const h = harness(); mutate(h);
    await assert.rejects(preparePaymaster(configuration(), h.chain, transaction, true, h.provider));
    assert.equal(h.prepares.length, 0); assert.deepEqual(h.signed, []);
  }
});

const previousRoute = { amountOut: 1n, minimumOut: 1n, fee: 500, blockNumber: 1n };
function tradeChain(h: ReturnType<typeof harness>, onBuild?: (trade: TradePlan) => void) {
  const built: TradePlan[] = [];
  const chain = { ...h.chain, transaction: async (trade: TradePlan, _prior: unknown, options: { batch?: boolean } = {}) => {
    assert.equal(options.batch, true);
    built.push({ ...trade }); onBuild?.(trade);
    // Bind the exact rebuilt amount in the mocked requested calldata as a real builder does.
    const data = toHex(trade.amountIn, { size: 32 });
    return { ...transaction, data, usdgSpent: trade.sellAssetId === 'USDG' ? trade.amountIn : 0n,
      calls: [{ to: ROUTER, data, value: 0n }] };
  } } as unknown as Chain;
  return { chain, built };
}

test('USDG buys rebuild a smaller exact amount while preserving quoted gas for all remaining swaps', async () => {
  const h = harness(); h.state.balance = 1_000_000n;
  const original = { sellAssetId: 'USDG', buyAssetId: 'AAPL', amountIn: h.state.balance, reason: 'test drift' };
  const t = tradeChain(h);
  const result = await preparePaymasterTrade(configuration(), t.chain, original, previousRoute, 2, h.provider);
  assert.deepEqual(t.built.map(trade => trade.amountIn), [1_000_000n, 980_000n]);
  assert.equal(result.trade.amountIn, 980_000n);
  assert.equal(result.transaction.usdgSpent, 980_000n);
  assert.equal(result.transaction.data, toHex(980_000n, { size: 32 }));
  assert.equal(original.amountIn, 1_000_000n);
  assert.equal(h.prepares.length, 2); assert.deepEqual(h.signed, []); assert.deepEqual(h.sends, []);
  assert.ok(h.prepares.every(request => request.capabilities.paymasterService.onlyEstimation === true));
});

test('USDG balance equal to the fee reserve never builds a zero or negative swap', async () => {
  const h = harness(); h.state.balance = FEE;
  const t = tradeChain(h);
  await assert.rejects(preparePaymasterTrade(configuration(), t.chain,
    { sellAssetId: 'USDG', buyAssetId: 'AAPL', amountIn: FEE, reason: 'test drift' }, previousRoute, 1, h.provider), PaymasterBalanceError);
  assert.deepEqual(t.built.map(trade => trade.amountIn), [FEE]);
  assert.deepEqual(h.signed, []); assert.deepEqual(h.sends, []);
});

test('changing fee quotes stop after three unsigned rebuild attempts without submission', async () => {
  const h = harness(); h.state.balance = 1_000_000n;
  const t = tradeChain(h, () => { h.state.fee += 1_000n; });
  await assert.rejects(preparePaymasterTrade(configuration(), t.chain,
    { sellAssetId: 'USDG', buyAssetId: 'AAPL', amountIn: h.state.balance, reason: 'test drift' }, previousRoute, 1, h.provider), /fee quotes changed/);
  assert.equal(t.built.length, 3); assert.equal(h.prepares.length, 3);
  assert.deepEqual(h.signed, []); assert.deepEqual(h.sends, []);
  assert.equal(await readJson(PENDING_PATH), null);
});

test('selling a stock preserves its amount and still requires existing USDG for gas', async () => {
  const h = harness(); h.state.balance = FEE;
  const original = { sellAssetId: 'AAPL', buyAssetId: 'USDG', amountIn: 50n, reason: 'test drift' };
  const t = tradeChain(h);
  const result = await preparePaymasterTrade(configuration(), t.chain, original, previousRoute, 2, h.provider);
  assert.equal(result.trade.amountIn, 50n); assert.equal(result.transaction.usdgSpent, 0n);
  assert.equal(t.built.length, 1);
  h.state.balance = FEE - 1n;
  await assert.rejects(preparePaymasterTrade(configuration(), t.chain, original, previousRoute, 2, h.provider), PaymasterBalanceError);
  assert.deepEqual(h.signed, []); assert.deepEqual(h.sends, []);
});

test('a changed account identifier fails before requesting any provider quote', async () => {
  const h = harness(); const original = h.rpc.readContract;
  h.rpc.readContract = async args => args.functionName === 'accountId' ? 'unexpected.account.1.0.0' : original(args);
  await assert.rejects(preparePaymaster(configuration(), h.chain, transaction, true, h.provider), /identity|account/i);
  assert.equal(h.prepares.length, 0); assert.deepEqual(h.signed, []);
});

const OP_HASH = `0x${'55'.repeat(32)}` as Hex;
const BUNDLE_HASH = `0x${'66'.repeat(32)}` as Hex;
const CANONICAL_BLOCK_HASH = `0x${'77'.repeat(32)}` as Hex;
const CYCLE_PATH = join(data, 'cycle.json');
async function receiptFixture(success: boolean) {
  const startedAt = Date.now() - 10_000;
  const pending: PendingTransaction = {
    transport: 'alchemy-usdg', chainId: 4663, wallet: owner.address, hash: OP_HASH, nonce: 5,
    kind: 'swap', status: 'broadcast', createdAt: new Date(startedAt + 1000).toISOString(),
    userOperation: { paymaster: PAYMASTER, userOperationNonce: NONCE.toString(), submittedAtBlock: '90',
      maxTokenAmount: FEE.toString(), callId: `${toHex(4663, { size: 32 })}${OP_HASH.slice(2)}` },
  };
  const cycle = { wallet: owner.address, startedAt, activeUntil: startedAt + 600_000,
    nextEligibleAt: startedAt + 3_600_000, swapConfirmed: false };
  await atomicWriteJson(PENDING_PATH, pending); await atomicWriteJson(CYCLE_PATH, cycle);
  const event = {
    address: PAYMASTER_ENTRY_POINT, blockHash: CANONICAL_BLOCK_HASH, blockNumber: 100n,
    transactionHash: BUNDLE_HASH, logIndex: 2, transactionIndex: 0, removed: false,
    topics: encodeEventTopics({ abi: entryPoint07Abi, eventName: 'UserOperationEvent', args: {
      userOpHash: OP_HASH, sender: owner.address, paymaster: PAYMASTER,
    } }),
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }],
      [NONCE, success, 123_456n, 234_567n]),
  };
  const receipt = { transactionHash: BUNDLE_HASH, blockHash: CANONICAL_BLOCK_HASH, blockNumber: 100n,
    to: PAYMASTER_ENTRY_POINT, from: ROUTER, status: 'success', logs: [event] };
  const state = { head: 101n, showEvent: true };
  const scans: { fromBlock: bigint; toBlock: bigint }[] = [];
  const rpc = {
    getChainId: async () => 4663,
    getBlockNumber: async () => state.head,
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ number: blockNumber, hash: CANONICAL_BLOCK_HASH }),
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => { assert.equal(hash, BUNDLE_HASH, 'only the bundle hash is a transaction hash'); return receipt; },
    getLogs: async (args: { fromBlock: bigint; toBlock: bigint }) => {
      scans.push(args);
      return state.showEvent && event.blockNumber >= args.fromBlock && event.blockNumber <= args.toBlock ? [event] : [];
    },
    getTransactionCount: async () => assert.fail('UserOperation receipts must not inspect or cancel the native nonce'),
    sendRawTransaction: async () => assert.fail('receipt reconciliation must not submit a transaction'),
  };
  const provider: PaymasterRpc = async (method, params, route) => {
    assert.equal(method, 'eth_getUserOperationReceipt'); assert.deepEqual(params, [OP_HASH]); assert.equal(route, 'bundler');
    return state.showEvent ? { receipt: { transactionHash: BUNDLE_HASH } } : null;
  };
  return { pending, cycle, state, scans, receipt, chain: { publicClient: rpc } as unknown as Chain, provider };
}
function mockDefaultReceiptProvider(t: TestContext) {
  // Public credential-shaped fixture plus intercepted fetch: never reads a real provider file.
  process.env.REBALANCE_ALCHEMY_API_KEY = 'offline-fixture-api-key-00000000';
  t.after(() => { delete process.env.REBALANCE_ALCHEMY_API_KEY; });
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const request = JSON.parse(String(init.body));
    assert.equal(request.method, 'eth_getUserOperationReceipt'); assert.deepEqual(request.params, [OP_HASH]);
    requests++;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { receipt: { transactionHash: BUNDLE_HASH } } }));
  });
  return () => requests;
}

test('canonical success records a successful swap cadence and then clears its operation barrier', async () => {
  const f = await receiptFixture(true);
  const result = await reconcilePaymaster(configuration(), f.chain, f.pending, f.provider);
  assert.equal(result.blocked, false); assert.equal(result.operation.status, 'confirmed');
  assert.equal(result.operation.hash, BUNDLE_HASH); assert.equal(result.operation.wallet, owner.address);
  assert.deepEqual(await readJson(CYCLE_PATH), { ...f.cycle, swapConfirmed: true });
  assert.equal(await readJson(PENDING_PATH), null);
  assert.equal((await readJson<any>(LAST_TRANSACTION_PATH))?.status, 'confirmed');
});

test('a cadence recording failure retains the confirmed operation barrier for retry', async () => {
  const f = await receiptFixture(true);
  await atomicWriteJson(CYCLE_PATH, { ...f.cycle, activeUntil: f.cycle.startedAt - 1 });
  await assert.rejects(reconcilePaymaster(configuration(), f.chain, f.pending, f.provider), /Invalid rebalance cycle record/);
  const retained = await readJson<PendingTransaction>(PENDING_PATH);
  assert.equal(retained?.hash, OP_HASH); assert.equal(retained?.transport, 'alchemy-usdg');
  await atomicWriteJson(CYCLE_PATH, f.cycle);
  await reconcilePaymaster(configuration(), f.chain, retained!, f.provider);
  assert.equal((await readJson<any>(CYCLE_PATH))?.swapConfirmed, true);
  assert.equal(await readJson(PENDING_PATH), null);
});

for (const mode of ['private-key', 'privy'] as const) {
  test(`a canonical failed ${mode} UserOperation clears its barrier without recording swap success`, async () => {
    const f = await receiptFixture(false);
    const result = await reconcilePaymaster(configuration({ mode }), f.chain, f.pending, f.provider);
    assert.equal(result.blocked, false); assert.equal(result.operation.status, 'recovered-revert');
    assert.equal(result.operation.hash, BUNDLE_HASH);
    assert.equal(await readJson(PENDING_PATH), null);
    assert.deepEqual(await readJson(CYCLE_PATH), f.cycle);
    assert.equal((await readJson<any>(LAST_TRANSACTION_PATH))?.status, 'recovered-revert');
  });
}

test('a failed Ledger UserOperation retains its barrier until explicit verified acknowledgement', async t => {
  const f = await receiptFixture(false); const config = configuration({ mode: 'ledger' });
  const result = await reconcilePaymaster(config, f.chain, f.pending, f.provider);
  assert.equal(result.blocked, true); assert.equal(result.operation.status, 'reverted');
  assert.equal((await readJson<PendingTransaction>(PENDING_PATH))?.hash, OP_HASH);
  assert.equal(await readJson(LAST_TRANSACTION_PATH), null);
  assert.deepEqual(await readJson(CYCLE_PATH), f.cycle);
  const requestCount = mockDefaultReceiptProvider(t);
  const retained = (await readJson<PendingTransaction>(PENDING_PATH))!;
  const hash = await acknowledgePaymasterRevert(config, f.chain, retained);
  assert.equal(hash, BUNDLE_HASH); assert.equal(requestCount(), 1);
  assert.equal(await readJson(PENDING_PATH), null);
  assert.equal((await readJson<any>(LAST_TRANSACTION_PATH))?.status, 'reverted');
  assert.deepEqual(await readJson(CYCLE_PATH), f.cycle);
});

test('a successful UserOperation cannot be acknowledged as a revert', async t => {
  const f = await receiptFixture(true); const requestCount = mockDefaultReceiptProvider(t);
  await assert.rejects(acknowledgePaymasterRevert(configuration({ mode: 'ledger' }), f.chain, f.pending), /Only a canonically confirmed failed user operation/);
  assert.equal(requestCount(), 1); assert.equal((await readJson<PendingTransaction>(PENDING_PATH))?.hash, OP_HASH);
  assert.equal(await readJson(LAST_TRANSACTION_PATH), null); assert.deepEqual(await readJson(CYCLE_PATH), f.cycle);
});

test('disabling gasPayment still routes a saved UserOperation through EntryPoint reconciliation', async t => {
  const f = await receiptFixture(true); const requestCount = mockDefaultReceiptProvider(t);
  const { gasPayment: _removed, ...native } = configuration();
  await atomicWriteJson(CONFIG_PATH, native);
  const result = await reconcile(native, f.chain);
  assert.equal(result.blocked, false); assert.equal(result.operation?.hash, BUNDLE_HASH);
  assert.equal(result.operation?.status, 'confirmed'); assert.equal(requestCount(), 1);
  assert.equal(await readJson(PENDING_PATH), null);
  assert.equal((await readJson<any>(CYCLE_PATH))?.swapConfirmed, true);
});

test('an empty receipt scan advances only its cursor and preserves all pending identity and cadence', async () => {
  const f = await receiptFixture(true); f.state.showEvent = false; f.state.head = 10_000n;
  const first = await reconcilePaymaster(configuration(), f.chain, f.pending, f.provider);
  assert.equal(first.blocked, true); assert.equal(first.operation.status, 'pending');
  const retained = (await readJson<PendingTransaction>(PENDING_PATH))!;
  assert.deepEqual(retained, { ...f.pending, userOperation: { ...f.pending.userOperation!, scanFromBlock: '8280' } });
  assert.deepEqual(await readJson(CYCLE_PATH), f.cycle); assert.equal(await readJson(LAST_TRANSACTION_PATH), null);
  f.scans.length = 0;
  await reconcilePaymaster(configuration(), f.chain, retained, f.provider);
  assert.equal(f.scans[0]?.fromBlock, 8280n);
  assert.equal((await readJson<PendingTransaction>(PENDING_PATH))?.hash, OP_HASH);
});

test('a configuration edit that cancels signing is reported as a configuration change', async () => {
  const h = harness();
  h.beforeSign(async () => {
    await atomicWriteJson(CONFIG_PATH, configuration({ driftThresholdBps: 700 }));
    throw new Error('old signer cancelled after configuration change');
  });
  await assert.rejects(dispatchPaymaster(configuration(), h.chain, transaction, h.signer, undefined, undefined, h.provider), ConfigChangedError);
  assert.deepEqual(h.sends, []);
  assert.equal(await readJson(PENDING_PATH), null);
});
