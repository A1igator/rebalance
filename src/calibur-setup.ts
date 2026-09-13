import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { open, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { keccak256, parseTransaction, recoverTransactionAddress, serializeTransaction, type Hex, type SignedAuthorization, type TransactionSerialized } from 'viem';
import { recoverAuthorizationAddress } from 'viem/utils';
import { CALIBUR_DELEGATION_CODE } from './calibur.js';
import { readCaliburState } from './calibur-execution.js';
import { readDelegatedState } from './calibur-execution.js';
import { delegationFor, type DelegatedExecution } from './delegation.js';
import { createChain } from './chain.js';
import { CONFIG_PATH, DATA, PENDING_PATH, loadConfig } from './config.js';
import { acquireConfigLock } from './config-lock.js';
import { checkRebalanceFee, type FeeCheck, type FeeTargetInput } from './fee-target.js';
import type { CaliburPreparedTransaction } from './privy.js';
import { LedgerSigningError, type LedgerSigningOutcome } from './ledger-signing.js';
import { loadSigner } from './signers.js';
import { acquireLock, atomicWriteJson, isLiveLockContention, readJson, type PendingTransaction } from './storage.js';
import { classifyDispatchFailure, reconcile, validatePending, type Chain } from './transactions.js';

const PREFLIGHT_MESSAGES = {
  'deployment-needed': 'Simple7702Account needs its one-time canonical contract deployment before wallet setup.',
  'existing-calibur': 'This wallet already delegates to Calibur. Its existing delegation was preserved.',
  'simulation-failed': 'Calibur setup simulation could not be verified. Check the network, then press Start to retry.',
  'insufficient-eth': 'Calibur setup needs more ETH for gas. Fund this wallet, then press Start.',
  'fee-above-target': 'Calibur setup exceeds the fee target. Wait for lower fees or update the target, then press Start.',
  'fee-unavailable': 'A fresh Calibur setup fee estimate is unavailable. Check the network, then press Start to retry.',
} as const;
type SetupPreflightReason = keyof typeof PREFLIGHT_MESSAGES;
class SetupPreflightError extends Error {
  constructor(readonly reason: SetupPreflightReason) { super(PREFLIGHT_MESSAGES[reason]); }
}

export type CaliburSetupResult = {
  app: 'Rebalance'; operation: 'calibur-setup' | 'simple7702-setup'; wallet: string; chainId: 4663;
  outcome: 'already-enabled' | 'pending' | 'unresolved' | 'confirming' | 'confirmed' | 'reverted' | 'existing-transaction' | 'needed' | 'authorizing' | 'signing' | 'unknown' | 'blocked';
  hash?: string; pendingKind?: PendingTransaction['kind']; status?: string; message?: string; blockedReason?: LedgerSigningOutcome | SetupPreflightReason;
};
export type CaliburSetupDependencies = {
  chain?: Chain; signer?: typeof loadSigner; checkFee?: typeof checkRebalanceFee;
};

/** Public control-file generation, including replacement with identical contents. */
async function controlGeneration(path: string): Promise<string | null> {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size > 65_536n) throw new Error('Invalid setup control record');
    const content = await file.readFile('utf8');
    const after = await file.stat({ bigint: true });
    if (before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || before.size !== after.size) {
      throw new Error('Setup controls changed while being read');
    }
    return JSON.stringify([before.dev.toString(), before.ino.toString(), before.mtimeNs.toString(), before.ctimeNs.toString(), content]);
  } finally { await file.close(); }
}

