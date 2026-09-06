import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { DATA } from './config.js';
import { acquireLock, atomicWriteJson, readJson } from './storage.js';

const EVENTS_PATH = resolve(DATA, 'events.json');
const CONDITIONS_PATH = resolve(DATA, 'notification-state.json');
const ATTENTION_PATH = resolve(DATA, 'attention-state.json');
export type RebalanceEvent = {
  id: string; type: 'ledger-rebalance-needed' | 'rebalance-completed' | 'rebalance-attention' | 'rebalance-recovered' | 'notification-test';
  createdAt: string; message: string; hash?: string; acknowledgedAt?: string;
};
export type FailurePhase = 'config' | 'reconcile' | 'recover' | 'observe' | 'plan' | 'interval' | 'quote' | 'execute' | 'publish' | 'unknown';
export type RebalanceAttention = { kind: 'unresolved' | 'reverted'; hash?: string }
  | { kind: 'runtime-failure'; phase: FailurePhase };

const FAILURE_MESSAGES: Record<FailurePhase, string> = {
  config: 'The local configuration could not be loaded.',
  reconcile: 'The previous transaction could not be reconciled.',
  recover: 'Automatic transaction recovery could not proceed.',
  observe: 'Fresh portfolio holdings or prices could not be read.',
  plan: 'The rebalance plan could not be calculated.',
  interval: 'The saved rebalance timing could not be read.',
  quote: 'A usable swap quote could not be obtained.',
  execute: 'Transaction preparation or execution failed.',
  publish: 'The local runtime state could not be saved.',
  unknown: 'A network or local runtime operation failed.',
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

/** Retain one attention transition, including across acknowledgement and restarts. */
export async function attentionCondition(wallet: string | null, condition: RebalanceAttention | null): Promise<void> {
  if (wallet !== null && !/^0x[0-9a-fA-F]{40}$/.test(wallet)) throw new Error('Invalid notification wallet');
  let message: string | undefined;
  let hash: string | undefined;
  let classification: string | undefined;
  if (condition?.kind === 'runtime-failure') {
    if (!Object.hasOwn(FAILURE_MESSAGES, condition.phase)) throw new Error('Invalid notification failure phase');
    classification = `runtime-failure:${condition.phase}`;
    message = `Rebalance needs attention: ${FAILURE_MESSAGES[condition.phase]} No completion is confirmed by this alert. Review the current agent status before recovery.`;
  } else if (condition) {
    if (condition.kind !== 'unresolved' && condition.kind !== 'reverted') throw new Error('Invalid notification condition');
    if (condition.hash !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(condition.hash)) throw new Error('Invalid notification transaction hash');
    hash = condition.hash?.toLowerCase();
    classification = condition.kind;
    message = condition.kind === 'unresolved'
      ? 'Rebalance needs attention: a transaction has an unknown outcome. Further trades are paused while its saved transaction is reconciled. Review the agent status; do not retry the swap.'
      : 'Rebalance needs attention: a transaction reverted. Further trades are paused; review the retained transaction through the agent.';
  }
  const key = condition ? createHash('sha256').update(JSON.stringify([wallet?.toLowerCase() ?? null, classification, hash ?? null])).digest('hex') : null;
  const release = await acquireLock(DATA, 'attention.lock');
  try {
    const previous = await readJson<{ key: string | null; event?: RebalanceEvent }>(ATTENTION_PATH);
    // Recover a condition/queue-write crash even if recovery cleared the current
    // failure before the next tick. Existing acknowledgements remain effective.
    if (previous?.event) await publishEvent(previous.event);
    if (key === previous?.key) return;
    if (!key) {
      if (previous) await atomicWriteJson(ATTENTION_PATH, { key: null });
      return;
    }
    const event: RebalanceEvent = { id: randomUUID(), type: 'rebalance-attention',
      createdAt: new Date().toISOString(), message: message!, ...(hash ? { hash } : {}) };
    await atomicWriteJson(ATTENTION_PATH, { key, event });
    await publishEvent(event);
  } finally { await release(); }
}

export async function rebalanceCompleted(hash: string): Promise<void> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error('Invalid receipt hash for notification');
  await publishEvent({ id: `rebalance-${hash.toLowerCase()}`, type: 'rebalance-completed', hash,
    createdAt: new Date().toISOString(), message: 'Rebalance completed: the last swap is confirmed on Robinhood mainnet and a fresh portfolio check is within the configured drift threshold.' });
}

export async function transactionRecovered(hash: string, outcome: 'cancelled' | 'recovered-revert'): Promise<void> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error('Invalid recovery receipt hash for notification');
  if (!['cancelled', 'recovered-revert'].includes(outcome)) throw new Error('Invalid recovery outcome for notification');
  await publishEvent({ id: `recovery-${hash.toLowerCase()}`, type: 'rebalance-recovered', hash,
    createdAt: new Date().toISOString(), message: outcome === 'cancelled'
      ? 'Transaction recovery confirmed: a zero-value self-cancellation resolved the original nonce. Further portfolio work follows the saved cycle timing. This is not a completed rebalance.'
      : 'Transaction recovery confirmed: the original transaction reverted and its nonce is reconciled. Portfolio work can continue under the saved cycle timing. This is not a completed rebalance.' });
}
