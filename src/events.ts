import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { DATA } from './config.js';
import { acquireLock, atomicWriteJson, readJson } from './storage.js';

const EVENTS_PATH = resolve(DATA, 'events.json');
const CONDITIONS_PATH = resolve(DATA, 'notification-state.json');
export type RebalanceEvent = {
  id: string; type: 'ledger-rebalance-needed' | 'rebalance-completed';
  createdAt: string; message: string; hash?: string; acknowledgedAt?: string;
};

async function edit<T>(action: () => Promise<T>): Promise<T> {
  const release = await acquireLock(DATA, 'events.lock');
  try { return await action(); } finally { await release(); }
}
export async function events(): Promise<RebalanceEvent[]> {
  return (await readJson<RebalanceEvent[]>(EVENTS_PATH) ?? []).filter(event => !event.acknowledgedAt);
}
export async function publishEvent(event: RebalanceEvent): Promise<void> {
  await edit(async () => {
    const saved = await readJson<RebalanceEvent[]>(EVENTS_PATH) ?? [];
    if (saved.some(previous => previous.id === event.id)) return;
    await atomicWriteJson(EVENTS_PATH, [...saved, event]);
  });
}
export async function acknowledgeEvent(id: string): Promise<void> {
  await edit(async () => {
    const saved = await readJson<RebalanceEvent[]>(EVENTS_PATH) ?? [];
    const event = saved.find(event => event.id === id);
    if (!event) throw new Error('Unknown notification event');
    event.acknowledgedAt ??= new Date().toISOString();
    await atomicWriteJson(EVENTS_PATH, saved);
  });
}

/** Stable condition key prevents a fresh Ledger alert on every monitor tick. */
export async function ledgerCondition(wallet: string, targets: Record<string, number>, needed: boolean): Promise<void> {
  const key = needed ? createHash('sha256').update(wallet.toLowerCase() + JSON.stringify(Object.entries(targets).sort())).digest('hex') : null;
  const previous = await readJson<{ key: string | null; event?: RebalanceEvent }>(CONDITIONS_PATH);
  if (key === previous?.key) {
    // Reconcile a crash between persisting the condition and its queue entry.
    if (previous.event) await publishEvent(previous.event);
    return;
  }
  if (key) {
    const event: RebalanceEvent = { id: randomUUID(), type: 'ledger-rebalance-needed', createdAt: new Date().toISOString(),
      message: 'Your Ledger portfolio has drifted beyond its target threshold. Reopen the local agent session to review a fresh rebalance. Device signing integration is pending hardware setup.' };
    await atomicWriteJson(CONDITIONS_PATH, { key, event });
    await publishEvent(event);
  } else await atomicWriteJson(CONDITIONS_PATH, { key: null });
}

export async function rebalanceCompleted(hash: string): Promise<void> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error('Invalid receipt hash for notification');
  await publishEvent({ id: `rebalance-${hash.toLowerCase()}`, type: 'rebalance-completed', hash,
    createdAt: new Date().toISOString(), message: 'Rebalance completed: the last swap is confirmed on Robinhood mainnet and a fresh portfolio check is within the configured drift threshold.' });
}
