import { resolve } from 'node:path';
import { DATA, type Config } from './config.js';
import { atomicWriteJson, readJson, type PendingTransaction } from './storage.js';
import type { Operation } from './transactions.js';

export const CYCLE_PATH = resolve(DATA, 'cycle.json');
export const ACTIVE_CYCLE_SECONDS = 600;
type CycleRecord = { wallet: string; startedAt: number; activeUntil: number; nextEligibleAt: number; swapConfirmed?: boolean };
export type RebalanceCycle = { startedAt: string; activeUntil: string; nextEligibleAt: string };
const eligibleAt = (cycle: CycleRecord) => cycle.swapConfirmed === false
  ? cycle.startedAt + ACTIVE_CYCLE_SECONDS * 1000 : cycle.nextEligibleAt;
export async function readCycle(): Promise<CycleRecord | null> {
  const cycle = await readJson<CycleRecord>(CYCLE_PATH);
  if (!cycle) return null;
  if (typeof cycle.wallet !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(cycle.wallet) ||
      ![cycle.startedAt, cycle.activeUntil, cycle.nextEligibleAt].every(time => Number.isSafeInteger(time) && time >= 0) ||
      cycle.activeUntil < cycle.startedAt || cycle.activeUntil > cycle.startedAt + ACTIVE_CYCLE_SECONDS * 1000 ||
      cycle.nextEligibleAt <= cycle.startedAt ||
      (cycle.swapConfirmed !== undefined && typeof cycle.swapConfirmed !== 'boolean')) throw new Error('Invalid rebalance cycle record; preserve it for recovery');
  return cycle;
}

export function publicCycle(cycle: CycleRecord | null): RebalanceCycle | null {
  return cycle && { startedAt: new Date(cycle.startedAt).toISOString(),
    activeUntil: new Date(cycle.activeUntil).toISOString(), nextEligibleAt: new Date(eligibleAt(cycle)).toISOString() };
}

function cycleWaiting(cycle: CycleRecord | null, config: Config, now: number): Operation | null {
  if (!cycle) return null;
  const continuing = cycle.wallet.toLowerCase() === config.wallet.toLowerCase() &&
    now >= cycle.startedAt && now < cycle.activeUntil;
  const nextStart = eligibleAt(cycle);
  if (continuing || now >= nextStart) return null;
  return { status: 'cooling-down', message: `Rebalance interval: no new trades before ${new Date(nextStart).toISOString()}. Pending receipts still reconcile.` };
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
      nextEligibleAt: now + config.rebalanceIntervalSeconds * 1000, swapConfirmed: false };
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

/** A mined successful swap establishes the cycle's hourly cadence. Persist this
 * before releasing its pending barrier; repeated receipt observation is harmless. */
export async function noteSuccessfulSwap(original: PendingTransaction): Promise<void> {
  if (original.kind !== 'swap') return;
  const cycle = await readCycle();
  if (!cycle || cycle.wallet.toLowerCase() !== original.wallet.toLowerCase()) return;
  const sentAt = Date.parse(original.createdAt);
  if (!Number.isFinite(sentAt)) throw new Error('Invalid transaction timestamp; preserve pending state for cadence reconciliation');
  // A historical receipt must not mark a later cycle as having traded.
  if (sentAt < cycle.startedAt || sentAt >= cycle.startedAt + ACTIVE_CYCLE_SECONDS * 1000) return;
  if (cycle.swapConfirmed !== true) await atomicWriteJson(CYCLE_PATH, { ...cycle, swapConfirmed: true });
}
