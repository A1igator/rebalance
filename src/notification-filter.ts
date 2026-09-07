import type { RebalanceEvent } from './events.js';

const READ_MESSAGE = 'Rebalance needs attention: Fresh portfolio holdings or prices could not be read. No completion is confirmed by this alert. Review the current agent status before recovery.';
const QUOTE_MESSAGE = 'Rebalance needs attention: A usable swap quote could not be obtained. No completion is confirmed by this alert. Review the current agent status before recovery.';

/** Exact legacy producer messages only; unfamiliar or transaction-bearing failures need inspection. */
export const isRetryableAttention = (event: RebalanceEvent): boolean => event.type === 'rebalance-attention' &&
  event.hash === undefined && (event.message === READ_MESSAGE || event.message === QUOTE_MESSAGE);

/** These outcomes need no model/human action, regardless of age, recurrence or current status. */
export const isLocalOnlyNotification = (event: RebalanceEvent): boolean =>
  isRetryableAttention(event) || event.type === 'rebalance-recovered';

export type NotificationSelection = { events: readonly RebalanceEvent[]; nextAt: null };

/** Pure delivery gate: retain raw history, with no status reads, journals, model calls or escalation timer. */
export function createNotificationFilter() {
  return { select: async (queue: readonly RebalanceEvent[]): Promise<NotificationSelection> => ({
    events: queue.filter(event => !event.acknowledgedAt && !isLocalOnlyNotification(event)), nextAt: null,
  }) };
}
