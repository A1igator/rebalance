# Direct signing and a Ledger prompt on connection — 2026-09-04

## User requests (verbatim, in order)

> wait nvm let's go back to no sessions simplification. privy and raw just sign automatically and ledger keep track and ping to rebalance on connect

> this way we can maximize current ledger stack compatibility and have everything just work for a cool demo

## Applied decisions

Remove session keys, delegation modules and the session feasibility check from active scope. Preserve the earlier discussion in Git and prompt history. Raw-key and Privy profiles sign and execute their own swaps automatically, without per-trade human input, LLM calls, spending caps or budget accounting.

Ledger tracks drift from the configured public address while disconnected. When it connects, or when the app starts with it attached, reconcile pending sends and refresh balances/config/drift. If rebalancing is still needed, obtain a fresh quote and queue one agent-visible prompt. If already connected when new drift appears, prompt then. A missing agent leaves a pending notification; monitoring does not invoke an LLM.

Device detection, app readiness and the selected account are distinct. Connection never authorizes signing; every Ledger signing operation still requires physical confirmation. Rejection dismisses the request while monitoring continues, without reopening it each poll. Reconnection must not repeat a possibly accepted transaction or reuse an obsolete quote.

Keep the simple application structure and view-only chart. Retain Ledger Key Ring and supported Privy authorization features for their prize demos, as previously requested. Prioritize compatibility with current Ledger Agent Stack signing/swap components, and verify actual runtime behavior after adoption. No new account/delegation framework is needed.

## Independent review prompt (verbatim)

> User final decision: 'wait nvm let's go back to no sessions simplification. privy and raw just sign automatically and ledger keep track and ping to rebalance on connect'. Root removing session feasibility entirely from active MVP, preserving previous prompt history. Raw-key/Privy direct automatic, no spending caps/budgets. Ledger tracks drift disconnected, detects connection and pings via agent; fresh quote/plan, physical confirm before swap. Retain prior Ledger KeyRing and Privy-native prize features unless contradictory, viewonlychart allappcontrolsagent. Read current docs and identify any subtle connection/recovery semantics to preserve, no implementation/research/edits. Return concise material points.

The reviewer identified saved-address monitoring, startup with hardware already attached, readiness/account checks, refreshing stale drift/quotes, notification deduplication, agent unavailability and reconciling prior sends. These are included in the current plan. No code, package installation, hardware test or transaction was performed.
