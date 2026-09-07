import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { RebalanceEvent } from './events.js';
import { acquireLock, atomicWriteJson, readJson } from './storage.js';

const STATE = 'read-notification-state.json';
const FAILURE_MS = 120_000;
const RECOVERY_MS = 60_000;
const RETRY_MS = 30_000;
const QUOTE_MESSAGE = 'Rebalance needs attention: A usable swap quote could not be obtained. No completion is confirmed by this alert. Review the current agent status before recovery.';
type Phase = 'observe' | 'quote';
const READ_MESSAGE = 'Rebalance needs attention: Fresh portfolio holdings or prices could not be read. No completion is confirmed by this alert. Review the current agent status before recovery.';
type Reason = 'automatic-recovery' | 'transient-read' | 'duplicate-read' | 'read-restored' | 'previous-wallet' | 'transient-quote' | 'duplicate-quote' | 'quote-restored';
type Incident = {
  wallet: string; representativeId: string; firstFailureAt: number; latestFailureAt: number;
  eligible: boolean; healthySince: number | null; lastHealthyAt: number | null;
};
type FilterState = {
  version: 1; clockAt: number; incident: Incident | null;
  suppressed: { id: string; reason: Reason }[];
};
export type NotificationSelection = {
  events: readonly RebalanceEvent[]; nextAt: number | null; error?: 'filter-unavailable';
};
const idPattern = /^[A-Za-z0-9_-]{1,160}$/;
const walletPattern = /^0x[0-9a-f]{40}$/i;
const validTime = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
const timestamp = (value: unknown): number | null => {
  if (typeof value !== 'string') return null;
  const result = Date.parse(value);
  return validTime(result) ? result : null;
};
const isFailure = (event: RebalanceEvent, phase: Phase) => event.type === 'rebalance-attention' && event.hash === undefined && event.message === (phase === 'observe' ? READ_MESSAGE : QUOTE_MESSAGE);
export const isRetryableAttention = (event: RebalanceEvent) => isFailure(event, 'observe') || isFailure(event, 'quote');

function validateState(value: unknown): FilterState {
  const s = value as FilterState;
  if (!s || s.version !== 1 || !validTime(s.clockAt) || !Array.isArray(s.suppressed) || s.suppressed.length > 10_000 ||
      s.suppressed.some(item => !item || typeof item.id !== 'string' || !idPattern.test(item.id) || !['automatic-recovery', 'transient-read', 'duplicate-read', 'read-restored', 'previous-wallet', 'transient-quote', 'duplicate-quote', 'quote-restored'].includes(item.reason)) ||
      new Set(s.suppressed.map(item => item.id)).size !== s.suppressed.length) throw new Error('Notification filter state unavailable');
  const i = s.incident;
  if (i !== null && (!i || typeof i.wallet !== 'string' || !walletPattern.test(i.wallet) || typeof i.representativeId !== 'string' || !idPattern.test(i.representativeId) ||
      !validTime(i.firstFailureAt) || !validTime(i.latestFailureAt) || i.firstFailureAt > i.latestFailureAt || i.latestFailureAt > s.clockAt ||
      typeof i.eligible !== 'boolean' || (i.healthySince !== null && !validTime(i.healthySince)) ||
      (i.lastHealthyAt !== null && !validTime(i.lastHealthyAt)) ||
      (i.healthySince === null) !== (i.lastHealthyAt === null) ||
      (i.healthySince !== null && (i.healthySince <= i.latestFailureAt || i.lastHealthyAt! < i.healthySince || i.lastHealthyAt! > s.clockAt)))) {
    throw new Error('Notification filter incident unavailable');
  }
  return s;
}

function hasPortfolio(value: unknown): boolean {
  const portfolio = value as { totalUsdE8: string; positions: { id: string; balance: string; priceUsdE8: string; valueUsdE8: string; weightBps: number; targetBps: number }[] };
  const amount = (item: unknown) => typeof item === 'string' && /^\d{1,100}$/.test(item);
  const bps = (item: unknown) => typeof item === 'number' && Number.isInteger(item) && item >= 0 && item <= 10_000;
  return Boolean(portfolio && amount(portfolio.totalUsdE8) && Array.isArray(portfolio.positions) &&
    portfolio.positions.length > 0 && portfolio.positions.length <= 100 && portfolio.positions.every(position =>
      position && typeof position.id === 'string' && position.id.length > 0 && amount(position.balance) &&
      amount(position.priceUsdE8) && amount(position.valueUsdE8) && bps(position.weightBps) && bps(position.targetBps)) &&
    new Set(portfolio.positions.map(position => position.id)).size === portfolio.positions.length);
}

