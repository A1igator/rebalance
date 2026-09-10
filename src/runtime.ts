import { resolve } from 'node:path';
import { watch } from 'node:fs';
import { createChain, type RouteQuote } from './chain.js';
import { DATA, STATE_PATH, PENDING_PATH, loadConfig, type Config } from './config.js';
import { allocationSummary } from './allocation-management.js';
import { planTrade, type Portfolio, type TradePlan } from './core.js';
import { attentionCondition, ledgerCondition, rebalanceCompleted, transactionRecovered, type FailurePhase, type RebalanceAttention } from './events.js';
import { automaticRecovery } from './recovery.js';
import { CYCLE_PATH, ACTIVE_CYCLE_SECONDS, readCycle, publicCycle, rebalanceInterval, beginRebalanceCycle, finishRebalanceCycle, type RebalanceCycle } from './cadence.js';
export { CYCLE_PATH, ACTIVE_CYCLE_SECONDS, rebalanceInterval, beginRebalanceCycle, finishRebalanceCycle };
export type { RebalanceCycle };
import { runGraph, type GraphState } from './graph.js';
import { atomicWriteJson, readJson, type PendingTransaction } from './storage.js';
import { driveMonitor } from './monitor.js';
import { dispatch, reconcile, type Operation } from './transactions.js';
import { LedgerExecution, readLedgerRequest, type LedgerRequest } from './ledger-request.js';
import { LedgerSigningError } from './ledger-signing.js';
import { watchLedgerPresence } from './ledger-onboarding.js';
import { createWakeSource } from './wake.js';
export type LedgerPresence = { connected: boolean; revision: number };

export const STOP_PATH = resolve(DATA, 'stop.json');
export type Status = {
  app: 'Rebalance'; chain: { id: 4663; name: 'Robinhood' };
  mode: Config['mode'] | null; wallet: string | null;
  config: { targets: Record<string, number>; rebalanceIntervalSeconds: number; driftThresholdBps: number; allocation?: ReturnType<typeof allocationSummary> } | null;
  cycle: RebalanceCycle | null;
  portfolio: Portfolio | null;
  operation: Operation | null;
  updatedAt: string | null;
  error: string | null;
  graph: GraphState;
  armed: boolean;
  nativeBalance?: bigint;
  blockNumber?: bigint;
  valuationNote?: string;
  proposal?: TradePlan | null;
  ledgerRequest?: LedgerRequest | null;
};

export async function initialStatus(): Promise<Status> {
  const wallet = await readJson<{ address: string }>(resolve(DATA, 'wallet.json'));
  return { app: 'Rebalance', chain: { id: 4663, name: 'Robinhood' }, mode: null,
    wallet: wallet?.address ?? null, config: null, cycle: null, portfolio: null, operation: null,
    updatedAt: null, error: null, graph: { node: 'config', trace: [] }, armed: false };
}

function withCurrentTargets(portfolio: Portfolio | null, config: Config): Portfolio | null {
  if (!portfolio) return null;
  const ids = portfolio.positions.map(position => position.id);
  if (ids.length !== Object.keys(config.targets).length || new Set(ids).size !== ids.length ||
      ids.some(id => !Object.hasOwn(config.targets, id))) return null;
  return { ...portfolio, positions: portfolio.positions.map(position => ({
    ...position, targetBps: config.targets[position.id],
    driftBps: position.weightBps - config.targets[position.id],
  })) };
}

export async function status(): Promise<Status> {
  // Display reads never query RPC or resolve a signing secret.
  const [saved, config] = await Promise.all([readJson<Status>(STATE_PATH), loadConfig()]);
  const state = await initialStatus();
  if (config) {
    if (saved?.wallet?.toLowerCase() === config.wallet.toLowerCase()) Object.assign(state, saved);
    state.wallet = config.wallet;
    state.mode = config.mode;
    state.config = { targets: config.targets, rebalanceIntervalSeconds: config.rebalanceIntervalSeconds,
      driftThresholdBps: config.driftThresholdBps,
      ...(config.allocation ? { allocation: allocationSummary(config) } : {}) };
    state.portfolio = withCurrentTargets(state.portfolio, config);
    if (!state.portfolio) {
      state.updatedAt = null;
      delete state.nativeBalance;
      delete state.blockNumber;
      delete state.valuationNote;
      delete state.proposal;
    }
    if (JSON.stringify(saved?.config?.targets) !== JSON.stringify(config.targets)) delete state.proposal;
  }
  if (config?.mode === 'ledger') state.ledgerRequest = await readLedgerRequest();
  state.cycle = publicCycle(await readCycle());
  const [lock, stopped] = await Promise.all([
    readJson<{ pid: number }>(resolve(DATA, 'run.lock')), readJson(STOP_PATH),
  ]);
  let alive = false;
  if (Number.isSafeInteger(lock?.pid) && lock!.pid > 0) {
    try { process.kill(lock!.pid, 0); alive = true; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM') alive = true;
      else if (code !== 'ESRCH') throw error;
    }
  }
  state.armed = state.armed && alive && !stopped;
  return state;
}

