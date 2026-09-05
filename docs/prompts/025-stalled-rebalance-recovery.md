# Stalled rebalance, chart and alerts — 2026-09-05

## Human requests

> the UI only shows me apple

> can you fix the issues?

The actual chart displays observed holdings of approximately 76% USDG and 24% AAPL. The other selected stocks have zero balances. A real AAPL transfer was found during the initial user-started cycle. The following swap has an unknown send result at nonce 3; read-only Robinhood RPC returned null for its transaction and receipt, with latest/pending nonce both 3. This does not establish that the transaction can safely be forgotten or retried. Public state stays at the last successful holdings observation while reconciliation blocks further trading.

The notification queue contains only completion/Ledger conditions, so the unresolved transaction produced no alert. The chart labels the retained observation as current holdings despite the blocked receipt. These are real usability issues; no missing stock holdings should be fabricated.

## Implementation plan

1. Label retained holdings and unresolved/pending receipts accurately within the existing pie chart. Keep the UI view-only and add no sections, buttons or fabricated balances.
2. Emit one durable, deduplicated attention event for an unresolved transaction or new runtime failure. Preserve acknowledgement/replay behavior; scheduled reporting remains read-only and does not perform recovery or trading.
3. Prepare an explicit user-triggered recovery operation for the current unknown transaction. Inspect/reconcile first. If cancellation is necessary, use only a zero-value self-transfer at the original nonce; never resend the swap or choose a fresh trade nonce. Persist both original and cancellation identities before sending, handle uncertain sends without retries, and clear the original barrier only after validated canonical receipt/nonce evidence. Retain a recovery audit record.
4. Recovery must coordinate with the runner through ordinary stop/locks, preserve cycle timing/configuration and respect newer stop requests. Resume only an originally active runner after verified recovery and only when no newer stop supersedes it. The agent prepares/tests code but does not execute funded cancellation, stop/restart the funded runner, alter its pending state or read signing secrets.
5. Expose the reviewed recovery operation through an explicit deterministic user command, distinct from bare launch, status and notification checks. The next financial recovery step belongs to the user's native invocation. Report uncertain states rather than replaying a command or claiming success.
6. Test receipt races, same-nonce cancellation, uncertain outcomes, crash/replay, state isolation, stop precedence and alert deduplication using isolated fixture keys and mocked providers. Verify the chart against real read-only state, preserve sanitized provenance, commit/push on main, and report the precise remaining user step.

The user accepted existing mainnet fees. No spending cap, session key, automatic replacement policy, generic permission engine or alternative chain is introduced. Cancellation is an explicit recovery action, not a new automatic trading behavior. Raw keys and signed payloads stay out of chat, logs and Git. Live wallet-specific evidence remains local; public documentation should avoid exposing balances, wallet addresses and transaction identifiers unnecessarily.

## Results

Implemented the chart labels, durable `rebalance-attention` events, read-only `recover` assessment and explicit `recover --cancel` handler. Codex's exact `$rebalance recover` and canonical skill reference followed by ` recover` route to the handler, including the supported exact browser framing. Bare launch and notification checks do not cancel. The native hook definition and trust settings remain unchanged.

Independent review corrected resume replay after an uncertain spawn, original-identity validation, receipt-status validation and stale public state after recovery without resumption. Recovery retains both identities and an audit, never repeats an uncertain cancellation, refreshes holdings without signing, preserves cadence and honors newer stops. The existing five-minute current-task heartbeat was updated through the app tool to report runtime-attention events while retaining its notification-only scope and schedule.

Actual validation: **167/167 tests**, TypeScript, Node syntax and Git whitespace passed. This includes 16 isolated recovery tests and 19 hook tests. All signing/send cases use disposable fixture keys and mocked RPC; actual hook-to-CLI tests use isolated unconfigured storage with network blocked. The real chart was reloaded and visually verified with last-known/unresolved labels and no added controls or sections.

Read-only mainnet checks verified the earlier Apple transaction's successful receipt, expected router/account/nonce and canonical block. The new real `recover` assessment returned `cancellation-needed`, nonce 3, with the runner still armed; it performed no stop, signature, send, storage reconciliation or restart. No private key was inspected, funded hook invoked, live cancellation submitted or runner restarted during this fix. The full portfolio remains incomplete. User invocation of `$rebalance recover` is the remaining financial recovery step; its outcome must be checked rather than assumed. The already running process loads new runtime alert code only after a user-driven restart/resume.
