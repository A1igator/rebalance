import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { erc20Abi, parseAbi, toHex, type Hex } from 'viem';
import { DATA, PENDING_PATH, LAST_TRANSACTION_PATH, loadConfig, type Config } from './config.js';
import { acquireConfigLock } from './config-lock.js';
import { noteSuccessfulSwap } from './cadence.js';
import type { TradePlan } from './core.js';
import { type RouteQuote, type ChainTransaction } from './chain.js';
import { FeeTargetError, type FeeCheck } from './fee-target.js';
import { loadSigner } from './signers.js';
import { atomicWriteJson, readJson, type PendingTransaction } from './storage.js';
import { ConfigChangedError, type Chain, type FeeContext, type Operation } from './transactions.js';
import { alchemyRpc, type PaymasterRpc } from './paymaster-rpc.js';
import { PAYMASTER_ACCOUNT_ID, PAYMASTER_DELEGATE, PAYMASTER_ENTRY_POINT, PAYMASTER_NONCE_KEY, PAYMASTER_USDG,
  verifyPreparedCalls, formatSignedPreparedCalls, type VerifiedPaymasterPreparation } from './paymaster-protocol.js';
import { PaymasterBalanceError, validatePaymasterPending } from './paymaster-state.js';
export { PaymasterBalanceError, validatePaymasterPending } from './paymaster-state.js';
import { inspectPaymasterReceipt } from './paymaster-receipts.js';

const NONCE_ABI = parseAbi(['function getNonce(address sender, uint192 key) view returns (uint256)']);
const ID_ABI = parseAbi(['function accountId() pure returns (string)']);
const equal = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function callsFor(tx: ChainTransaction) {
  const calls = tx.calls ?? [{ to: tx.to, data: tx.data, value: tx.value }];
  if (tx.kind === 'wrap' || calls.length < 1 || calls.length > 2 || calls.some(call => call.value !== 0n)) {
    throw new Error('USDG gas payments support only zero-ETH rebalance approvals and swaps');
  }
  return calls;
}
export function paymasterPrepareRequest(config: Config, tx: ChainTransaction, onlyEstimation: boolean) {
  if (!config.gasPayment) throw new Error('This portfolio has no USDG paymaster selected');
  return { from: config.wallet, chainId: toHex(4663),
    calls: callsFor(tx).map(call => ({ to: call.to, data: call.data, value: toHex(call.value) })),
    capabilities: {
      eip7702Auth: { delegation: 'ModularAccountV2', version: 'v1.1.0' },
      nonceOverride: { nonceKey: '0x0' },
      paymasterService: { policyId: config.gasPayment.policyId, onlyEstimation,
        erc20: { tokenAddress: PAYMASTER_USDG, postOpSettings: { autoApprove: true } } },
    },
  };
}
async function walletState(config: Config, chain: Chain) {
  const rpc = chain.publicClient;
  if (await rpc.getChainId() !== 4663) throw new Error('RPC is not Robinhood mainnet');
  const blockNumber = await rpc.getBlockNumber({ cacheTime: 0 });
  const [code, nonce, pendingNonce, operationNonce, balance, allowance, delegateCode, entryPointCode, paymasterCode, accountId] = await Promise.all([
    rpc.getCode({ address: config.wallet, blockNumber }),
    rpc.getTransactionCount({ address: config.wallet, blockTag: 'latest' }),
    rpc.getTransactionCount({ address: config.wallet, blockTag: 'pending' }),
    rpc.readContract({ address: PAYMASTER_ENTRY_POINT, abi: NONCE_ABI, functionName: 'getNonce', args: [config.wallet, PAYMASTER_NONCE_KEY], blockNumber }),
    rpc.readContract({ address: PAYMASTER_USDG, abi: erc20Abi, functionName: 'balanceOf', args: [config.wallet], blockNumber }),
    rpc.readContract({ address: PAYMASTER_USDG, abi: erc20Abi, functionName: 'allowance', args: [config.wallet, config.gasPayment!.paymaster], blockNumber }),
    rpc.getCode({ address: PAYMASTER_DELEGATE, blockNumber }),
    rpc.getCode({ address: PAYMASTER_ENTRY_POINT, blockNumber }),
    rpc.getCode({ address: config.gasPayment!.paymaster, blockNumber }),
    rpc.readContract({ address: PAYMASTER_DELEGATE, abi: ID_ABI, functionName: 'accountId', blockNumber }),
  ]);
  if (nonce !== pendingNonce || !Number.isSafeInteger(nonce) || nonce < 0) throw new Error('Wallet has another pending transaction; wait for it to settle');
  const delegated = `0xef0100${PAYMASTER_DELEGATE.slice(2)}`.toLowerCase();
  if (code && code !== '0x' && code.toLowerCase() !== delegated) throw new Error('Wallet uses a different account implementation; no replacement delegation was requested');
  if ([delegateCode, entryPointCode, paymasterCode].some(code => !code || code === '0x')) throw new Error('The pinned paymaster/account infrastructure is not deployed on this chain');
  if (accountId !== PAYMASTER_ACCOUNT_ID) throw new Error('The account implementation identity differs from the pinned version');
  if (typeof operationNonce !== 'bigint' || typeof balance !== 'bigint' || typeof allowance !== 'bigint') throw new Error('Invalid account-state response');
  return { nonce, operationNonce, balance, allowance, blockNumber, requireAuthorization: !code || code === '0x' };
}
export async function preparePaymaster(config: Config, chain: Chain, tx: ChainTransaction, onlyEstimation = true, provider: PaymasterRpc = alchemyRpc()) {
  if (!config.gasPayment) throw new Error('Configure this wallet for USDG gas payments first');
  const state = await walletState(config, chain);
  const response = await provider('wallet_prepareCalls', [paymasterPrepareRequest(config, tx, onlyEstimation)]);
  const prepared = verifyPreparedCalls(response, { wallet: config.wallet, calls: callsFor(tx), paymaster: config.gasPayment.paymaster,
    userOperationNonce: state.operationNonce, authorizationNonce: state.nonce,
    requireAuthorization: state.requireAuthorization, onlyEstimation, paymasterAllowance: state.allowance });
  if (state.balance < prepared.feeTokenAmount + (tx.usdgSpent ?? 0n)) throw new PaymasterBalanceError(prepared.feeTokenAmount, state.balance);
  return { prepared, state, observedAt: Date.now() };
}
export function paymasterFeeCheck(config: Config, prepared: VerifiedPaymasterPreparation, swaps: number | null, observedAt: number): FeeCheck {
  if (config.rebalanceFeeTargetUsdE8 === undefined) throw new Error('No fee target is configured');
  const check: FeeCheck = { targetUsdE8: config.rebalanceFeeTargetUsdE8, estimatedUsdE8: null,
    gasPriceWei: prepared.userOperation.maxFeePerGas.toString(), ethUsdE8: null,
    observedAt: new Date(observedAt).toISOString(), state: 'unavailable' };
  if (!Number.isInteger(swaps) || swaps === null || swaps < 1 || swaps > 16) return check;
  // USDG is the portfolio's existing dollar unit. Remaining batches are projected
  // at this current maximum quote; this is prospective estimation, not accounting.
  const cost = prepared.feeTokenAmount * BigInt(swaps) * 100n;
  return { ...check, estimatedUsdE8: cost.toString(), state: cost <= BigInt(config.rebalanceFeeTargetUsdE8) ? 'within-target' : 'above-target' };
}
export async function readPaymasterFee(config: Config, chain: Chain, tx: ChainTransaction, swaps: number | null): Promise<FeeCheck> {
  try {
    const quote = await preparePaymaster(config, chain, tx);
    return paymasterFeeCheck(config, quote.prepared, swaps, quote.observedAt);
  } catch { return { state: 'unavailable', targetUsdE8: config.rebalanceFeeTargetUsdE8!, estimatedUsdE8: null, gasPriceWei: null, ethUsdE8: null, observedAt: null }; }
}

