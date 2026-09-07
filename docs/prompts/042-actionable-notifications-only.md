# Keep automatic retries out of model context — 2026-09-07

## Human request

> they should not reach the model unless the model or human is needed to act on it

The request follows another temporary holdings/price-read alert reaching the conversation after time-based escalation. The user previously asked that automatic retries and successful recovery remain local, while completion and Ledger notifications remain requested.

## Plan committed before implementation

Replace time-based read/quote escalation with a deterministic local-only classification before either chat transport. Recognized automatic read/quote retries and successful automatic recovery never become model-eligible merely because time passes. Keep raw events available for explicit inspection; do not falsely acknowledge them. Preserve actionable configuration/signing/transaction failures, Ledger attention, requested rebalance completion and explicitly requested connection tests. Review producer classifications for remaining automatic cases without changing trading behavior.

Simplify obsolete incident/deadline machinery where practical. Withdraw application-owned accepted native queue entries for now-local-only alerts using the existing supported deletion path, preserving uncertain/no-resend barriers. Already consumed native messages cannot be recalled. Test long-lived/flapping/restarted retries, missing or corrupt old state, both chat transports, legacy accepted queue withdrawal and critical-event delivery. No new schedule or model classifier.

Update notification documentation, receiver instructions and aggregate evidence. Reload only the notification listener to apply the change to the existing funded process's events, verifying portfolio/trading records unchanged. Do not restart or stop trading, sign, submit, recover financially, change targets or inspect credentials. Push under the user's existing authorization.

## Delegation

Root owns the shared filter, documentation and notification-only activation. Independent agents own transport regressions and review event producers for actionable versus deterministic outcomes. All verification uses isolated fixtures or read-only public runtime metadata.
