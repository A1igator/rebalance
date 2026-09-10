import { validatePaymasterPending } from './paymaster-state.js';
import { checkRebalanceFee, FeeTargetError, type FeeCheck } from './fee-target.js';
import { acquireConfigLock } from './config-lock.js';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { keccak256, TransactionReceiptNotFoundError, type Hex } from 'viem';
import { createChain, type ChainTransaction } from './chain.js';
import { noteSuccessfulSwap } from './cadence.js';
import { DATA, LAST_TRANSACTION_PATH, PENDING_PATH, loadConfig, type Config } from './config.js';
import { loadSigner } from './signers.js';
import { atomicWriteJson, readJson, type DispatchFailure, type PendingTransaction } from './storage.js';

export type Operation = { status: string; hash?: string; message?: string; kind?: string; blockNumber?: string; wallet?: string; chainId?: 4663; sendFailure?: DispatchFailure };
export type Chain = ReturnType<typeof createChain>;

/** Expected local control change, never a failed financial operation. */
export class ConfigChangedError extends Error {
  constructor() { super('Configuration changed; rebuild from the latest settings.'); this.name = 'ConfigChangedError'; }
}
class FeeQuoteExpiredError extends Error {}

const SEND_FAILURE_MESSAGES: Record<DispatchFailure, string> = {
  underpriced: 'RPC reported a fee that was too low.',
  gas: 'RPC reported an invalid gas limit.',
  nonce: 'RPC reported a nonce rejection.',
  balance: 'RPC reported insufficient balance.',
  reverted: 'RPC reported execution reverted; no mined receipt is established by this response.',
  unknown: 'The send response did not establish the transaction outcome.',
};

function dispatchFailureMessage(failure: DispatchFailure): string {
  return `${SEND_FAILURE_MESSAGES[failure]} The send outcome remains unverified; preserve the saved hash for reconciliation without resubmitting the swap.`;
}

/** Fixed diagnostics only: RPC rejection data is never evidence that a send is safe to retry. */
export function classifyDispatchFailure(error: unknown): DispatchFailure {
  const names: Record<string, DispatchFailure> = {
    FeeCapTooLowError: 'underpriced', MaxFeePerGasTooLowError: 'underpriced',
    IntrinsicGasTooHighError: 'gas', IntrinsicGasTooLowError: 'gas',
    NonceTooHighError: 'nonce', NonceTooLowError: 'nonce', NonceMaxValueError: 'nonce',
    InsufficientFundsError: 'balance', ExecutionRevertedError: 'reverted',
  };
  const visited = new Set<object>();
  let current: unknown = error;
  try {
    for (let depth = 0; depth < 8 && current && typeof current === 'object'; depth++) {
      if (visited.has(current)) break;
      visited.add(current);
      const value = current as { name?: unknown; code?: unknown; details?: unknown; message?: unknown; cause?: unknown };
      if (typeof value.name === 'string' && Object.hasOwn(names, value.name)) return names[value.name]!;
      if (value.code === 3) return 'reverted';
      // viem's raw send path can retain a generic RPC error rather than a
      // specialized node-error class. Inspect only bounded rejection text,
      // never request bodies/URLs, and emit only the fixed category above.
      if (value.code === -32000 || value.code === -32003) {
        const detail = typeof value.details === 'string' ? value.details : typeof value.message === 'string' ? value.message : '';
        const text = detail.slice(0, 4096).toLowerCase();
        if (/transaction underpriced|replacement transaction underpriced|max fee per gas less than block base fee|fee cap less than block base fee/.test(text)) return 'underpriced';
        if (/intrinsic gas too low|intrinsic gas too high|gas limit reached/.test(text)) return 'gas';
        if (/nonce too low|nonce too high|nonce has max value|transaction already imported|already known/.test(text)) return 'nonce';
        if (/insufficient funds|exceeds transaction sender account balance/.test(text)) return 'balance';
        if (/execution reverted/.test(text)) return 'reverted';
      }
      current = value.cause;
    }
  } catch { /* Malformed error objects must not prevent the durable unknown marker. */ }
  return 'unknown';
}

function validQuantity(value: unknown): boolean {
  return typeof value === 'string' && /^[1-9][0-9]{0,77}$/.test(value) && BigInt(value) < 2n ** 256n;
}