/** Caller holds run.lock; no native transaction fallback and no provider resend. */
export async function dispatchPaymaster(config: Config, chain: Chain, tx: ChainTransaction, signer: typeof loadSigner = loadSigner,
  ledger?: { signal?: AbortSignal; assertReady(): Promise<void> }, fees?: FeeContext, provider: PaymasterRpc = alchemyRpc()): Promise<Operation> {
  if (config.mode === 'ledger' && !ledger) throw new Error('Ledger needs an explicit rebalance request');
  const originalConfig = JSON.stringify(config);
  const ready = async () => {
    if (JSON.stringify(await loadConfig()) !== originalConfig) throw new ConfigChangedError();
    if (await readJson(resolve(DATA, 'stop.json'))) throw new Error('Execution was stopped; no user operation submitted');
    if (tx.expiresAt !== undefined && tx.expiresAt <= BigInt(Math.floor(Date.now() / 1000))) throw new Error('Swap deadline expired; rebuild from a fresh quote');
    ledger?.signal?.throwIfAborted(); await ledger?.assertReady();
    if (JSON.stringify(await loadConfig()) !== originalConfig) throw new ConfigChangedError();
  };
  if (await readJson(PENDING_PATH)) throw new Error('Reconcile the existing pending operation first');
  await ready();
  const estimate = await preparePaymaster(config, chain, tx, true, provider);
  const verifyFee = async (quote: typeof estimate) => {
    if (config.rebalanceFeeTargetUsdE8 === undefined) return;
    const check = paymasterFeeCheck(config, quote.prepared, fees?.swaps ?? null, quote.observedAt);
    await fees?.onCheck(check);
    if (check.state !== 'within-target') throw new FeeTargetError(check);
  };
  await verifyFee(estimate); await ready();
  // Only this execution pass reserves the provider policy. Passive estimates do not.
  const quote = await preparePaymaster(config, chain, tx, false, provider);
  await verifyFee(quote); await ready();
  const account = await signer(config, { signal: ledger?.signal })
    .catch(async error => { await ready(); throw error; });
  if (!equal(account.address, config.wallet) || !account.signMessageHash || (quote.prepared.authorization && !account.signAuthorization)) {
    throw new Error('The selected signer does not support this paymaster operation; no fallback signer was used');
  }
  let authorization: Hex | undefined;
  if (quote.prepared.authorization) {
    await ready();
    authorization = await account.signAuthorization!({ chainId: 4663, address: quote.prepared.authorization.address, nonce: quote.prepared.authorization.nonce })
      .catch(async error => { await ready(); throw error; });
    await ready();
  }
  // Sequential signatures are required for Ledger; connection alone is not authority.
  const userOperation = await account.signMessageHash(quote.prepared.userOperationHash)
    .catch(async error => { await ready(); throw error; });
  await ready();
  const payload = await formatSignedPreparedCalls(quote.prepared, { userOperation, authorization });
  const current = await walletState(config, chain);
  if (current.nonce !== quote.state.nonce || current.operationNonce !== quote.state.operationNonce ||
      current.requireAuthorization !== quote.state.requireAuthorization ||
      (!quote.prepared.feeApprovalInjected && current.allowance < quote.prepared.feeTokenAmount) || current.balance < quote.prepared.feeTokenAmount + (tx.usdgSpent ?? 0n)) {
    throw new Error('Wallet state changed during signing; rebuild before submission');
  }
  const fresh = () => {
    if (Date.now() < quote.observedAt || Date.now() - quote.observedAt >= 120_000) throw new Error('Paymaster quote expired during signing; request a fresh rebalance');
  };
  await ready(); fresh();
  const pending: PendingTransaction = { transport: 'alchemy-usdg', chainId: 4663, wallet: config.wallet,
    hash: quote.prepared.userOperationHash, nonce: quote.state.nonce, kind: tx.kind, status: 'prepared', createdAt: new Date().toISOString(),
    userOperation: { paymaster: config.gasPayment!.paymaster, userOperationNonce: quote.state.operationNonce.toString(),
      submittedAtBlock: quote.state.blockNumber.toString(), maxTokenAmount: quote.prepared.feeTokenAmount.toString(), callId: quote.prepared.callId } };
  let sending: Promise<unknown>;
  const release = await acquireConfigLock(DATA, { signal: ledger?.signal });
  let saved = false;
  try {
    await ready(); fresh();
    if (await readJson(PENDING_PATH)) throw new Error('Reconcile the existing pending operation first');
    await atomicWriteJson(PENDING_PATH, pending); saved = true;
    await ready(); fresh();
    // Convert rejection into data immediately so every unknown send retains the hash.
    try { sending = Promise.resolve(provider('wallet_sendPreparedCalls', [payload])).catch(() => null); }
    catch { sending = Promise.resolve(null); }
  } catch (error) { if (saved) await rm(PENDING_PATH); throw error; }
  finally { await release(); }
  const result = await sending;
  const receivedId = result && typeof result === 'object' && 'id' in result ? result.id : undefined;
  const known = typeof receivedId === 'string' && equal(receivedId, pending.userOperation!.callId);
  await atomicWriteJson(PENDING_PATH, { ...pending, status: known ? 'broadcast' : 'unknown' });
  return { status: 'pending', hash: pending.hash, kind: tx.kind,
    message: known ? 'USDG-paid operation submitted; waiting for its verified on-chain receipt.' : 'Paymaster response was uncertain; tracking the saved operation without resubmitting.' };
}