function observation(value: unknown, now: number, phase: Phase, modifiedAt: number | null) {
  const s = value as { wallet: string; error: string | null; updatedAt: string | null; portfolio: unknown; proposal?: unknown; armed?: boolean; graph: { node: string; trace: string[] } };
  if (!s || typeof s.wallet !== 'string' || !walletPattern.test(s.wallet) ||
      !(s.error === null || typeof s.error === 'string') || !s.graph || !Array.isArray(s.graph.trace) ||
      s.graph.trace.some(node => typeof node !== 'string') || typeof s.graph.node !== 'string' ||
      s.graph.trace.at(-1) !== s.graph.node || !(s.updatedAt === null || timestamp(s.updatedAt) !== null)) {
    throw new Error('Notification observation unavailable');
  }
  const updatedAt = timestamp(s.updatedAt);
  if (updatedAt !== null && updatedAt > now) throw new Error('Notification observation timestamp unavailable');
  return {
    wallet: s.wallet.toLowerCase(), updatedAt, hasPortfolio: hasPortfolio(s.portfolio),
    failing: s.armed !== false && modifiedAt !== null && validTime(modifiedAt) && modifiedAt <= now + 1000 && now - modifiedAt < FAILURE_MS && Boolean(s.error) && s.graph.node === 'error' && s.graph.trace.filter(node => node !== 'error').at(-1) === phase,
    healthy: s.error === null && s.graph.node !== 'error' && s.graph.trace.includes('plan') &&
      (phase === 'observe' || (['wait', 'receipt'].includes(s.graph.node) &&
        (s.proposal === null || s.graph.trace.includes('quote')))) &&
      updatedAt !== null && now - updatedAt <= FAILURE_MS && hasPortfolio(s.portfolio),
  };
}

/** Suppression is notification history, never acknowledgement of a raw event. */
export async function readSuppressedEventIds(dataDir: string): Promise<Set<string>> {
  const states = await Promise.all([STATE, 'quote-notification-state.json'].map(name => readJson<unknown>(resolve(dataDir, name))));
  return new Set(states.flatMap(saved => saved === null ? [] : validateState(saved).suppressed.map(item => item.id)));
}