export function validatePending(p: PendingTransaction, config: Config): void {
  if (!p || typeof p !== 'object' || p.chainId !== 4663 || typeof p.wallet !== 'string' ||
      p.wallet.toLowerCase() !== config.wallet.toLowerCase() || typeof p.hash !== 'string' ||
      !/^0x[0-9a-fA-F]{64}$/.test(p.hash) || !Number.isSafeInteger(p.nonce) || p.nonce < 0 ||
      !['prepared', 'broadcast', 'unknown'].includes(p.status) || !['approval', 'swap', 'wrap'].includes(p.kind) ||
      (p.gas !== undefined && !validQuantity(p.gas)) || (p.gasPrice !== undefined && !validQuantity(p.gasPrice)) ||
      (p.sendFailure !== undefined && (typeof p.sendFailure !== 'string' || !Object.hasOwn(SEND_FAILURE_MESSAGES, p.sendFailure)))) {
    throw new Error('Pending transaction does not match the configured wallet/network or is invalid');
  }
  if (p.transport !== undefined || p.userOperation !== undefined) validatePaymasterPending(p);
}

/** Receipt observation is independent of signing and is always run first. */
export async function reconcile(config: Config, chain: Chain): Promise<{ blocked: boolean; operation: Operation | null }> {
  const pending = await readJson<PendingTransaction>(PENDING_PATH);
  if (!pending) {
    const last = await readJson<Operation>(LAST_TRANSACTION_PATH);
    const matches = last?.chainId === config.chainId && typeof last.wallet === 'string' &&
      last.wallet.toLowerCase() === config.wallet.toLowerCase();
    // An unscoped legacy receipt or another wallet's last operation must not
    // become evidence that the currently selected portfolio was rebalanced.
    return { blocked: false, operation: matches ? last : null };
  }
  validatePending(pending, config);
  if (pending.transport === 'alchemy-usdg') return (await import('./paymaster.js')).reconcilePaymaster(config, chain, pending);
  if (await chain.publicClient.getChainId() !== 4663) throw new Error('RPC is not Robinhood mainnet');
  let receipt;
  try { receipt = await chain.publicClient.getTransactionReceipt({ hash: pending.hash as Hex }); }
  catch (error) {
    if (!(error instanceof TransactionReceiptNotFoundError)) throw new Error('Could not reconcile the pending transaction; execution remains paused');
    return { blocked: true, operation: {
      status: pending.status === 'broadcast' ? 'pending' : 'unresolved', hash: pending.hash, kind: pending.kind,
      ...(pending.sendFailure ? { sendFailure: pending.sendFailure } : {}),
      message: pending.sendFailure ? dispatchFailureMessage(pending.sendFailure)
        : 'No receipt yet. No new transaction will be sent and this transaction will not be blindly retried.',
    } };
  }
  if (receipt.transactionHash.toLowerCase() !== pending.hash.toLowerCase()) throw new Error('Receipt hash differs from the pending transaction');
  if (receipt.from.toLowerCase() !== config.wallet.toLowerCase()) throw new Error('Receipt sender differs from the selected wallet');
  if (receipt.status !== 'success') {
    return { blocked: true, operation: { status: 'reverted', hash: pending.hash, kind: pending.kind,
      message: 'Transaction reverted. The automatic runner verifies recovery before another attempt; the pending record remains preserved.' } };
  }
  const block = await chain.publicClient.getBlock({ blockNumber: receipt.blockNumber });
  const head = await chain.publicClient.getBlockNumber({ cacheTime: 0 });
  if (block.hash !== receipt.blockHash || head < receipt.blockNumber + 1n) {
    return { blocked: true, operation: { status: 'confirming', hash: pending.hash, kind: pending.kind, message: 'Waiting for two observed confirmations.' } };
  }
  const operation: Operation = { status: 'confirmed', hash: pending.hash, kind: pending.kind,
    wallet: config.wallet, chainId: config.chainId,
    blockNumber: receipt.blockNumber.toString(), message: `${pending.kind} confirmed on Robinhood mainnet` };
  // Persist the receipt result before removing the barrier to subsequent work.
  await atomicWriteJson(LAST_TRANSACTION_PATH, operation);
  await noteSuccessfulSwap(pending);
  await rm(PENDING_PATH);
  return { blocked: false, operation };
}

async function requireDispatchReady(tx: ChainTransaction): Promise<void> {
  const requireFresh = () => {
    if (tx.expiresAt !== undefined && tx.expiresAt <= BigInt(Math.floor(Date.now() / 1000))) {
      throw new Error('Swap deadline expired; rebuild from a fresh quote');
    }
  };
  requireFresh();
  if (await readJson(resolve(DATA, 'stop.json'))) throw new Error('Execution was stopped; no new transaction was sent');
  requireFresh();
}

export type FeeContext = { swaps: number | null; onCheck(check: FeeCheck): Promise<void> };

