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
export type Status = {
  app: 'Rebalance'; chain: { id: 4663; name: 'Robinhood' };
  mode: Config['mode'] | null; wallet: string | null;
  config: { targets: Record<string, number> } | null;
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
    wallet: wallet?.address ?? null, config: null, portfolio: null, operation: null,
    updatedAt: null, error: null, graph: { node: 'config', trace: [] }, armed: false };
}

function withCurrentTargets(portfolio: Portfolio | null, config: Config): Portfolio | null {
  if (!portfolio) return null;
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
    state.config = { targets: config.targets };
    state.portfolio = withCurrentTargets(state.portfolio, config);
    if (JSON.stringify(saved?.config?.targets) !== JSON.stringify(config.targets)) delete state.proposal;
  }
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
    Object.assign(state, {
      wallet: configured.wallet, mode: configured.mode, config: { targets: configured.targets },
      portfolio: withCurrentTargets(previous.portfolio, configured), updatedAt: previous.updatedAt,
      nativeBalance: previous.nativeBalance, blockNumber: previous.blockNumber,
      valuationNote: previous.valuationNote, operation: previous.operation,
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
      state.config = { targets: config.targets };
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
    plan: portfolio => {
      const proposal = planTrade(portfolio, 'USDG', config.driftThresholdBps);
      state.proposal = proposal;
      return proposal;
    },
    quote: trade => chain.quote(trade),
    execute: async (trade, quote) => {
      if (await readJson(STOP_PATH)) return { status: 'stopping', message: 'Stop requested; no new transaction sent.' };
      if (config.mode === 'ledger') return { status: 'waiting-ledger', message: 'Drift detected. Hardware connection/signing is deferred until the device arrives.' };
      if (config.mode === 'privy') return { status: 'waiting-privy', message: 'Privy integration is pending; no automatic signer fallback.' };
      return dispatch(config, chain, await chain.transaction(trade, quote as RouteQuote));
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
