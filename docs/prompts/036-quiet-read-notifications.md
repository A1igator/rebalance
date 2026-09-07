# Quiet transient read notifications — 2026-09-06 Toronto

The human asked “fix the spam then” after repeated transient holdings/price-read alerts woke the same conversation, usually after reads had already recovered. This request authorizes notification code, tests, documentation and reloading notification delivery. Earlier notification-only prompts do not restrict this implementation task.

## Plan before implementation

- Keep raw events as history; deterministically filter only the known portfolio-observation read-failure alerts before Codex/Claude delivery. Other runtime failures, transaction uncertainty/revert, Ledger, completion and transaction recovery remain immediate.
- Persist a narrow notification incident and suppression record. Allow two minutes for read failures to resolve, send one representative per continuing incident, and require advancing successful observations spanning one minute before resetting a reported incident. A recovery notice must refer only to restored reads and follow an acknowledged failure; it must never claim a new rebalance.
- Use status/queue file events and exact incident deadlines, not a periodic model check. Preserve accepted/uncertain native delivery deduplication and explicitly paused notification preferences.
- Activate the fix by reloading only the notification worker; do not restart/arm/stop the funded runner, touch keys, change allocation/cadence, or submit transactions. Existing raw events remain durable; suppressing notification noise is distinct from a human acknowledgement.
- Test transient failures, persistent failures, intermittent recovery, stale/intermediate snapshots, restarts, deadlines, critical events and storage errors in isolated local fixtures. Record actual validation and deployment evidence.