function publicError(error: unknown): string {
  // Provider error objects can contain request payloads/URLs; do not publish them.
  if (error instanceof Error && error.constructor === Error) return error.message.slice(0, 400);
  return 'A network or local operation failed. Execution is paused; check connectivity and the agent status.';
}

function runtimeAttention(state: Status): RebalanceAttention | null {
  if (state.error) {
    const node = state.graph.trace.filter(node => node !== 'error').at(-1);
    const phase: FailurePhase = node && ['config', 'reconcile', 'recover', 'observe', 'plan', 'interval', 'quote', 'execute'].includes(node)
      ? node as FailurePhase : 'unknown';
    return { kind: 'runtime-failure', phase };
  }
  if (state.operation?.status === 'unresolved' || state.operation?.status === 'reverted') {
    return { kind: state.operation.status, ...(state.operation.hash ? { hash: state.operation.hash } : {}) };
  }
  return null;
}

/** Caller holds the single-run lock, including for an observation-only check. */
export async function tick(execute: boolean, chainFor: typeof createChain = createChain, ledger?: LedgerExecution, signal?: AbortSignal, presence?: LedgerPresence): Promise<Status> {
  const state = await initialStatus();
  const connectionRevision = presence?.revision;
  let previous: Status | null = null;
  let configured: Config | null;
  try {
    previous = await readJson<Status>(STATE_PATH);
    configured = await loadConfig();
  } catch (error) {
    await attentionCondition(state.wallet ?? previous?.wallet ?? null, { kind: 'runtime-failure', phase: 'config' }).catch(() => {});
    throw error;
  }
  if (configured && previous?.wallet?.toLowerCase() === configured.wallet.toLowerCase()) {
    // Keep the last observation visible while waiting for a receipt or a market
    // to reopen. Its original timestamp remains the chart's freshness signal.
    const retained = withCurrentTargets(previous.portfolio, configured);
    Object.assign(state, {
      wallet: configured.wallet, mode: configured.mode, config: { targets: configured.targets, rebalanceIntervalSeconds: configured.rebalanceIntervalSeconds,
        driftThresholdBps: configured.driftThresholdBps,
        ...(configured.allocation ? { allocation: allocationSummary(configured) } : {}) },
      cycle: previous.cycle ?? null,
      portfolio: retained, updatedAt: retained ? previous.updatedAt : null,
      nativeBalance: retained ? previous.nativeBalance : undefined, blockNumber: retained ? previous.blockNumber : undefined,
      valuationNote: retained ? previous.valuationNote : undefined, operation: previous.operation,
    });
  }
  let config: Config;
  let chain: ReturnType<typeof createChain>;
  const recoveryObservation: { operation: Operation | null } = { operation: null };
  await runGraph({
    canExecute: execute,
    configured: async () => {
      const loaded = configured;
      if (!loaded) {
        state.operation = { status: 'unconfigured', message: 'Set the target allocation through the agent to begin.' };
        return false;
      }
      config = loaded;
      if (execute && ledger && config.mode === 'ledger') {
        await ledger.prepare(config);
        if (ledger.active) await ledgerCondition(config.wallet, config.targets, true, false);
      }
      else if (ledger?.active) await ledger.finish('configuration-changed');
      state.mode = config.mode;
      state.wallet = config.wallet;
      state.config = { targets: config.targets, rebalanceIntervalSeconds: config.rebalanceIntervalSeconds,
        driftThresholdBps: config.driftThresholdBps,
        ...(config.allocation ? { allocation: allocationSummary(config) } : {}) };
      state.armed = execute;
      chain = chainFor(config);
      return true;
    },
    reconcile: async () => {
      const result = await reconcile(config, chain);
      state.operation = result.operation;
      recoveryObservation.operation = result.operation;
      return result;
    },
    recover: execute && ['private-key', 'privy'].includes(configured?.mode ?? '') ? async () => {
      const recovered = await automaticRecovery(config, chain);
      if (recovered) {
        state.operation = recovered.operation;
        recoveryObservation.operation = recovered.operation;
        state.cycle = publicCycle(await readCycle());
      }
      return recovered;
    } : undefined,
    observe: async () => {
      const snapshot = await chain.snapshot();
      state.portfolio = snapshot.portfolio;
      state.nativeBalance = snapshot.nativeBalance;
      state.blockNumber = snapshot.blockNumber;
      state.valuationNote = snapshot.valuationNote;
      state.updatedAt = new Date().toISOString();
      return snapshot.portfolio;
    },
    plan: async portfolio => {
      const proposal = planTrade(portfolio, 'USDG', config.driftThresholdBps);
      state.proposal = proposal;
      if (!proposal) {
        await finishRebalanceCycle();
        state.cycle = publicCycle(await readCycle());
      }
      return proposal;
    },
    interval: async () => {
      const interval = await rebalanceInterval(config);
      state.cycle = interval.cycle;
      return interval.operation;
    },
    quote: trade => chain.quote(trade),
    execute: async (trade, quote) => {
      if (await readJson(STOP_PATH)) return { status: 'stopping', message: 'Stop requested; no new transaction sent.' };
      if (config.mode === 'ledger' && !ledger?.active) return { status: 'waiting-ledger', message: 'Drift detected. Connect Ledger and request a rebalance through your agent; every transaction requires physical confirmation.' };
      if (config.mode === 'ledger') {
        if (!presence?.connected || presence.revision !== connectionRevision) {
          await ledger!.finish('device-changed');
          return { status: 'waiting-ledger', message: 'Connect and unlock Ledger, then request a fresh rebalance. No transaction was signed.' };
        }
        await ledger!.assertReady(config);
      }
      const transaction = await chain.transaction(trade, quote as RouteQuote);
      state.cycle = await beginRebalanceCycle(config);
      if (config.mode === 'ledger') await ledger!.bindCycle(state.cycle);
      const cycleDeadline = BigInt(Math.floor(Date.parse(state.cycle.activeUntil) / 1000));
      // Existing dispatch checks enforce this boundary again after gas reads and
      // signing, including for an approval whose calldata has no swap deadline.
      let expiresAt = transaction.expiresAt === undefined || transaction.expiresAt > cycleDeadline
        ? cycleDeadline : transaction.expiresAt;
      if (config.mode === 'ledger') {
        const requestDeadline = BigInt(Math.floor(ledger!.expiresAt! / 1000));
        const quoteDeadline = BigInt(Math.floor(Date.now() / 1000) + config.deadlineSeconds);
        expiresAt = [expiresAt, requestDeadline, quoteDeadline].reduce((a, b) => a < b ? a : b);
        return ledgerDispatch(config, chain, { ...transaction, expiresAt }, ledger!, signal, presence!, connectionRevision!);
      }
      return dispatch(config, chain, { ...transaction, expiresAt });
    },
    publish: async (graph, operation) => {
      state.graph = graph;
      if (operation) state.operation = operation;
      await atomicWriteJson(STATE_PATH, state);
    },
  }).catch(async error => {
    if (error instanceof LedgerSigningError) {
      state.operation = { status: `ledger-${error.outcome}`, message: error.message };
      if (!['rejected', 'cancelled', 'timeout'].includes(error.outcome)) state.error = error.message;
    } else state.error = publicError(error);
    await ledger?.finish(error instanceof LedgerSigningError ? error.outcome : 'failed');
    await atomicWriteJson(STATE_PATH, state);
  });
  if (configured?.mode === 'ledger') {
    if (ledger?.active && (state.error || state.proposal === null ||
        ['cooling-down', 'stopping', 'unresolved', 'reverted'].includes(state.operation?.status ?? ''))) {
      await ledger.finish(state.error ? 'failed' : state.proposal === null ? 'on-target' : state.operation!.status);
    }
    state.ledgerRequest = await readLedgerRequest();
    await atomicWriteJson(STATE_PATH, state);
  }
  try {
    // Receipt barriers happen before observe/plan. They still need a durable
    // alert; retained holdings or an old receipt never establish completion.
    await attentionCondition(state.wallet, runtimeAttention(state));
    const recovered = recoveryObservation.operation;
    if (recovered?.hash && (recovered.status === 'cancelled' || recovered.status === 'recovered-revert')) {
      await transactionRecovered(recovered.hash, recovered.status);
    }
    if (!state.error && configured && state.portfolio && state.proposal !== undefined) {
      if (configured.mode === 'ledger') {
        // A cooldown or device rejection does not clear and recreate an incident.
        if (state.proposal === null) await ledgerCondition(configured.wallet, configured.targets, false);
        else if (presence?.connected && !ledger?.active && state.operation?.status !== 'cooling-down') await ledgerCondition(configured.wallet, configured.targets, true);
      }
      const total = state.portfolio.totalUsdE8;
      const withinThreshold = total > 0n && state.portfolio.positions.every(position => {
        const delta = position.valueUsdE8 * 10000n - total * BigInt(position.targetBps);
        return (delta < 0n ? -delta : delta) <= total * BigInt(configured.driftThresholdBps);
      });
      if (!state.proposal && withinThreshold && state.operation?.status === 'confirmed' && state.operation.kind === 'swap' && state.operation.hash) {
        await rebalanceCompleted(state.operation.hash);
      }
    }
  } catch { state.error = 'Notification queue unavailable; transaction state was retained.'; await atomicWriteJson(STATE_PATH, state); }
  return state;
}