export async function reconcilePaymaster(config: Config, chain: Chain, pending: PendingTransaction, provider: PaymasterRpc = alchemyRpc()) {
  validatePaymasterPending(pending);
  const u = pending.userOperation!;
  const result = await inspectPaymasterReceipt({ wallet: config.wallet, userOperationHash: pending.hash as Hex,
    userOperationNonce: u.userOperationNonce, paymaster: u.paymaster as `0x${string}`,
    submittedAtBlock: u.submittedAtBlock, scanFromBlock: u.scanFromBlock }, {
    publicClient: chain.publicClient, getUserOperationReceipt: hash => provider('eth_getUserOperationReceipt', [hash], 'bundler'),
  });
  if (result.nextScanBlock && result.nextScanBlock !== u.scanFromBlock) {
    await atomicWriteJson(PENDING_PATH, { ...pending, userOperation: { ...u, scanFromBlock: result.nextScanBlock } });
  }
  if (result.state === 'pending' || result.state === 'confirming') {
    const stale = pending.status === 'unknown' && Date.now() - Date.parse(pending.createdAt) >= 600_000;
    return { blocked: true, operation: { status: result.state === 'confirming' ? 'confirming' : stale ? 'unresolved' : 'pending', hash: pending.hash,
      kind: pending.kind, message: 'Waiting for the exact user-operation event; no replacement or native transaction will be sent.' } satisfies Operation };
  }
  if (result.state === 'reverted' && config.mode === 'ledger') {
    return { blocked: true, operation: { status: 'reverted', hash: result.transactionHash, kind: pending.kind,
      message: 'The Ledger user operation reverted. Its receipt is verified; acknowledge the revert before a new signing request.' } satisfies Operation };
  }
  const operation: Operation = { status: result.state === 'confirmed' ? 'confirmed' : 'recovered-revert', hash: result.transactionHash,
    kind: pending.kind, wallet: config.wallet, chainId: 4663, blockNumber: result.blockNumber,
    message: result.state === 'confirmed' ? `${pending.kind} confirmed; network fees paid in USDG` : 'User operation reverted; verified receipt released its barrier, without a completed rebalance.' };
  await atomicWriteJson(LAST_TRANSACTION_PATH, operation);
  if (result.state === 'confirmed') await noteSuccessfulSwap(pending);
  await rm(PENDING_PATH);
  return { blocked: false, operation };
}