/** Passive Ledger fee assessment: public calls only, without loading a signer. */
export async function readRebalanceFee(config: Config, chain: Chain, tx: ChainTransaction, swaps: number | null): Promise<FeeCheck> {
  if (config.rebalanceFeeTargetUsdE8 === undefined) throw new Error('No fee target configured');
  if (config.gasPayment) return (await import('./paymaster.js')).readPaymasterFee(config, chain, tx, swaps);
  const unavailable: FeeCheck = { state: 'unavailable', targetUsdE8: config.rebalanceFeeTargetUsdE8,
    estimatedUsdE8: null, gasPriceWei: null, ethUsdE8: null, observedAt: null };
  if (swaps === null || !Number.isInteger(swaps) || swaps < 1 || swaps > 16 || (tx.kind !== 'approval' && tx.kind !== 'swap')) return unavailable;
  try {
    const rpc = chain.publicClient;
    if (await rpc.getChainId() !== 4663) return unavailable;
    const gasEstimate = await rpc.estimateGas({ account: config.wallet, to: tx.to, data: tx.data, value: tx.value });
    const suggestedPrice = await rpc.getGasPrice();
    if (typeof gasEstimate !== 'bigint' || typeof suggestedPrice !== 'bigint' || gasEstimate <= 0n || suggestedPrice <= 0n) return unavailable;
    const gas = (gasEstimate * 120n + 99n) / 100n;
    const gasPrice = (suggestedPrice * 120n + 99n) / 100n;
    return await checkRebalanceFee({ targetUsdE8: config.rebalanceFeeTargetUsdE8, swaps, kind: tx.kind, gas, gasPrice });
  } catch { return unavailable; }
}