/** Stop and request expiry cancel the pending device prompt as well as guarding
 * the send boundary. A missed file event is covered by the existing-scale local
 * watchdog; no RPC or signature retry runs here. */
async function ledgerDispatch(config: Config, chain: ReturnType<typeof createChain>, tx: Awaited<ReturnType<typeof chain.transaction>>,
  ledger: LedgerExecution, parent: AbortSignal | undefined, presence: LedgerPresence, revision: number): Promise<Operation> {
  const controller = new AbortController();
  const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
  const assertReady = async () => {
    await ledger.assertReady(config);
    if (!presence.connected || presence.revision !== revision) throw new LedgerSigningError('unavailable');
  };
  const validate = async () => {
    try { await assertReady(); }
    catch { controller.abort(new Error('Ledger request ended; no new transaction may be sent.')); }
  };
  const watcher = watch(DATA, (_event, file) => {
    if (file === 'stop.json' || file === 'config.json' || file === 'ledger-request.json') void validate();
  });
  watcher.on('error', () => controller.abort(new Error('Ledger control watcher failed.')));
  const watchdog = setInterval(() => { void validate(); }, 1000);
  const deadline = setTimeout(() => controller.abort(new Error('Ledger transaction expired.')),
    Math.max(0, Number(tx.expiresAt!) * 1000 - Date.now()));
  try {
    await assertReady();
    return await dispatch(config, chain, tx, undefined, { signal, assertReady });
  } finally {
    clearInterval(watchdog); clearTimeout(deadline); watcher.close(); controller.abort();
  }
}