/** Read-only preparation. Leave a quoted USDG float for the projected remaining
 * swaps, rebuild exact calldata after reducing a buy, and never change targets. */
export async function preparePaymasterTrade(config: Config, chain: Chain, original: TradePlan, priorQuote: RouteQuote,
  swaps: number | null, provider: PaymasterRpc = alchemyRpc()) {
  let trade = { ...original };
  const count = swaps !== null && Number.isInteger(swaps) && swaps >= 1 && swaps <= 16 ? swaps : 1;
  for (let attempt = 0; attempt < 3; attempt++) {
    const tx = await chain.transaction(trade, priorQuote, { batch: true });
    let fee: bigint; let balance: bigint;
    try {
      const estimate = await preparePaymaster(config, chain, tx, true, provider);
      fee = estimate.prepared.feeTokenAmount; balance = estimate.state.balance;
    } catch (error) {
      if (!(error instanceof PaymasterBalanceError)) throw error;
      fee = error.reserve; balance = error.balance;
    }
    const reserve = fee * BigInt(count);
    if (trade.sellAssetId !== 'USDG') {
      if (balance < fee) throw new PaymasterBalanceError(fee, balance);
      return { transaction: tx, trade };
    }
    if (balance >= trade.amountIn + reserve) return { transaction: tx, trade };
    if (balance <= reserve) throw new PaymasterBalanceError(reserve, balance);
    const amount = balance - reserve;
    if (amount >= trade.amountIn) throw new PaymasterBalanceError(reserve, balance);
    trade = { ...trade, amountIn: amount, reason: `${original.reason}; quoted USDG gas reserved` };
  }
  throw new Error('USDG fee quotes changed while preparing the swap; wait for a fresh deterministic evaluation');
}

/** Explicit acknowledgement only: a UserOperation failure inside a successful
 * bundler transaction requires its own canonical event, never outer status. */
export async function acknowledgePaymasterRevert(config: Config, chain: Chain, pending: PendingTransaction): Promise<Hex> {
  validatePaymasterPending(pending);
  const u = pending.userOperation!;
  const provider = alchemyRpc();
  const result = await inspectPaymasterReceipt({ wallet: config.wallet, userOperationHash: pending.hash as Hex,
    userOperationNonce: u.userOperationNonce, paymaster: u.paymaster as Hex,
    submittedAtBlock: u.submittedAtBlock, scanFromBlock: u.scanFromBlock }, {
    publicClient: chain.publicClient, getUserOperationReceipt: hash => provider('eth_getUserOperationReceipt', [hash], 'bundler'),
  });
  if (result.state !== 'reverted' || !result.transactionHash) throw new Error('Only a canonically confirmed failed user operation can be acknowledged');
  await atomicWriteJson(LAST_TRANSACTION_PATH, { status: 'reverted', hash: result.transactionHash, kind: pending.kind,
    wallet: config.wallet, chainId: 4663, blockNumber: result.blockNumber, message: 'Verified failed user operation acknowledged.' });
  await rm(PENDING_PATH);
  return result.transactionHash;
}
