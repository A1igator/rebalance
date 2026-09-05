import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createChain, type RouteQuote } from './chain.js';
import { DATA, STATE_PATH, loadConfig, type Config } from './config.js';
import { planTrade, type Portfolio, type TradePlan } from './core.js';
import { ledgerCondition, rebalanceCompleted } from './events.js';
import { runGraph, type GraphState } from './graph.js';
import { atomicWriteJson, readJson } from './storage.js';
import { dispatch, reconcile, type Operation } from './transactions.js';

export const STOP_PATH = resolve(DATA, 'stop.json');
export const CYCLE_PATH = resolve(DATA, 'cycle.json');
export const ACTIVE_CYCLE_SECONDS = 600;
type CycleRecord = { wallet: string; startedAt: number; activeUntil: number; nextEligibleAt: number };
export type RebalanceCycle = { startedAt: string; activeUntil: string; nextEligibleAt: string };
export type Status = {
  app: 'Rebalance'; chain: { id: 4663; name: 'Robinhood' };
  mode: Config['mode'] | null; wallet: string | null;
  config: { targets: Record<string, number>; rebalanceIntervalSeconds: number } | null;
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
};

export async function initialStatus(): Promise<Status> {
  const wallet = await readJson<{ address: string }>(resolve(DATA, 'wallet.json'));
  return { app: 'Rebalance', chain: { id: 4663, name: 'Robinhood' }, mode: null,
    wallet: wallet?.address ?? null, config: null, cycle: null, portfolio: null, operation: null,
    updatedAt: null, error: null, graph: { node: 'config', trace: [] }, armed: false };
}

async function readCycle(): Promise<CycleRecord | null> {
  const cycle = await readJson<CycleRecord>(CYCLE_PATH);
  if (!cycle) return null;
  if (typeof cycle.wallet !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(cycle.wallet) ||
      ![cycle.startedAt, cycle.activeUntil, cycle.nextEligibleAt].every(time => Number.isSafeInteger(time) && time >= 0) ||
      cycle.activeUntil < cycle.startedAt || cycle.activeUntil > cycle.startedAt + ACTIVE_CYCLE_SECONDS * 1000 ||
      cycle.nextEligibleAt <= cycle.startedAt) throw new Error('Invalid rebalance cycle record; preserve it for recovery');
  return cycle;
}

function publicCycle(cycle: CycleRecord | null): RebalanceCycle | null {
  return cycle && { startedAt: new Date(cycle.startedAt).toISOString(),
    activeUntil: new Date(cycle.activeUntil).toISOString(), nextEligibleAt: new Date(cycle.nextEligibleAt).toISOString() };
}

function cycleWaiting(cycle: CycleRecord | null, config: Config, now: number): Operation | null {
  if (!cycle) return null;
  const continuing = cycle.wallet.toLowerCase() === config.wallet.toLowerCase() &&
    now >= cycle.startedAt && now < cycle.activeUntil;
  if (continuing || now >= cycle.nextEligibleAt) return null;
  return { status: 'cooling-down', message: `Rebalance interval: no new trades before ${new Date(cycle.nextEligibleAt).toISOString()}. Pending receipts still reconcile.` };
}

/** Caller holds run.lock; target changes and process restarts never reset this record. */
export async function rebalanceInterval(config: Config): Promise<{ cycle: RebalanceCycle | null; operation: Operation | null }> {
  const cycle = await readCycle();
  return { cycle: publicCycle(cycle), operation: cycleWaiting(cycle, config, Date.now()) };
}

/** Persist the cycle before its first dispatch; later approval/swap legs reuse it. */
export async function beginRebalanceCycle(config: Config): Promise<RebalanceCycle> {
  let cycle = await readCycle();
  const now = Date.now();
  const waiting = cycleWaiting(cycle, config, now);
  if (waiting) throw new Error(waiting.message);
  if (!cycle || now >= cycle.activeUntil || cycle.wallet.toLowerCase() !== config.wallet.toLowerCase()) {
    cycle = { wallet: config.wallet, startedAt: now, activeUntil: now + ACTIVE_CYCLE_SECONDS * 1000,
      nextEligibleAt: now + config.rebalanceIntervalSeconds * 1000 };
    await atomicWriteJson(CYCLE_PATH, cycle);
  }
  return publicCycle(cycle)!;
}