export async function monitor(signal: AbortSignal): Promise<void> {
  const ledger = new LedgerExecution();
  const presence: LedgerPresence = { connected: false, revision: 0 };
  let closePresence: (() => Promise<void>) | undefined;
  let wakeLedger: (() => void) | undefined;
  let observedMode: Config['mode'] | undefined;
  let cached: { key: string; chain: ReturnType<typeof createChain> } | undefined;
  const chainFor: typeof createChain = config => {
    const key = JSON.stringify(config);
    if (!cached || cached.key !== key) cached = { key, chain: createChain(config) };
    return cached.chain;
  };
  try {
    await driveMonitor({
      dataDir: DATA, signal,
      run: () => tick(true, chainFor, ledger, signal, presence),
      source: options => {
        wakeLedger = () => options.onWake('ledger');
        // The scheduler calls source only after validating config/stop/signal.
        if (observedMode === 'ledger' && !closePresence) {
          closePresence = watchLedgerPresence(connected => {
            presence.connected = connected; presence.revision++; wakeLedger?.();
          });
        }
        return createWakeSource(options);
      },
      read: async () => {
        try {
          const [config, cycle, pending, stop] = await Promise.all([
            loadConfig(), readCycle(), readJson<PendingTransaction>(PENDING_PATH), readJson(STOP_PATH),
          ]);
          observedMode = config?.mode;
          if (config?.mode !== 'ledger' && closePresence) {
            const close = closePresence; closePresence = undefined; await close();
            presence.connected = false; presence.revision++;
          }
          if (config?.mode === 'ledger' && wakeLedger && !stop && !signal.aborted && !closePresence) {
            closePresence = watchLedgerPresence(connected => {
              presence.connected = connected; presence.revision++; wakeLedger?.();
            });
          }
          const request = config?.mode === 'ledger' ? await readLedgerRequest() : null;
          return { config, cycle: publicCycle(cycle), pending, stopped: stop !== null, ledgerRequest: request ? `${request.id}:${presence.revision}` : `none:${presence.revision}` };
        } catch (error) {
          // A failed pre-traversal read must still surface attention. Never
          // publish parser/provider contents from local configuration or RPC.
          const current = await readJson<Status>(STATE_PATH).catch(() => null)
            ?? await initialStatus().catch(() => null);
          await attentionCondition(current?.wallet ?? null, { kind: 'runtime-failure', phase: 'unknown' }).catch(() => {});
          if (current) await atomicWriteJson(STATE_PATH, { ...current, armed: false,
            error: 'Local control or transaction state could not be read; execution stopped.',
            graph: { node: 'error', trace: ['config', 'error'] } }).catch(() => {});
          throw error;
        }
      },
    });
  } finally {
    wakeLedger = undefined;
    await closePresence?.();
    await ledger.finish('stopped');
    const current = await readJson<Record<string, unknown>>(STATE_PATH) ?? await initialStatus();
    await atomicWriteJson(STATE_PATH, { ...current, armed: false });
  }
}