/** No RPC, timers, queue writes or trading imports. Call on queue/status changes and nextAt. */
function createFailureFilter(options: {
  phase: Phase;
  dataDir: string; now?: () => number;
  statusModifiedAt?: () => Promise<number | null>;
  persist?: (path: string, state: unknown) => Promise<void>;
}) {
  const phase = options.phase;
  const stateFile = phase === 'observe' ? STATE : 'quote-notification-state.json';
  const transient: Reason = phase === 'observe' ? 'transient-read' : 'transient-quote';
  const duplicate: Reason = phase === 'observe' ? 'duplicate-read' : 'duplicate-quote';
  const restored: Reason = phase === 'observe' ? 'read-restored' : 'quote-restored';
  const nowFor = options.now ?? Date.now;
  const persist = options.persist ?? atomicWriteJson;
  return { select: async (queue: readonly RebalanceEvent[]): Promise<NotificationSelection> => {
    const immediate: RebalanceEvent[] = [];
    if (!queue.some(event => isFailure(event, phase) || event.type === 'rebalance-recovered')) return { events: immediate, nextAt: null };
    const now = nowFor();
    let release: (() => Promise<void>) | undefined;
    try {
      if (!validTime(now)) throw new Error('Notification clock unavailable');
      release = await acquireLock(options.dataDir, phase === 'observe' ? 'read-notifications.lock' : 'quote-notifications.lock');
      const saved = await readJson<unknown>(resolve(options.dataDir, stateFile));
      const state: FilterState = saved === null ? { version: 1, clockAt: now, incident: null, suppressed: [] } : validateState(saved);
      if (now < state.clockAt) throw new Error('Notification clock moved backwards');
      const before = JSON.stringify(state);
      const suppressed = new Set(state.suppressed.map(item => item.id));
      const suppress = (id: string, reason: Reason) => {
        if (!idPattern.test(id)) throw new Error('Notification identifier unavailable');
        if (!suppressed.has(id)) { suppressed.add(id); state.suppressed.push({ id, reason }); }
      };
      for (const event of queue) if (event.type === 'rebalance-recovered') suppress(event.id, 'automatic-recovery');
      const failures = queue.filter(event => isFailure(event, phase) && !suppressed.has(event.id) &&
        (!event.acknowledgedAt || event.id === state.incident?.representativeId)).map(event => {
        const at = timestamp(event.createdAt);
        if (!idPattern.test(event.id) || at === null || at > now ||
            (event.acknowledgedAt !== undefined && (timestamp(event.acknowledgedAt) === null || timestamp(event.acknowledgedAt)! > now))) {
          throw new Error('Notification failure timestamp unavailable');
        }
        return { event, at };
      }).sort((a, b) => a.at - b.at);
      let nextAt: number | null = null;
      let representative: RebalanceEvent | undefined;
      if (failures.length || state.incident) {
        const path = resolve(options.dataDir, 'status.json');
        const beforeStatus = options.statusModifiedAt ? null : await stat(path);
        const value = await readJson<unknown>(path);
        const afterStatus = options.statusModifiedAt ? null : await stat(path);
        if (beforeStatus && afterStatus && (beforeStatus.ino !== afterStatus.ino || beforeStatus.mtimeMs !== afterStatus.mtimeMs)) throw new Error('Notification observation changed during read');
        const modifiedAt = options.statusModifiedAt ? await options.statusModifiedAt() : Math.floor(afterStatus!.mtimeMs);
        const current = observation(value, now, phase, modifiedAt);
        if (state.incident && state.incident.wallet !== current.wallet) {
          suppress(state.incident.representativeId, 'previous-wallet');
          state.incident = null;
        }
        // A retained observation newer than an old event proves a read already
        // succeeded. It cannot seed an unrelated failure when adopting history.
        if (!state.incident && current.hasPortfolio && current.updatedAt !== null && (phase === 'observe' || current.healthy)) {
          for (const item of failures) if (item.at < current.updatedAt) suppress(item.event.id, transient);
        }
        const candidates = failures.filter(item => !suppressed.has(item.event.id));
        let incident = state.incident;
        const latest = candidates.at(-1);
        if (!incident && latest && current.failing) {
          incident = state.incident = { wallet: current.wallet, representativeId: latest.event.id,
            firstFailureAt: phase === 'quote' ? now : latest.at, latestFailureAt: phase === 'quote' ? now : latest.at, eligible: Boolean(latest.event.acknowledgedAt),
            healthySince: null, lastHealthyAt: null };
        }
        if (incident && latest && latest.at > incident.latestFailureAt) {
          // A new UUID proves the runner cleared its prior condition. Before an
          // alert, even a missed brief success restarts the persistence period.
          if (!incident.eligible) {
            suppress(incident.representativeId, transient);
            incident.representativeId = latest.event.id;
            incident.firstFailureAt = latest.at;
            incident.eligible = Boolean(latest.event.acknowledgedAt);
          }
          incident.latestFailureAt = latest.at;
          incident.healthySince = incident.lastHealthyAt = null;
        }
        for (const item of candidates) {
          if (incident && item.event.id !== incident.representativeId) suppress(item.event.id, duplicate);
          else if (!incident && current.healthy && current.updatedAt! > item.at) suppress(item.event.id, transient);
        }
        if (incident) {
          if (current.failing) {
            incident.healthySince = incident.lastHealthyAt = null;
            if (now - incident.firstFailureAt >= FAILURE_MS) incident.eligible = true;
            if (incident.eligible) representative = candidates.find(item => item.event.id === incident.representativeId)?.event;
            else nextAt = incident.firstFailureAt + FAILURE_MS;
          } else if (current.healthy && current.updatedAt! > incident.latestFailureAt) {
            if (!incident.eligible) {
              suppress(incident.representativeId, transient);
              state.incident = null;
            } else {
              const at = current.updatedAt!;
              incident.healthySince ??= at;
              incident.lastHealthyAt = Math.max(incident.lastHealthyAt ?? at, at);
              if (incident.lastHealthyAt - incident.healthySince >= RECOVERY_MS) {
                suppress(incident.representativeId, restored);
                state.incident = null;
              } else if (incident.healthySince + RECOVERY_MS > now) nextAt = incident.healthySince + RECOVERY_MS;
            }
          }
        }
      }
      if (state.suppressed.length > 10_000) throw new Error('Notification suppression history full');
      if (JSON.stringify(state) !== before || saved === null) {
        state.clockAt = now;
        await persist(resolve(options.dataDir, stateFile), state);
      }
      return { events: representative && !representative.acknowledgedAt ? [...immediate, representative] : immediate, nextAt };
    } catch {
      // A filter failure cannot hold up transaction/Ledger/completion alerts.
      // Quiet entries remain retained and are retried without claiming delivery.
      return { events: immediate, nextAt: validTime(now) ? now + RETRY_MS : null, error: 'filter-unavailable' };
    } finally { await release?.().catch(() => {}); }
  } };
}

/** Recognized automatic read/quote retries are gated independently; critical events pass through. */
export function createNotificationFilter(options: {
  dataDir: string; now?: () => number;
  statusModifiedAt?: () => Promise<number | null>;
  persist?: (path: string, state: unknown) => Promise<void>;
}) {
  const read = createFailureFilter({ ...options, phase: 'observe' });
  const quote = createFailureFilter({ ...options, phase: 'quote' });
  return { select: async (queue: readonly RebalanceEvent[]): Promise<NotificationSelection> => {
    const immediate = queue.filter(event => !event.acknowledgedAt && !isRetryableAttention(event) && event.type !== 'rebalance-recovered');
    const reads = await read.select(queue.filter(event => isFailure(event, 'observe') || event.type === 'rebalance-recovered'));
    const quotes = await quote.select(queue.filter(event => isFailure(event, 'quote')));
    const deadlines = [reads.nextAt, quotes.nextAt].filter((at): at is number => at !== null);
    return { events: [...immediate, ...reads.events, ...quotes.events], nextAt: deadlines.length ? Math.min(...deadlines) : null,
      ...(reads.error || quotes.error ? { error: 'filter-unavailable' as const } : {}) };
  } };
}