/** The caller holds run.lock. The selected signer owns its credential handling. */
export async function dispatch(config: Config, chain: Chain, tx: ChainTransaction, signer: typeof loadSigner = loadSigner,
  ledger?: { signal?: AbortSignal; assertReady(): Promise<void> }, fees?: FeeContext): Promise<Operation> {
  if (!['private-key', 'privy', 'ledger'].includes(config.mode)) throw new Error(`${config.mode} execution is not connected yet; no fallback signer was used`);
  if (config.mode === 'ledger' && !ledger) throw new Error('Ledger needs an explicit rebalance request; no fallback signer was used');
  if (config.gasPayment) return (await import('./paymaster.js')).dispatchPaymaster(config, chain, tx, signer, ledger, fees);
  if (tx.calls) throw new Error('A batched transaction requires the selected paymaster transport');
  let feeInput: Parameters<typeof checkRebalanceFee>[0] | undefined;
  let lastFeeCheck: FeeCheck | undefined;
  const capturedConfig = JSON.stringify(config);
  const requireConfig = async () => {
    if (JSON.stringify(await loadConfig()) !== capturedConfig) throw new ConfigChangedError();
  };
  const feeExpired = () => {
    const observed = Date.parse(lastFeeCheck?.observedAt ?? '');
    return !lastFeeCheck || !Number.isFinite(observed) || Date.now() < observed || Date.now() - observed >= 30_000;
  };
  const verifyFees = async (refresh = true) => {
    if (config.rebalanceFeeTargetUsdE8 === undefined) return;
    if (!fees || fees.swaps === null || fees.swaps < 1) {
      const check: FeeCheck = { state: 'unavailable', targetUsdE8: config.rebalanceFeeTargetUsdE8,
        estimatedUsdE8: null, gasPriceWei: null, ethUsdE8: null, observedAt: null };
      await fees?.onCheck(check); throw new FeeTargetError(check);
    }
    if (!feeInput) return;
    if (!lastFeeCheck || feeExpired()) {
      if (!refresh) throw new FeeQuoteExpiredError();
      lastFeeCheck = await checkRebalanceFee(feeInput); await fees.onCheck(lastFeeCheck);
    }
    if (lastFeeCheck.state !== 'within-target') throw new FeeTargetError(lastFeeCheck);
  };
  const ready = async (refresh = true) => {
    await requireConfig();
    await verifyFees(refresh);
    if (config.mode === 'ledger') {
      try { await ledger!.assertReady(); }
      catch (error) { await requireConfig(); throw error; }
    }
    await requireConfig();
    await requireDispatchReady(tx);
    await requireConfig();
    if (!refresh && feeInput && feeExpired()) throw new FeeQuoteExpiredError();
    if (config.mode === 'ledger') ledger!.signal?.throwIfAborted();
  };
  {
    if (await readJson(PENDING_PATH)) throw new Error('Reconcile the existing pending transaction first');
    await ready();
    const account = await signer(config, config.mode === 'ledger' ? { signal: ledger?.signal } : {})
      .catch(async error => { await requireConfig(); throw error; });
    if (account.address.toLowerCase() !== config.wallet.toLowerCase()) throw new Error('Selected key does not match the configured public wallet');
    const rpc = chain.publicClient;
    if (await rpc.getChainId() !== 4663) throw new Error('RPC is not Robinhood mainnet');
    const nonce = await rpc.getTransactionCount({ address: config.wallet, blockTag: 'pending' });
    const confirmedNonce = await rpc.getTransactionCount({ address: config.wallet, blockTag: 'latest' });
    if (nonce !== confirmedNonce) throw new Error('Wallet has another pending transaction; wait for it to settle');
    let gas: bigint;
    try { gas = (await rpc.estimateGas({ account: config.wallet, to: tx.to, data: tx.data, value: tx.value }) * 120n + 99n) / 100n; }
    catch { throw new Error('Sender simulation/gas estimation failed; no transaction was signed'); }
    const suggestedGasPrice = await rpc.getGasPrice();
    if (typeof suggestedGasPrice !== 'bigint' || suggestedGasPrice <= 0n || suggestedGasPrice >= 2n ** 256n) {
      throw new Error('RPC returned an invalid gas-price suggestion; no transaction was signed');
    }
    // Reserve modest initial fee headroom with integer ceiling. This is not
    // a retry/replacement policy: an uncertain send keeps its original hash.
    const gasPrice = (suggestedGasPrice * 120n + 99n) / 100n;
    if (gasPrice >= 2n ** 256n) throw new Error('Buffered gas price exceeds uint256; no transaction was signed');
    if (config.rebalanceFeeTargetUsdE8 !== undefined) {
      if (tx.kind !== 'approval' && tx.kind !== 'swap') throw new Error('Fee targets cover rebalance approvals and swaps only; no transaction was signed');
      feeInput = { targetUsdE8: config.rebalanceFeeTargetUsdE8, swaps: fees!.swaps!, kind: tx.kind, gas, gasPrice };
      await ready();
    }
    const balance = await rpc.getBalance({ address: config.wallet, blockTag: 'pending' });
    if (gasPrice <= 0n || balance < tx.value + gas * gasPrice) throw new Error('Insufficient native ETH for this transaction and estimated gas');
    await ready();
    const serialized = await account.signTransaction({ chainId: 4663, type: 'legacy', nonce, gas, gasPrice,
      to: tx.to, data: tx.data, value: tx.value })
      .catch(async error => { await requireConfig(); throw error; });
    await ready();
    const hash = keccak256(serialized);
    const pending: PendingTransaction = { chainId: 4663, wallet: config.wallet, hash, nonce,
      kind: tx.kind, createdAt: new Date().toISOString(), status: 'prepared', gas: gas.toString(), gasPrice: gasPrice.toString() };
    // Long RPC and signer waits stay outside the configuration lock. Only the
    // local preparation and initiation of a send serialize with settings edits.
    let sending: Promise<{ hash: Hex } | { error: unknown }>;
    while (true) {
      await ready();
      const release = await acquireConfigLock(DATA, { signal: ledger?.signal });
      let prepared = false;
      try {
        await ready(false);
        if (await readJson(PENDING_PATH)) throw new Error('Reconcile the existing pending transaction first');
        await atomicWriteJson(PENDING_PATH, pending);
        prepared = true;
        await ready(false);
        // Attach both outcomes immediately, including a synchronous transport
        // throw. Once invocation starts, its hash is retained until reconciled.
        try {
          sending = Promise.resolve(rpc.sendRawTransaction({ serializedTransaction: serialized }))
            .then(hash => ({ hash }), error => ({ error }));
        } catch (error) { sending = Promise.resolve({ error }); }
        break;
      } catch (error) {
        if (prepared) await rm(PENDING_PATH);
        if (!(error instanceof FeeQuoteExpiredError)) throw error;
        // A price that aged during contention/local persistence is refreshed
        // outside this lock before another guarded attempt with this signature.
      } finally { await release(); }
    }
    const outcome = await sending;
    try {
      if ('error' in outcome) throw outcome.error;
      if (outcome.hash.toLowerCase() !== hash.toLowerCase()) throw new Error('RPC returned an unexpected transaction hash');
      await atomicWriteJson(PENDING_PATH, { ...pending, status: 'broadcast' });
      return { status: 'pending', hash, kind: tx.kind, message: `${tx.kind} submitted; waiting for its receipt` };
    } catch (error) {
      const sendFailure = classifyDispatchFailure(error);
      const message = dispatchFailureMessage(sendFailure);
      await atomicWriteJson(PENDING_PATH, { ...pending, status: 'unknown', sendFailure, message });
      return { status: 'unresolved', hash, kind: tx.kind, sendFailure, message };
    }
  }
}
