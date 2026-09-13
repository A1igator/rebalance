import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { DATA, REBALANCE_REQUEST_ID, type Config } from './config.js';
import { atomicWriteJson, type PendingTransaction } from './storage.js';
import type { Operation } from './transactions.js';

export const CYCLE_PATH = resolve(DATA, 'cycle.json');
export const ACTIVE_CYCLE_SECONDS = 600;
type CycleRecord = { wallet: string; startedAt: number; activeUntil: number; nextEligibleAt: number; swapConfirmed?: boolean; rebalanceRequestId?: string; requestOnly?: true };
export type RebalanceCycle = { startedAt: string; activeUntil: string; nextEligibleAt: string };
const eligibleAt = (cycle: CycleRecord) => cycle.swapConfirmed === false
  ? cycle.startedAt + ACTIVE_CYCLE_SECONDS * 1000 : cycle.nextEligibleAt;
export async function readCycle(): Promise<CycleRecord | null> {
  let cycle: CycleRecord;
  try { cycle = JSON.parse(await readFile(CYCLE_PATH, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  if (!cycle || typeof cycle !== 'object' || Array.isArray(cycle)) throw new Error('Invalid rebalance cycle record; preserve it for recovery');
  if (typeof cycle.wallet !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(cycle.wallet) ||
      ![cycle.startedAt, cycle.activeUntil, cycle.nextEligibleAt].every(time => Number.isSafeInteger(time) && time >= 0) ||
      cycle.activeUntil < cycle.startedAt || cycle.activeUntil > cycle.startedAt + ACTIVE_CYCLE_SECONDS * 1000 ||
      cycle.nextEligibleAt <= cycle.startedAt ||
      (cycle.swapConfirmed !== undefined && typeof cycle.swapConfirmed !== 'boolean') ||
      (cycle.rebalanceRequestId !== undefined && (typeof cycle.rebalanceRequestId !== 'string' || !REBALANCE_REQUEST_ID.test(cycle.rebalanceRequestId))) ||
      (cycle.requestOnly !== undefined && (cycle.requestOnly !== true || !cycle.rebalanceRequestId || cycle.swapConfirmed !== false || cycle.activeUntil !== cycle.startedAt))) throw new Error('Invalid rebalance cycle record; preserve it for recovery');
  return cycle;
}

export function publicCycle(cycle: CycleRecord | null): RebalanceCycle | null {
  return cycle && !cycle.requestOnly ? { startedAt: new Date(cycle.startedAt).toISOString(),
    activeUntil: new Date(cycle.activeUntil).toISOString(), nextEligibleAt: new Date(eligibleAt(cycle)).toISOString() } : null;
}

/** Only a new explicit request for this exact wallet bypasses automatic timing. */
export function hasUserRebalanceRequest(config: Config, cycle: CycleRecord | null): boolean {
  return config.rebalanceRequestId !== undefined && (!cycle ||
    (cycle.wallet.toLowerCase() === config.wallet.toLowerCase() && cycle.rebalanceRequestId !== config.rebalanceRequestId));
}

function cycleWaiting(cycle: CycleRecord | null, config: Config, now: number): Operation | null {
  if (!cycle || cycle.requestOnly || hasUserRebalanceRequest(config, cycle)) return null;
  const continuing = cycle.wallet.toLowerCase() === config.wallet.toLowerCase() &&
    now >= cycle.startedAt && now < cycle.activeUntil;
  const nextStart = eligibleAt(cycle);
  if (continuing || now >= nextStart) return null;
  return { status: 'cooling-down', message: `Rebalance interval: no new trades before ${new Date(nextStart).toISOString()}. Pending receipts still reconcile.` };
}

/** Caller holds run.lock; only an unhandled explicit user request bypasses this record. */
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
  if (!cycle || cycle.requestOnly || hasUserRebalanceRequest(config, cycle) || now >= cycle.activeUntil || cycle.wallet.toLowerCase() !== config.wallet.toLowerCase()) {
    cycle = { wallet: config.wallet, startedAt: now, activeUntil: now + ACTIVE_CYCLE_SECONDS * 1000,
      nextEligibleAt: now + config.rebalanceIntervalSeconds * 1000, swapConfirmed: false,
      ...(config.rebalanceRequestId ? { rebalanceRequestId: config.rebalanceRequestId } : {}) };
    await atomicWriteJson(CYCLE_PATH, cycle);
  }
  return publicCycle(cycle)!;
}

/** A fresh no-trade result handles user intent without shifting an existing cadence.
 * An initial request-only receipt creates no artificial active/cooldown window. */
export async function finishRebalanceCycle(config?: Config): Promise<void> {
  const cycle = await readCycle(), now = Date.now();
  const requested = config && hasUserRebalanceRequest(config, cycle);
  if (!cycle && requested) {
    await atomicWriteJson(CYCLE_PATH, { wallet: config.wallet, startedAt: now, activeUntil: now,
      nextEligibleAt: now + 1, swapConfirmed: false, requestOnly: true, rebalanceRequestId: config.rebalanceRequestId });
  } else if (cycle && (now < cycle.activeUntil || requested)) {
    await atomicWriteJson(CYCLE_PATH, { ...cycle, activeUntil: Math.max(cycle.startedAt, Math.min(cycle.activeUntil, now)),
      ...(requested ? { rebalanceRequestId: config!.rebalanceRequestId } : {}) });
  }
}

/** A mined successful swap establishes the cycle's hourly cadence. Persist this
 * before releasing its pending barrier; repeated receipt observation is harmless. */
export async function noteSuccessfulSwap(original: PendingTransaction): Promise<void> {
  if (original.kind !== 'swap') return;
  const cycle = await readCycle();
  if (!cycle || cycle.requestOnly || cycle.wallet.toLowerCase() !== original.wallet.toLowerCase()) return;
  const sentAt = Date.parse(original.createdAt);
  if (!Number.isFinite(sentAt)) throw new Error('Invalid transaction timestamp; preserve pending state for cadence reconciliation');
  // A historical receipt must not mark a later cycle as having traded.
  if (sentAt < cycle.startedAt || sentAt >= cycle.startedAt + ACTIVE_CYCLE_SECONDS * 1000) return;
  if (cycle.swapConfirmed !== true) await atomicWriteJson(CYCLE_PATH, { ...cycle, swapConfirmed: true });
}