/** Explicit enrollment only: no runner launch, targets, token calls or cycle work. */
export async function setupCalibur(options: { signal?: AbortSignal; expectedStop?: string } = {}, dependencies: CaliburSetupDependencies = {}, execution: DelegatedExecution = 'calibur'): Promise<CaliburSetupResult> {
  const delegate = delegationFor(execution);
  const readState = (chain: Chain, wallet: Parameters<typeof readCaliburState>[1]) => readSetupState(chain, wallet, execution);
  options = { ...options };
  if (options.expectedStop !== undefined && !/^(none|[a-f0-9]{64})$/.test(options.expectedStop)) throw new Error('Invalid expected Stop token');
  options.signal?.throwIfAborted();
  const releaseRun = await acquireLock(DATA, 'run.lock');
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const timeout = setTimeout(() => controller.abort(new Error('Calibur setup expired; no new transaction was sent')), 240_000);
  timeout.unref();
  let watcher: ReturnType<typeof setInterval> | undefined;
  let blockError: ((error: LedgerSigningError | SetupPreflightError) => Promise<CaliburSetupResult>) | undefined;
  let sendInvoked = false;
  const stagePath = resolve(DATA, `${delegate.setupKind}-status.json`), requestId = randomUUID();
  try {
    const configGeneration = await controlGeneration(CONFIG_PATH);
    const config = structuredClone(await loadConfig());
    if (!config || config.mode !== 'ledger' || config.execution !== execution) throw new Error('Delegation setup requires its matching saved Ledger configuration');
    const captured = JSON.stringify(config), stopPath = resolve(DATA, 'stop.json');
    const stopGeneration = await controlGeneration(stopPath);
    const stop = await readJson(stopPath);
    const expectedStop = stop === null ? 'none' : createHash('sha256').update(JSON.stringify(stop)).digest('hex');
    if (options.expectedStop !== undefined && options.expectedStop !== expectedStop) throw new Error('A newer Stop superseded this Calibur setup request');
    const localReady = async () => {
      signal.throwIfAborted();
      if (await controlGeneration(CONFIG_PATH) !== configGeneration || JSON.stringify(await loadConfig()) !== captured ||
          await controlGeneration(stopPath) !== stopGeneration) throw new Error('Configuration or Stop changed; Calibur setup was canceled');
      signal.throwIfAborted();
    };
    await localReady();
    const ownedRun = await readJson<{ token?: string }>(resolve(DATA, 'run.lock'));
    const stage = async (value: 'authorizing' | 'signing' | 'confirming', hash?: string) => {
      await localReady();
      await atomicWriteJson(stagePath, { version: 1, wallet: config.wallet, chainId: 4663, requestId, runToken: ownedRun?.token,
        stage: value, updatedAt: new Date().toISOString(), ...(hash ? { hash } : {}) });
    };
    const chain = dependencies.chain ?? createChain(config), rpc = chain.publicClient;
    const base = { app: 'Rebalance', operation: delegate.setupKind, wallet: config.wallet, chainId: 4663 } as const;
    blockError = async error => {
      await localReady();
      if (await readJson(PENDING_PATH)) throw new Error('A transaction needs receipt reconciliation before another setup attempt');
      if (error instanceof SetupPreflightError) return { ...base, outcome: 'blocked', blockedReason: error.reason, message: PREFLIGHT_MESSAGES[error.reason] };
      return { ...base, outcome: 'blocked', blockedReason: error.outcome, message: error.outcome === 'rejected'
        ? 'Calibur setup was canceled on Ledger. Press Start to retry when ready.'
        : 'Calibur setup needs Ledger attention. Review the device and Ethereum app before retrying.' };
    };
    const existing = await readJson<PendingTransaction>(PENDING_PATH);
    if (existing) {
      validatePending(existing, config);
      const observed = await reconcile(config, chain);
      const status = observed.operation?.status ?? 'unresolved';
      if (existing.kind !== delegate.setupKind) return { ...base, outcome: 'existing-transaction', pendingKind: existing.kind, hash: existing.hash, status };
      const outcome = ['pending', 'unresolved', 'confirming', 'confirmed', 'reverted'].includes(status)
        ? status as 'pending' | 'unresolved' | 'confirming' | 'confirmed' | 'reverted' : 'unresolved';
      return { ...base, outcome, hash: existing.hash };
    }
    const state = await readState(chain, config.wallet);
    await localReady();
    if (state === execution) return { ...base, outcome: 'already-enabled' };
    const [nonce, confirmed] = await Promise.all([
      rpc.getTransactionCount({ address: config.wallet, blockTag: 'pending' }),
      rpc.getTransactionCount({ address: config.wallet, blockTag: 'latest' }),
    ]);
    if (!Number.isSafeInteger(nonce) || nonce < 0 || nonce >= Number.MAX_SAFE_INTEGER || nonce !== confirmed) {
      throw new Error('Wallet nonce is invalid or another transaction is pending; Calibur setup was not signed');
    }
    const tx = delegate.buildSetupTransaction(config.wallet);
    let gas: bigint;
    try {
      const estimate = await rpc.estimateGas({ account: config.wallet, ...tx,
        stateOverride: [{ address: config.wallet, code: delegate.delegationCode }] });
      if (typeof estimate !== 'bigint' || estimate <= 0n) throw new Error();
      gas = ((estimate + 25_000n) * 120n + 99n) / 100n;
    } catch { throw new SetupPreflightError('simulation-failed'); }
    const suggested = await rpc.getGasPrice();
    if (typeof suggested !== 'bigint' || suggested <= 0n || suggested >= 2n ** 256n) throw new SetupPreflightError('fee-unavailable');
    const gasPrice = (suggested * 120n + 99n) / 100n;
    if (gas >= 2n ** 256n || gasPrice >= 2n ** 256n) throw new SetupPreflightError('fee-unavailable');
    const feeInput: FeeTargetInput | undefined = config.rebalanceFeeTargetUsdE8 === undefined ? undefined : {
      targetUsdE8: config.rebalanceFeeTargetUsdE8, kind: delegate.setupKind, swaps: 0, swapsInCurrentTransaction: 0,
      remainingApprovals: 0, gas, gasPrice,
    };
    let fee: FeeCheck | undefined;
    const feeFresh = () => {
      const observed = Date.parse(fee?.observedAt ?? '');
      return Number.isFinite(observed) && Date.now() >= observed && Date.now() - observed < 30_000;
    };
    const verifyFees = async (refresh: boolean) => {
      if (!feeInput) return;
      if (!feeFresh() && refresh) fee = await (dependencies.checkFee ?? checkRebalanceFee)(feeInput);
      if (!feeFresh() || fee?.state !== 'within-target') throw new SetupPreflightError(fee?.state === 'above-target' ? 'fee-above-target' : 'fee-unavailable');
    };
    const current = async () => {
      await localReady();
      // Refresh the external fee quote before taking the final nonce/code snapshot.
      await verifyFees(true); await localReady();
      const [pendingNonce, latestNonce, currentState, balance] = await Promise.all([
        rpc.getTransactionCount({ address: config.wallet, blockTag: 'pending' }),
        rpc.getTransactionCount({ address: config.wallet, blockTag: 'latest' }),
        readState(chain, config.wallet), rpc.getBalance({ address: config.wallet, blockTag: 'pending' }),
      ]);
      if (pendingNonce !== nonce || latestNonce !== nonce || currentState !== state) throw new Error('Calibur account or nonce changed; setup was canceled');
      if (typeof balance !== 'bigint' || balance < 0n) throw new SetupPreflightError('fee-unavailable');
      if (balance < gas * gasPrice) throw new SetupPreflightError('insufficient-eth');
      await localReady();
    };
    await current();
    let checking = false;
    watcher = setInterval(() => {
      if (checking || signal.aborted) return;
      checking = true;
      void localReady().catch(error => controller.abort(error)).finally(() => { checking = false; });
    }, 200);
    watcher.unref();
    const account = await (dependencies.signer ?? loadSigner)(config, { signal });
    if (account.address.toLowerCase() !== config.wallet.toLowerCase() || !account.signDelegationAuthorization) {
      throw new Error('Selected Ledger cannot authorize this portfolio; no fallback was used');
    }
    await current();
    await stage('authorizing');
    let authorization: SignedAuthorization<number>;
    authorization = structuredClone(await account.signDelegationAuthorization({ chainId: 4663, address: delegate.address, nonce: nonce + 1 }));
    await current();
    try {
      if (authorization.chainId !== 4663 || authorization.address.toLowerCase() !== delegate.address.toLowerCase() || authorization.nonce !== nonce + 1 ||
          (await recoverAuthorizationAddress({ authorization })).toLowerCase() !== config.wallet.toLowerCase()) throw new Error();
    } catch { throw new Error('Invalid Calibur setup authorization'); }
    const prepared: CaliburPreparedTransaction = { chainId: 4663, type: 'eip7702', nonce, gas, maxFeePerGas: gasPrice,
      maxPriorityFeePerGas: gasPrice, ...tx, authorizationList: [authorization] };
    await stage('signing');
    let serialized: Hex;
    serialized = await account.signTransaction(structuredClone(prepared));
    await current();
    try {
      const decoded = parseTransaction(serialized);
      if (decoded.type !== 'eip7702' || !decoded.r || !decoded.s || decoded.yParity === undefined ||
          serializeTransaction(prepared, { r: decoded.r, s: decoded.s, yParity: decoded.yParity }) !== serialized ||
          (await recoverTransactionAddress({ serializedTransaction: serialized as TransactionSerialized })).toLowerCase() !== config.wallet.toLowerCase()) throw new Error();
    } catch { throw new Error('Ledger setup transaction differs from its prepared payload'); }
    const hash = keccak256(serialized);
    const pending: PendingTransaction = { chainId: 4663, wallet: config.wallet, hash, nonce, kind: delegate.setupKind,
      createdAt: new Date().toISOString(), status: 'prepared', gas: gas.toString(), gasPrice: gasPrice.toString() };
    await stage('confirming', hash);
    const releaseConfig = await acquireConfigLock(DATA, { signal });
    let persisted = false, sending: Promise<{ hash: Hex } | { error: unknown }>;
    try {
      await localReady(); await verifyFees(false);
      if (await readJson(PENDING_PATH)) throw new Error('Another transaction needs receipt reconciliation');
      await atomicWriteJson(PENDING_PATH, pending); persisted = true;
      await localReady(); await verifyFees(false);
      sendInvoked = true;
      try { sending = Promise.resolve(rpc.sendRawTransaction({ serializedTransaction: serialized })).then(hash => ({ hash }), error => ({ error })); }
      catch (error) { sending = Promise.resolve({ error }); }
    } catch (error) { if (persisted) await rm(PENDING_PATH); throw error; }
    finally { await releaseConfig(); }
    const outcome = await sending;
    try {
      if ('error' in outcome) throw outcome.error;
      if (outcome.hash.toLowerCase() !== hash.toLowerCase()) throw new Error('Unexpected setup transaction hash');
      await atomicWriteJson(PENDING_PATH, { ...pending, status: 'broadcast' });
      return { ...base, outcome: 'pending', hash };
    } catch (error) {
      await atomicWriteJson(PENDING_PATH, { ...pending, status: 'unknown', sendFailure: classifyDispatchFailure(error) });
      return { ...base, outcome: 'unresolved', hash };
    }
  } catch (error) {
    if (!sendInvoked && blockError && (error instanceof LedgerSigningError || error instanceof SetupPreflightError)) return await blockError(error);
    throw error;
  } finally {
    if (watcher) clearInterval(watcher);
    clearTimeout(timeout); controller.abort();
    try {
      const stage = await readJson<{ requestId?: string }>(stagePath);
      if (stage?.requestId === requestId && !await readJson(PENDING_PATH)) await rm(stagePath, { force: true });
    } finally { await releaseRun(); }
  }
}


