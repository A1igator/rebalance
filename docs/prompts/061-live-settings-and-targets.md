# Live settings and targets — 2026-09-10

The human asked: “why can't we update while it's running. that should be a feature for all the settings and targets”. They separately approved pausing the raw-key portfolio and applying its $0.05 USD fee target for the initial code upgrade. That stop and setting save have completed; this implementation does not resume a funded runner.

## Plan before implementation

Let the existing agent CLI save per-wallet targets, allocation policies, drift trigger, cycle interval, slippage, polling cadence and fee target while the runner is active, including during pending-receipt reconciliation. Preserve portfolio identity, pending/recovery records and already recorded cycle timing. An interval edit governs subsequent cycles; it does not erase a wait already earned by an executed swap. Wallet replacement remains a separate portfolio operation; signer-mode replacement requires stopping and resolving pending transactions.

Narrow dispatch's configuration lock so long RPC preparation and device signing do not block settings edits. Compare the captured validated configuration at preparation/signing boundaries and again under the final serialized broadcast boundary. A changed configuration discards an unbroadcast plan/signature and wakes a fresh deterministic traversal without a chat alert. Already submitted or uncertain sends keep their durable receipt barrier. Preserve account identity, nonce, fee, deadline and stop checks; no bypass or new executor.

Remove configuration/policy adoption bans caused solely by an active cycle or pending transaction for ordinary portfolio settings. Use bounded contention handling for the short writer/broadcast boundary, and read the latest configuration under the lock to avoid lost concurrent edits. Test edits during quote/sign waits, final broadcast serialization, pending receipts and cooldown, including no stale sends, preserved records, and event-driven next evaluations. Update documentation and record actual validation. Do not start trading or sign live transactions as validation.
