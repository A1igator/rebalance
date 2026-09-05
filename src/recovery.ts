import { createHash, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { keccak256, TransactionNotFoundError, TransactionReceiptNotFoundError, type Hex } from 'viem';
import { createChain } from './chain.js';
import { DATA, loadConfig, localAccount, type Config } from './config.js';
import { launch, type LaunchResult } from './launch.js';
import { status, tick, type Status } from './runtime.js';
import { noteSuccessfulSwap } from './cadence.js';
import { acquireLock, atomicWriteJson, readJson, type PendingTransaction } from './storage.js';
import { validatePending, type Operation } from './transactions.js';

export type RecoveryOptions = { cancel?: boolean; requestId?: string; expectedStop?: string };
type Rpc = ReturnType<typeof createChain>['publicClient'];
type Stop = { requestedAt: string; requestId: string };
type Cancellation = { hash: Hex; gas: string; gasPrice: string; status: 'prepared' | 'broadcast' | 'unknown' | 'not-sent' };
export type RecoveryRecord = {
  version: 1; original: PendingTransaction; createdAt: string; originallyArmed: boolean;
  priorStop?: string; stop?: Stop; automatic?: boolean; cancellation?: Cancellation;
  resolution?: 'original-confirmed' | 'original-reverted' | 'cancelled'; resolvedAt?: string;
  operation?: Operation; resumeAttemptedAt?: string; swapNotedAt?: string;
  /** Historical field only; cancellation/revert no longer closes the active window. */
  cycleClosedAt?: string;
};
export type RecoveryResult = {
  app: 'Rebalance'; requested: 'inspect' | 'cancel';
  outcome: 'clear' | 'blocked' | 'cancellation-needed' | 'pending' | 'confirming' |
    'original-confirmed' | 'original-reverted' | 'cancelled' | 'already-handled' | 'unknown';
  originalHash?: string; cancellationHash?: string; nonce?: number;
  armed: boolean | null; resume?: LaunchResult; messages: string[];
};
export type RecoveryDependencies = {
  dataDir: string; config: () => Promise<Config | null>;
  armed: () => Promise<boolean>; rpc: (config: Config) => Rpc;
  account: typeof localAccount; resume: (expectedStop: string) => Promise<LaunchResult>;
  refresh: () => Promise<Status>; noteSuccessfulSwap: (original: PendingTransaction) => Promise<void>;
  pause: () => Promise<void>; attempts: number;
};
class RecoveryError extends Error {}
type Assessment = { outcome: 'original-confirmed' | 'original-reverted' | 'cancelled'; operation: Operation } |
  { outcome: 'confirming' | 'pending' | 'cancellation-needed' };
const stopToken = (value: unknown) => value === null ? 'none' : createHash('sha256').update(JSON.stringify(value)).digest('hex');
const transactionIdentity = (p: PendingTransaction) => JSON.stringify([p.chainId, p.wallet.toLowerCase(), p.hash.toLowerCase(), p.nonce, p.kind]);

function validateRecord(record: RecoveryRecord, config: Config): void {
  if (!record || record.version !== 1 || typeof record.originallyArmed !== 'boolean' ||
      (!(record.automatic === true && record.stop === undefined && record.priorStop === undefined) && (!/^(none|[a-f0-9]{64})$/.test(record.priorStop ?? '') || typeof record.stop?.requestId !== 'string' ||
      typeof record.stop?.requestedAt !== 'string'))) throw new RecoveryError('Invalid recovery record; preserve it for inspection.');
  validatePending(record.original, config);
  if (record.cancellation && (!/^0x[a-fA-F0-9]{64}$/.test(record.cancellation.hash) ||
      !['prepared', 'broadcast', 'unknown', 'not-sent'].includes(record.cancellation.status) ||
      !/^[1-9][0-9]*$/.test(record.cancellation.gas) || !/^[1-9][0-9]*$/.test(record.cancellation.gasPrice))) {
    throw new RecoveryError('Invalid cancellation record; preserve both transaction identities.');
  }
  if (record.resolution && (!['original-confirmed', 'original-reverted', 'cancelled'].includes(record.resolution) || !record.operation)) {
    throw new RecoveryError('Invalid recovery resolution; preserve local records.');
  }
  if (record.swapNotedAt !== undefined && (typeof record.swapNotedAt !== 'string' || !Number.isFinite(Date.parse(record.swapNotedAt)) ||
      record.resolution !== 'original-confirmed' || record.original.kind !== 'swap')) {
    throw new RecoveryError('Invalid successful-swap recovery marker; preserve local records.');
  }
}

function recoveryCore(config: Config, rpc: Rpc, original: PendingTransaction, record: () => RecoveryRecord | null, automatic = false) {
  const getTransaction = async (hash: Hex) => {
    try { return await rpc.getTransaction({ hash }); }
    catch (error) { if (error instanceof TransactionNotFoundError) return null; throw error; }
  };
  const receipt = async (hash: Hex, cancellation: boolean) => {
    let found;
    try { found = await rpc.getTransactionReceipt({ hash }); }
    catch (error) { if (error instanceof TransactionReceiptNotFoundError) return null; throw error; }
    const tx = await getTransaction(hash);
    if (!tx || !['success', 'reverted'].includes(found.status) || found.transactionHash.toLowerCase() !== hash.toLowerCase() || tx.hash.toLowerCase() !== hash.toLowerCase() ||
        found.from.toLowerCase() !== config.wallet.toLowerCase() || tx.from.toLowerCase() !== config.wallet.toLowerCase() ||
        tx.nonce !== original.nonce || tx.blockHash !== found.blockHash || tx.blockNumber !== found.blockNumber ||
        (tx.chainId !== undefined && tx.chainId !== 4663)) throw new RecoveryError('Receipt or transaction identity differs from this recovery.');
    if (cancellation && (found.to?.toLowerCase() !== config.wallet.toLowerCase() || tx.to?.toLowerCase() !== config.wallet.toLowerCase() ||
        tx.value !== 0n || tx.input !== '0x' || found.status !== 'success')) throw new RecoveryError('Cancellation is not a successful zero-value empty-input self-transfer.');
    const [block, head] = await Promise.all([rpc.getBlock({ blockNumber: found.blockNumber }), rpc.getBlockNumber({ cacheTime: 0 })]);
    if (block.hash !== found.blockHash || head < found.blockNumber + 1n) return { confirmed: false as const };
    return { confirmed: true as const, operation: { status: cancellation ? 'cancelled' : found.status === 'success' ? 'confirmed' : 'reverted',
      hash, kind: cancellation ? 'cancellation' : original.kind, wallet: config.wallet, chainId: 4663 as const,
      blockNumber: found.blockNumber.toString(), message: cancellation ? 'Original nonce cancelled by a confirmed zero-value self-transfer.' : 'Original transaction mined before cancellation.' } };
  };
  const assess = async (): Promise<Assessment> => {
    const first = await receipt(original.hash as Hex, false);
    if (first) return first.confirmed ? { outcome: first.operation.status === 'confirmed' ? 'original-confirmed' : 'original-reverted', operation: first.operation } : { outcome: 'confirming' };
    const cancellation = record()?.cancellation;
    if (cancellation) {
      const found = await receipt(cancellation.hash, true);
      if (found) return found.confirmed ? { outcome: 'cancelled', operation: found.operation } : { outcome: 'confirming' };
      return { outcome: 'pending' };
    }
    return { outcome: original.status === 'broadcast' && !automatic ? 'pending' : 'cancellation-needed' };
  };
  return { getTransaction, assess };
}

async function cancelOnce(config: Config, rpc: Rpc, original: PendingTransaction, record: RecoveryRecord,
  path: (name: string) => string, core: ReturnType<typeof recoveryCore>, accountLoader: typeof localAccount,
  guard: () => Promise<void>, onDispatch: () => void): Promise<Assessment> {
  if (record.cancellation) return core.assess();
  if (config.mode !== 'private-key') throw new RecoveryError('Cancellation requires the selected raw-key signer; no fallback was used.');
  const tx = await core.getTransaction(original.hash as Hex);
  const [latest, queued] = await Promise.all([
    rpc.getTransactionCount({ address: config.wallet, blockTag: 'latest' }), rpc.getTransactionCount({ address: config.wallet, blockTag: 'pending' }),
  ]);
  if (latest !== original.nonce || (queued !== original.nonce && !tx)) throw new RecoveryError('Nonce evidence is inconsistent or another transaction consumed this nonce; preserve both records.');
  if (tx && (tx.hash.toLowerCase() !== original.hash.toLowerCase() || tx.from.toLowerCase() !== config.wallet.toLowerCase() || tx.nonce !== original.nonce || tx.blockNumber !== null)) throw new RecoveryError('Original transaction identity changed or it is already mined; wait for its receipt.');
  const code = await rpc.getCode({ address: config.wallet });
  if (code && code !== '0x') throw new RecoveryError('Self-cancellation requires an account with no executable code.');
  const marketFee = await rpc.getGasPrice();
  const savedFee = original.gasPrice === undefined ? 0n : BigInt(original.gasPrice);
  const fee = [marketFee, tx?.gasPrice ?? 0n, savedFee].reduce((a, b) => a > b ? a : b) * 2n;
  const gas = (await rpc.estimateGas({ account: config.wallet, to: config.wallet, data: '0x', value: 0n }) * 120n + 99n) / 100n;
  if (fee <= 0n || gas <= 0n || await rpc.getBalance({ address: config.wallet, blockTag: 'pending' }) < fee * gas) throw new RecoveryError('Insufficient native gas balance for cancellation.');
  await guard();
  const account = await accountLoader();
  if (account.address.toLowerCase() !== config.wallet.toLowerCase()) throw new RecoveryError('Local signer differs from the selected wallet.');
  const serialized = await account.signTransaction({ chainId: 4663, type: 'legacy', nonce: original.nonce, to: config.wallet, value: 0n, data: '0x', gas, gasPrice: fee });
  const assessed = await core.assess();
  if (assessed.outcome !== 'cancellation-needed') return assessed;
  await guard();
  const hash = keccak256(serialized);
  record.cancellation = { hash, gas: gas.toString(), gasPrice: fee.toString(), status: 'prepared' };
  await atomicWriteJson(path('recovery.json'), record);
  try { await guard(); }
  catch (error) { record.cancellation.status = 'not-sent'; await atomicWriteJson(path('recovery.json'), record); throw error; }
  onDispatch();
  try {
    const received = await rpc.sendRawTransaction({ serializedTransaction: serialized });
    if (received.toLowerCase() !== hash.toLowerCase()) throw new Error('Unexpected cancellation hash');
    record.cancellation.status = 'broadcast';
  } catch { record.cancellation.status = 'unknown'; }
  await atomicWriteJson(path('recovery.json'), record);
  return core.assess();
}

async function resolveRecovery(config: Config, record: RecoveryRecord, assessed: Extract<Assessment, {operation: Operation}>, path: (name: string) => string,
  noteSwap: (original: PendingTransaction) => Promise<void>) {
  record.resolution = assessed.outcome; record.resolvedAt = new Date().toISOString(); record.operation = assessed.operation;
  await atomicWriteJson(path('recovery.json'), record);
  await atomicWriteJson(path(`recovery-history/${record.original.hash.toLowerCase()}.json`), record);
  await atomicWriteJson(path('last-transaction.json'), assessed.operation);
  if (assessed.outcome === 'original-confirmed' && record.original.kind === 'swap' && !record.swapNotedAt) {
    // Mark a canonical successful swap before removing the pending barrier.
    // The callback scopes the original to its cycle; replay cannot mark a later one.
    await noteSwap(record.original);
    record.swapNotedAt = new Date().toISOString();
    await atomicWriteJson(path('recovery.json'), record);
    await atomicWriteJson(path(`recovery-history/${record.original.hash.toLowerCase()}.json`), record);
  }
  const pending = await readJson<PendingTransaction>(path('pending.json'));
  if (pending) {
    validatePending(pending, config);
    if (transactionIdentity(pending) !== transactionIdentity(record.original)) throw new RecoveryError('Pending identity changed before recovery completion.');
    await rm(path('pending.json'));
  }
}

/** Explicit recovery only. Inspection does not stop, sign, reconcile storage or resume. */
export async function recover(options: RecoveryOptions = {}, overrides: Partial<RecoveryDependencies> = {}): Promise<RecoveryResult> {
  const deps: RecoveryDependencies = { dataDir: DATA, config: loadConfig,
    armed: async () => (await status()).armed, rpc: config => createChain(config).publicClient,
    account: localAccount, resume: expectedStop => launch({ expectedStop }),
    refresh: () => tick(false), noteSuccessfulSwap,
    pause: () => delay(1000), attempts: 60, ...overrides };
  const result: RecoveryResult = { app: 'Rebalance', requested: options.cancel ? 'cancel' : 'inspect',
    outcome: 'blocked', armed: null, messages: [] };
  const path = (name: string) => resolve(deps.dataDir, name);
  const attempts = Math.max(1, Math.min(120, deps.attempts));
  let releaseRecovery: (() => Promise<void>) | undefined;
  let releaseRun: (() => Promise<void>) | undefined;
  let releaseConfig: (() => Promise<void>) | undefined;
  let record: RecoveryRecord | null = null;
  let dispatched = false;
  let resumeAttempted = false;
  const currentStop = async () => stopToken(await readJson(path('stop.json')));
  const control = async (action: () => Promise<void>) => {
    let release: (() => Promise<void>) | undefined;
    for (let i = 0; i < attempts; i++) {
      try { release = await acquireLock(deps.dataDir, 'control.lock'); break; }
      catch (error) {
        if (!(error instanceof Error) || !/^Lock control\.lock is held/.test(error.message)) throw error;
        if (i + 1 < attempts) await deps.pause();
      }
    }
    if (!release) throw new RecoveryError('Another control operation is in progress; no recovery transaction was sent.');
    try { await action(); } finally { await release(); }
  };
  try {
    if (options.expectedStop !== undefined && !/^(none|[a-f0-9]{64})$/.test(options.expectedStop)) throw new RecoveryError('Invalid expected stop token.');
    if (options.requestId !== undefined && (!options.requestId || options.requestId.length > 2048)) throw new RecoveryError('Invalid recovery request identity.');
    if (!options.cancel && (options.requestId !== undefined || options.expectedStop !== undefined)) throw new RecoveryError('Recovery request identity and stop token require explicit cancellation.');
    if (options.cancel) releaseRecovery = await acquireLock(deps.dataDir, 'recovery.lock');
    const config = await deps.config();
    if (!config) throw new RecoveryError('No configured portfolio to recover.');
    result.armed = await deps.armed();
    record = await readJson<RecoveryRecord>(path('recovery.json'));
    if (record) validateRecord(record, config);
    let pending = await readJson<PendingTransaction>(path('pending.json'));
    if (pending) validatePending(pending, config);
    if (!pending && !record) { result.outcome = 'clear'; result.messages.push('No pending transaction or recovery exists.'); return result; }
    if (record && pending && record.original.hash.toLowerCase() !== pending.hash.toLowerCase()) {
      if (!record.resolution) throw new RecoveryError('A different transaction is pending while recovery remains unresolved.');
      record = null; // The completed prior recovery remains in its durable history file.
    }
    if (record && pending && transactionIdentity(record.original) !== transactionIdentity(pending)) throw new RecoveryError('Original recovery identity differs from the current pending record.');
    const original = pending ?? record!.original;
    result.originalHash = original.hash; result.nonce = original.nonce;
    if (record?.cancellation) result.cancellationHash = record.cancellation.hash;
    const rpc = deps.rpc(config);
    if (await rpc.getChainId() !== 4663) throw new RecoveryError('Recovery RPC is not Robinhood mainnet.');
    const core = recoveryCore(config, rpc, original, () => record);
    const assessment = core.assess;
    let assessed = await assessment();
    result.outcome = assessed.outcome;
    if (!options.cancel) {
      result.messages.push('Read-only assessment; no stop, signature, transaction, storage reconciliation or restart was performed.');
      return result;
    }
    if (record?.resolution && !pending) {
      result.messages.push('This recovery already completed. No stop, cancellation or resume was repeated; inspect the current runner state.');
      return result;
    }
    if (options.requestId) {
      const requestPath = path(`recovery-requests/${createHash('sha256').update(options.requestId).digest('hex')}.json`);
      if (await readJson(requestPath)) { result.outcome = 'already-handled'; result.messages.push('This recovery request was already handled; no send or restart was repeated.'); return result; }
      await atomicWriteJson(requestPath, { receivedAt: new Date().toISOString(), originalHash: original.hash });
    }
    // Save whether this command owns a later resume, before asking the runner to stop.
    if (!record) {
      if (!pending) { result.outcome = 'clear'; return result; }
      const priorStop = options.expectedStop ?? await currentStop();
      record = { version: 1, original: pending, createdAt: new Date().toISOString(), originallyArmed: result.armed,
        priorStop, stop: { requestedAt: new Date().toISOString(), requestId: randomUUID() } };
      await atomicWriteJson(path('recovery.json'), record);
    }
    if (!record.stop) {
      // Manual adoption of an automatic journal records this invocation's own
      // stop/resume intent without replacing either transaction identity.
      record.originallyArmed = result.armed;
      record.priorStop = options.expectedStop ?? await currentStop();
      record.stop = { requestedAt: new Date().toISOString(), requestId: randomUUID() };
      await atomicWriteJson(path('recovery.json'), record);
    }
    const ownedStop = stopToken(record.stop);
    await control(async () => {
      const before = await currentStop();
      if (options.expectedStop !== undefined && options.expectedStop !== before) throw new RecoveryError('A newer stop superseded this recovery request.');
      // A later stop still permits receipt-only recovery of an existing attempt.
      // It is never overwritten; ensureStop below forbids a new send, and the
      // conditional resume also requires this recovery's own stop generation.
      if (before !== record!.priorStop && before !== ownedStop) return;
      await atomicWriteJson(path('stop.json'), record!.stop);
    });
    for (let i = 0; i < attempts; i++) {
      try { releaseRun = await acquireLock(deps.dataDir, 'run.lock'); break; }
      catch (error) {
        if (!(error instanceof Error) || !/^Lock run\.lock is held/.test(error.message)) throw error;
        if (i + 1 < attempts) await deps.pause();
      }
    }
    if (!releaseRun) throw new RecoveryError('Waiting for the existing runner to stop; no cancellation was sent. Submit a new recovery request after it stops.');
    result.armed = false;
    releaseConfig = await acquireLock(deps.dataDir, 'config.lock');
    if (JSON.stringify(await deps.config()) !== JSON.stringify(config)) throw new RecoveryError('Configuration changed during recovery; preserve records and inspect the selected account.');
    pending = await readJson<PendingTransaction>(path('pending.json'));
    if (pending) { validatePending(pending, config); if (transactionIdentity(pending) !== transactionIdentity(original)) throw new RecoveryError('Pending identity changed during recovery.'); }
    // The runner may have reconciled the original while cooperatively stopping.
    assessed = await assessment();
    const ensureStop = async () => { if (await currentStop() !== ownedStop) throw new RecoveryError('A newer stop arrived; no further recovery send or resume is authorized.'); };
    if (assessed.outcome === 'cancellation-needed') {
      if (!pending) throw new RecoveryError('The pending barrier disappeared without a validated original receipt.');
      if (!['unknown', 'prepared'].includes(original.status)) throw new RecoveryError('Explicit cancellation is limited to an uncertain original send.');
      assessed = await cancelOnce(config, rpc, original, record, path, core, deps.account, ensureStop, () => { dispatched = true; });
      if (record.cancellation) result.cancellationHash = record.cancellation.hash;
    }
    for (let i = 0; i < attempts; i++) {
      assessed = await assessment();
      if ('operation' in assessed) break;
      if (!record.cancellation || i + 1 === attempts || await currentStop() !== ownedStop) break;
      await deps.pause();
    }
    result.outcome = assessed.outcome;
    if (!('operation' in assessed)) {
      result.messages.push('No canonical confirmed recovery receipt yet. Both identities are retained; later recovery checks will not resend the cancellation.');
      return result;
    }
    await resolveRecovery(config, record, assessed, path, deps.noteSuccessfulSwap);
    // Refresh the cached public state even if a newer stop prevents resuming.
    // This follows the existing observation-only graph; it never signs.
    try {
      const refreshed = await deps.refresh();
      if (refreshed.error) result.messages.push('Recovery is confirmed, but the fresh holdings check failed; retained holdings remain stale.');
    } catch { result.messages.push('Recovery is confirmed, but public holdings could not be refreshed; retained observations remain stale.'); }
    // Release execution/config locks before the ordinary conditional launcher.
    await releaseConfig(); releaseConfig = undefined;
    await releaseRun(); releaseRun = undefined;
    if (record.originallyArmed && !record.resumeAttemptedAt && await currentStop() === ownedStop) {
      record.resumeAttemptedAt = new Date().toISOString();
      await atomicWriteJson(path('recovery.json'), record);
      await atomicWriteJson(path(`recovery-history/${original.hash.toLowerCase()}.json`), record);
      resumeAttempted = true;
      result.resume = await deps.resume(ownedStop);
      result.armed = result.resume.status?.armed ?? null;
      if (result.resume.outcome !== 'armed') result.messages.push('Recovery is confirmed; automatic runner resumption is not verified. Do not blindly repeat a start.');
    } else result.messages.push('Recovery is confirmed. The runner remains stopped because it was not originally active or a newer stop takes precedence.');
    return result;
  } catch (error) {
    if (record?.cancellation) result.cancellationHash = record.cancellation.hash;
    result.outcome = resumeAttempted && record?.resolution ? record.resolution : dispatched ? 'unknown' : 'blocked';
    result.messages.push(resumeAttempted ? 'Recovery is confirmed, but runner resumption could not be verified. No start will be repeated automatically.'
      : error instanceof RecoveryError ? error.message : 'Recovery could not complete; preserve both transaction identities and inspect public status.');
    try { const armed = await deps.armed(); result.armed = resumeAttempted && !armed ? null : armed; } catch { result.armed = null; }
    return result;
  } finally {
    await releaseConfig?.(); await releaseRun?.(); await releaseRecovery?.();
  }
}

export const AUTO_RECOVERY_GRACE_MS = 5 * 60 * 1000;
export type AutomaticRecoveryDependencies = {
  dataDir: string; config: () => Promise<Config | null>; account: typeof localAccount;
  now: () => number; noteSuccessfulSwap: (original: PendingTransaction) => Promise<void>;
};
export type AutomaticRecoveryResult = { blocked: boolean; operation: Operation | null } | null;

/** One recovery step for an already armed runner holding run.lock. Never starts,
 * stops, waits for, or recursively calls the runner. Inspection must not call it. */
export async function automaticRecovery(config: Config, chain: Pick<ReturnType<typeof createChain>, 'publicClient'>,
  overrides: Partial<AutomaticRecoveryDependencies> = {}): Promise<AutomaticRecoveryResult> {
  const deps: AutomaticRecoveryDependencies = { dataDir: DATA, config: loadConfig, account: localAccount,
    now: Date.now, noteSuccessfulSwap, ...overrides };
  const path = (name: string) => resolve(deps.dataDir, name);
  let releaseRecovery: (() => Promise<void>) | undefined;
  let releaseConfig: (() => Promise<void>) | undefined;
  let original: PendingTransaction | null = null;
  let record: RecoveryRecord | null = null;
  let runToken: string | undefined;
  const blocked = (status: string, message: string): AutomaticRecoveryResult => ({ blocked: true,
    operation: { status, hash: original?.hash, kind: original?.kind, wallet: config.wallet, chainId: 4663, message,
      ...(original?.sendFailure ? { sendFailure: original.sendFailure } : {}) } });
  const requireRunLock = async () => {
    const lock = await readJson<{ pid: number; token: string }>(path('run.lock'));
    if (lock?.pid !== process.pid || typeof lock.token !== 'string' || !lock.token || (runToken !== undefined && lock.token !== runToken)) {
      throw new RecoveryError('Automatic recovery requires the current runner to retain its execution lock.');
    }
    runToken ??= lock.token;
  };
  try {
    await requireRunLock();
    // Manual recovery takes this lock before waiting for run.lock. Never wait
    // here while already holding run.lock, or those two operations deadlock.
    try { releaseRecovery = await acquireLock(deps.dataDir, 'recovery.lock'); }
    catch (error) {
      if (error instanceof Error && /^Lock recovery\.lock is held/.test(error.message)) return blocked('recovery-busy', 'Another recovery operation is in progress; no automatic cancellation was attempted.');
      throw error;
    }
    const pending = await readJson<PendingTransaction>(path('pending.json'));
    record = await readJson<RecoveryRecord>(path('recovery.json'));
    if (!pending && (!record || record.resolution)) return null;
    if (pending) validatePending(pending, config);
    if (record) validateRecord(record, config);
    if (record && pending && record.original.hash.toLowerCase() !== pending.hash.toLowerCase()) {
      if (!record.resolution) throw new RecoveryError('A different transaction is pending while recovery remains unresolved.');
      record = null;
    }
    if (record && pending && transactionIdentity(record.original) !== transactionIdentity(pending)) throw new RecoveryError('Original recovery identity differs from the current pending record.');
    original = pending ?? record!.original;
    const rpc = chain.publicClient;
    if (await rpc.getChainId() !== 4663) throw new RecoveryError('Recovery RPC is not Robinhood mainnet.');
    releaseConfig = await acquireLock(deps.dataDir, 'config.lock');
    if (JSON.stringify(await deps.config()) !== JSON.stringify(config)) throw new RecoveryError('Configuration changed during automatic recovery; preserve the original records.');
    const guard = async () => {
      await requireRunLock();
      if (await readJson(path('stop.json'))) throw new RecoveryError('Stop requested; no automatic cancellation will be sent.');
      if (JSON.stringify(await deps.config()) !== JSON.stringify(config)) throw new RecoveryError('Configuration changed during automatic recovery; no cancellation was sent.');
      const current = await readJson<PendingTransaction>(path('pending.json'));
      if (!current || transactionIdentity(current) !== transactionIdentity(original!)) throw new RecoveryError('Pending identity changed during automatic recovery.');
    };
    const core = recoveryCore(config, rpc, original, () => record, true);
    let assessed = await core.assess();
    if (!('operation' in assessed)) {
      if (record?.cancellation) {
        return blocked(assessed.outcome === 'confirming' ? 'confirming' : 'unresolved',
          `Cancellation ${record.cancellation.hash} is awaiting a validated canonical receipt. Neither transaction will be resent.`);
      }
      if (assessed.outcome === 'confirming') return blocked('confirming', 'Original receipt is awaiting canonical two-confirmation evidence; no cancellation was sent.');
      if (config.mode !== 'private-key') return blocked('unresolved', `${config.mode} automatic cancellation is unavailable; no signer fallback was used.`);
      await guard();
      const createdAt = Date.parse(original.createdAt);
      const now = deps.now();
      if (!Number.isFinite(createdAt) || !Number.isSafeInteger(now) || createdAt > now) throw new RecoveryError('Invalid or future-dated pending timestamp; automatic recovery remains blocked.');
      if (now - createdAt < AUTO_RECOVERY_GRACE_MS) return blocked('recovery-wait',
        `Waiting through the five-minute receipt grace until ${new Date(createdAt + AUTO_RECOVERY_GRACE_MS).toISOString()}; the original transaction has not been proved absent.`);
      if (!record) {
        record = { version: 1, automatic: true, original, createdAt: new Date(now).toISOString(), originallyArmed: true };
        await atomicWriteJson(path('recovery.json'), record);
      }
      assessed = await cancelOnce(config, rpc, original, record, path, core, deps.account, guard, () => {});
      if (!('operation' in assessed)) return blocked(assessed.outcome === 'confirming' ? 'confirming' : 'unresolved',
        `Same-nonce cancellation ${record.cancellation?.hash ?? '(not submitted)'} is awaiting receipt reconciliation. No transaction will be blindly resent.`);
    }
    if (!record) {
      record = { version: 1, automatic: true, original, createdAt: new Date(deps.now()).toISOString(), originallyArmed: true };
    }
    if (assessed.outcome === 'original-reverted') assessed = { ...assessed,
      operation: { ...assessed.operation, status: 'recovered-revert', message: 'Original transaction reverted onchain; the nonce is resolved. Rebalancing can continue under the existing cycle timing.' } };
    await requireRunLock();
    await resolveRecovery(config, record, assessed, path, deps.noteSuccessfulSwap);
    return { blocked: false, operation: assessed.operation };
  } catch (error) {
    return blocked('unresolved', error instanceof RecoveryError ? error.message : 'Automatic recovery could not complete. Both transaction identities remain retained; inspect public status.');
  } finally {
    await releaseConfig?.(); await releaseRecovery?.();
  }
}
