# Automatic recovery — 2026-09-05

## Human request

> it should auto recover btw

This supersedes the explicit-user-command-only recovery scope in prompt 025. Raw-key recovery belongs in the already armed deterministic runner, without an LLM decision or a notification/agent command. Ledger still requires physical signing, and Privy remains a deferred adapter.

The preceding user-issued recovery hook reported a confirmed same-nonce cancellation and resumed the runner with its existing allocation/cycle intact. A subsequent public status read shows another uncertain swap; no full-portfolio completion is claimed. The original dispatch exception was not retained, so its cause cannot be reconstructed honestly from a missing receipt.

## Implementation plan

1. Reuse the receipt/cancellation mechanics for a nonblocking automatic recovery stage inside the existing runner's execution lock. Never invoke the CLI stop/start/launch orchestration from the runner or create another process/LLM/schedule to recover.
2. Reconcile first. After a fixed five-minute grace for a stale recorded send, automatic raw-key recovery may prepare one zero-value self-cancellation at that same nonce. Preserve original/cancellation identities before any send, normal gas/balance/account/nonce checks and canonical receipt validation. Existing prepared/unknown cancellation records are only reconciled, never blindly sent again. Missing RPC data is not permission to delete the original.
3. Respect a user stop before signing/sending. Read-only check/status/events never cancel. Deferred Ledger/Privy modes do not fall back to raw signing. Unknown consumed nonces, inconsistent evidence, corrupt records and unavailable prerequisites remain blocked with one durable attention event.
4. A confirmed cancellation or revert ends that active cycle while retaining its next eligible start, so repeated trade failures cannot turn into rapid cancellation/retry cycles. Recovery itself reconciles during cooldown. Do not add monetary caps, session keys, generic policies or new configuration machinery.
5. Retain safe fixed dispatch-error classifications where available, without provider text, credentials or signed payloads. Report recovery progress/completion separately from full rebalance completion; notifications remain outside trading.
6. Test automatic execution with isolated disposable fixture keys and mocked RPC: grace timing, original/cancellation receipt races, crash/replay, stop precedence, inspection isolation, hourly cadence and notification behavior. Update the plan, graph, skill, operational guidance and AI provenance, then commit/push on main.

The assistant implements/tests software and performs public inspection only; it does not restart the funded runner, invoke a funded hook, submit a cancellation or inspect real signing secrets. Runtime updates take effect when the user loads the new runner code; report that deployment boundary truthfully. No network, asset, allocation or fee-policy migration is requested.

## Cadence clarification during implementation

> hourly cooldown doesn't matter if the trade doesn't actually go through since no gas spent

This supersedes point 4's forced cycle closure. A transaction that never mines spends no onchain gas; approvals, mined reverts and cancellations still do. Routine cancellation/revert recovery now continues the existing active window instead of forcing an hourly wait. New cycles record whether any swap has canonically succeeded. That marker is durable before pending is removed through ordinary, automatic and manual receipt resolution. A cycle with no successful swap may start again after its original ten-minute window, without the hourly cooldown. A partial-success cycle retains its saved hourly eligibility. Older cycle records without the new marker remain conservative; absence of historical success evidence is not proof of no successful trade. Restarts, target edits and early balanced observations do not move that original ten-minute retry boundary.

The cadence functions move into a small shared `src/cadence.ts` module so ordinary receipt reconciliation and both recovery paths use the same rule. No budget accounting or per-transaction approval is introduced. Historical receipts cannot mark a later fresh cycle successful. Unknown transactions still require nonce reconciliation; the shorter failed-cycle interval never bypasses a pending barrier.

## Result and validation

Implemented automatic recovery in the armed raw-key graph, shared receipt/cancellation mechanics, successful-swap cadence evidence, fixed safe send diagnostics and distinct retained recovery notifications. The hook remains an explicit user entrypoint; no native hook definition or trust setting changed. The existing five-minute current-task heartbeat now also reports recovery receipts, with the same notification-only scope.

**194/194 tests** and TypeScript checking passed. Coverage includes 30 recovery tests, five dedicated cadence cases, 16 runtime tests, send-diagnostic privacy and the existing actual isolated hook/CLI/channel checks. Automatic and manual success paths mark the relevant cycle before releasing pending; cancellations/reverts keep the current window; cycles without a successful swap become eligible after their original ten-minute window. Tests retain legacy records conservatively and do not confuse an older receipt with a later cycle. All signing uses disposable fixture keys and mocked providers; no funded execution was used for validation.

The assistant read public local status/events and acknowledged the new attention event after reporting it. It did not read a real key, invoke funded recovery, change live pending/cycle/configuration records, stop/restart the runner or submit transactions. The old running process retains its loaded implementation. A subsequent user-triggered recovery/resume is the one-time step to load the update; future routine stale recovery then belongs to the deterministic runner. Legacy cycles without success metadata retain their recorded eligibility. No complete portfolio rebalance or phone delivery is claimed.