/** A fresh no-trade result closes the active window but preserves the next eligible time. */
export async function finishRebalanceCycle(): Promise<void> {
  const cycle = await readCycle();
  if (cycle && Date.now() < cycle.activeUntil) {
    await atomicWriteJson(CYCLE_PATH, { ...cycle, activeUntil: Math.max(cycle.startedAt, Date.now()) });
  }
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
    state.config = { targets: config.targets, rebalanceIntervalSeconds: config.rebalanceIntervalSeconds };
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

/** Caller holds the single-run lock, including for an observation-only check. */
export async function tick(execute: boolean): Promise<Status> {
  const state = await initialStatus();
  const previous = await readJson<Status>(STATE_PATH);
  const configured = await loadConfig();
  if (configured && previous?.wallet?.toLowerCase() === configured.wallet.toLowerCase()) {
    // Keep the last observation visible while waiting for a receipt or a market
    // to reopen. Its original timestamp remains the chart's freshness signal.
    const retained = withCurrentTargets(previous.portfolio, configured);
    Object.assign(state, {
      wallet: configured.wallet, mode: configured.mode, config: { targets: configured.targets, rebalanceIntervalSeconds: configured.rebalanceIntervalSeconds },
      cycle: previous.cycle ?? null,
      portfolio: retained, updatedAt: retained ? previous.updatedAt : null,
      nativeBalance: retained ? previous.nativeBalance : undefined, blockNumber: retained ? previous.blockNumber : undefined,
      valuationNote: retained ? previous.valuationNote : undefined, operation: previous.operation,
    });
  }
  let config: Config;
  let chain: ReturnType<typeof createChain>;
  await runGraph({
    canExecute: execute,
    configured: async () => {
      const loaded = configured;
      if (!loaded) {
        state.operation = { status: 'unconfigured', message: 'Set the target allocation through the agent to begin.' };
        return false;
      }
      config = loaded;
      state.mode = config.mode;
      state.wallet = config.wallet;
      state.config = { targets: config.targets, rebalanceIntervalSeconds: config.rebalanceIntervalSeconds };
      state.armed = execute;
      chain = createChain(config);
      return true;
    },
    reconcile: async () => {
      const result = await reconcile(config, chain);
      state.operation = result.operation;
      return result;
    },
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
      if (config.mode === 'ledger') return { status: 'waiting-ledger', message: 'Drift detected. Hardware connection/signing is deferred until the device arrives.' };
      if (config.mode === 'privy') return { status: 'waiting-privy', message: 'Privy integration is pending; no automatic signer fallback.' };
      const transaction = await chain.transaction(trade, quote as RouteQuote);
      state.cycle = await beginRebalanceCycle(config);
      const cycleDeadline = BigInt(Math.floor(Date.parse(state.cycle.activeUntil) / 1000));
      // Existing dispatch checks enforce this boundary again after gas reads and
      // signing, including for an approval whose calldata has no swap deadline.
      const expiresAt = transaction.expiresAt === undefined || transaction.expiresAt > cycleDeadline
        ? cycleDeadline : transaction.expiresAt;
      return dispatch(config, chain, { ...transaction, expiresAt });
    },
    publish: async (graph, operation) => {
      state.graph = graph;
      if (operation) state.operation = operation;
      await atomicWriteJson(STATE_PATH, state);
    },
  }).catch(async error => {
    state.error = publicError(error);
    await atomicWriteJson(STATE_PATH, state);
  });
  if (!state.error && configured && state.portfolio && state.proposal !== undefined) {
    try {
      if (configured.mode === 'ledger') await ledgerCondition(configured.wallet, configured.targets, state.proposal !== null);
      const total = state.portfolio.totalUsdE8;
      const withinThreshold = total > 0n && state.portfolio.positions.every(position => {
        const delta = position.valueUsdE8 * 10000n - total * BigInt(position.targetBps);
        return (delta < 0n ? -delta : delta) <= total * BigInt(configured.driftThresholdBps);
      });
      if (!state.proposal && withinThreshold && state.operation?.status === 'confirmed' && state.operation.kind === 'swap' && state.operation.hash) {
        await rebalanceCompleted(state.operation.hash);
      }
    } catch { state.error = 'Notification queue unavailable; transaction state was retained.'; await atomicWriteJson(STATE_PATH, state); }
  }
  return state;
}

export async function monitor(signal: AbortSignal): Promise<void> {
  try {
    // Explicit CLI start clears an older stop before announcing/spawning. A stop
    // arriving while the background child starts must remain effective here.
    while (!signal.aborted && !await readJson(STOP_PATH)) {
      const current = await tick(true);
      const config = await loadConfig();
      if (!config) break;
      const until = Date.now() + config.pollSeconds * 1000;
      while (!signal.aborted && Date.now() < until && !await readJson(STOP_PATH)) {
        await delay(Math.min(1000, Math.max(1, until - Date.now())), undefined, { signal }).catch(() => {});
      }
      if (current.operation?.status === 'reverted') break;
    }
  } finally {
    const current = await readJson<Record<string, unknown>>(STATE_PATH) ?? await initialStatus();
    await atomicWriteJson(STATE_PATH, { ...current, armed: false });
  }
}
