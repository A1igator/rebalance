# Suppress stale notification delivery — 2026-09-07

## Human request

> was that historical event spam? should we fix?

The immediately preceding messages delivered old observation and quote failures while current completed checks reported no error. The user previously required quiet automatic retries/recovery and meaningful completion, Ledger attention or persistent failures only.

## Plan committed before implementation

Trace eligibility, local transport dispatch and native queue acceptance timing using only public notification records and documented/local native queue interfaces. Keep event history intact and distinguish an eligible failure when queued from a stale failure when eventually consumed. Never treat queue acceptance as chat or phone delivery.

Extend the shared deterministic notification gate narrowly to recognized retryable observation and quote failures. Require current matching failure evidence and persistence before waking a chat, suppress obsolete history after successful later observations, and retain deduplication across restart. Do not hide unknown/configuration failures, uncertain transactions, Ledger requests or genuine completions. Recheck eligibility at the serialized delivery boundary so a status change during a backlog cannot dispatch an obsolete event.

If the installed native interface supports safe withdrawal, withdraw only this application's positively identified queued attention messages that have become obsolete, preserving unknown/possibly consumed outcomes. Otherwise document the native queue limitation and strengthen notification-only consumption instructions to acknowledge stale events silently. Do not mutate private application databases or unrelated queued user messages.

Use isolated fixtures for persistence, changing status during delivery, old quotes, slow/queued transports, restart and critical-event preservation. Reload only the existing notification worker after validation; keep trading processes, targets, cadence, pending/recovery records, keys and credentials untouched. Publish aggregate evidence only. The existing authorization to push applies.

## Delegation

One agent investigates supported native queue withdrawal and the delayed records, read-only. Another reviews shared eligibility and transport race conditions. Root implements and verifies the fix, updates the skill/documentation as needed and commits the result.