/** Receipt/code observation only. No-pending public reads never claim a runner lock. */
export async function caliburSetupStatus(dependencies: Pick<CaliburSetupDependencies, 'chain'> = {}, execution: DelegatedExecution = 'calibur'): Promise<CaliburSetupResult> {
  const delegate = delegationFor(execution);
  const readState = (chain: Chain, wallet: Parameters<typeof readCaliburState>[1]) => readSetupState(chain, wallet, execution);
  const config = await loadConfig();
  if (!config || config.mode !== 'ledger') throw new Error('Calibur status requires a saved Ledger portfolio');
  const base = { app: 'Rebalance', operation: delegate.setupKind, wallet: config.wallet, chainId: 4663 } as const;
  const runPath = resolve(DATA, 'run.lock');
  const pendingSummary = (pending: PendingTransaction): CaliburSetupResult => {
    validatePending(pending, config);
    return { ...base, outcome: pending.kind === delegate.setupKind ? 'confirming' : 'existing-transaction', pendingKind: pending.kind, hash: pending.hash };
  };
  const activeStage = async (): Promise<CaliburSetupResult | null> => {
    const [run, stage] = await Promise.all([
      readJson<{ pid?: number; token?: string }>(runPath),
      readJson<{ version?: number; wallet?: string; chainId?: number; runToken?: string; stage?: string; updatedAt?: string }>(resolve(DATA, `${delegate.setupKind}-status.json`)),
    ]);
    const observed = Date.parse(stage?.updatedAt ?? '');
    if (stage?.version !== 1 || typeof stage.wallet !== 'string' || stage.wallet.toLowerCase() !== config.wallet.toLowerCase() ||
        stage.chainId !== 4663 || !Number.isSafeInteger(run?.pid) || run!.pid! <= 0 || typeof run?.token !== 'string' || stage.runToken !== run.token ||
        !Number.isFinite(observed) || observed > Date.now() || Date.now() - observed > 240_000 ||
        !['authorizing', 'signing', 'confirming'].includes(stage.stage ?? '')) return null;
    try { process.kill(run.pid!, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EPERM') return null; }
    return { ...base, outcome: stage.stage as 'authorizing' | 'signing' | 'confirming' };
  };
  const chain = dependencies.chain ?? createChain(config);
  let pending = await readJson<PendingTransaction>(PENDING_PATH);
  if (!pending) {
    const generation = await controlGeneration(runPath), active = await activeStage();
    if (active) return active;
    const state = await readState(chain, config.wallet);
    pending = await readJson<PendingTransaction>(PENDING_PATH);
    if (JSON.stringify(await loadConfig()) !== JSON.stringify(config)) throw new Error('Configuration changed while reading Calibur status');
    if (!pending) {
      const latest = await activeStage();
      if (latest) return latest;
      if (await controlGeneration(runPath) !== generation) return { ...base, outcome: 'unknown' };
      return { ...base, outcome: state === execution ? 'already-enabled' : 'needed' };
    }
  }
  // Reconciliation may clear a receipt barrier, so it alone serializes with the
  // runner/setup owner. A concurrent send keeps its pending identity intact.
  let release: (() => Promise<void>) | undefined;
  try { release = await acquireLock(DATA, 'run.lock'); }
  catch (error) {
    if (!isLiveLockContention(error)) throw error;
    return pendingSummary(pending);
  }
  try {
    if (JSON.stringify(await loadConfig()) !== JSON.stringify(config)) throw new Error('Configuration changed while reading Calibur status');
    const observedPending = pending;
    pending = await readJson<PendingTransaction>(PENDING_PATH);
    if (!pending) {
      if (observedPending.kind !== delegate.setupKind) return { ...base, outcome: 'existing-transaction', pendingKind: observedPending.kind, hash: observedPending.hash, status: 'unresolved' };
      const state = await readState(chain, config.wallet);
      if (JSON.stringify(await loadConfig()) !== JSON.stringify(config)) throw new Error('Configuration changed while reading Calibur status');
      const latest = await readJson<PendingTransaction>(PENDING_PATH);
      if (latest) return pendingSummary(latest);
      return { ...base, outcome: state === execution ? 'already-enabled' : 'unknown' };
    }
    validatePending(pending, config);
    const observed = await reconcile(config, chain), status = observed.operation?.status ?? 'unresolved';
    if (pending.kind !== delegate.setupKind) return { ...base, outcome: 'existing-transaction', pendingKind: pending.kind, hash: pending.hash, status };
    return { ...base, outcome: ['pending', 'unresolved', 'confirming', 'confirmed', 'reverted'].includes(status)
      ? status as 'pending' | 'unresolved' | 'confirming' | 'confirmed' | 'reverted' : 'unknown', hash: pending.hash };
  } finally { await release(); }
}

/** The shared enrollment path selects a distinct ABI, authorization and pending kind. */
export async function setupSimple7702(options: Parameters<typeof setupCalibur>[0] = {}, dependencies: CaliburSetupDependencies = {}) {
  const result = await setupCalibur(options, dependencies, 'simple7702');
  return { ...result, ...(result.message && result.blockedReason !== 'existing-calibur'
    ? { message: result.message.replaceAll('Calibur', 'Simple7702Account') } : {}) };
}

/** Report a missing deployment without a signer or changing the selected wallet. */
export async function simple7702SetupStatus(dependencies: Pick<CaliburSetupDependencies, 'chain'> = {}): Promise<CaliburSetupResult> {
  const original = await loadConfig();
  try { return await caliburSetupStatus(dependencies, 'simple7702'); }
  catch (error) {
    if (!(error instanceof SetupPreflightError) || !original || JSON.stringify(await loadConfig()) !== JSON.stringify(original)) throw error;
    return { app: 'Rebalance', operation: 'simple7702-setup', wallet: original.wallet, chainId: 4663,
      outcome: 'blocked', blockedReason: error.reason, message: PREFLIGHT_MESSAGES[error.reason] };
  }
}

async function readSetupState(chain: Chain, wallet: Parameters<typeof readCaliburState>[1], execution: DelegatedExecution) {
  if (execution === 'calibur') return readDelegatedState(chain, wallet, execution);
  const rpc = chain.publicClient, delegate = delegationFor(execution);
  if (await rpc.getChainId() !== 4663) throw new Error('Delegation setup requires Robinhood mainnet');
  const blockNumber = await rpc.getBlockNumber({ cacheTime: 0 });
  const [account, implementation] = await Promise.all([
    rpc.getCode({ address: wallet, blockNumber }), rpc.getCode({ address: delegate.address, blockNumber }),
  ]);
  if (account?.toLowerCase() === CALIBUR_DELEGATION_CODE) throw new SetupPreflightError('existing-calibur');
  const state = delegate.inspectAccountCode(account);
  if ((!implementation || implementation === '0x') && state === 'undelegated') throw new SetupPreflightError('deployment-needed');
  delegate.assertDeployment(implementation);
  return state;
}
