# Fund material rebalance deficits and keep Stop stable during stream rotation

Date: 2026-09-13. User reports: “I just tried to do a rebalance and seems to have not worked and make me sign twice still” and “the stop icon is also flashing/bugging”. The referenced selector task applied AAPL=30%, AMD=21.81%, MSFT=21.8%, NVDA=21.8%, USDG=4.59%, drift=5%, interval=3600 to the connected Ledger wallet.

## Verified diagnosis

Read-only public RPC receipt and ABI checks confirmed two successful Simple7702 approval/purchase self-calls at nonces 27 and 28, with no repeat authorization. They spent only 0.022673 and 0.000002 USDG. The daemon's 08:25:31 UTC observation still showed AAPL 572 basis points below its 30% target. These are successful partial transactions, not a completed target rebalance. The planner treated any positive cash surplus as sufficient when individual stock overweights were below the drift band; the runtime subsequently equated an empty plan with completion. Sanitized public evidence is retained in `docs/evidence/simple7702-partial-rebalance-2026-09-13.json` without signatures or raw signed transactions.

The Stop flash came from deliberate stream-capacity eviction entering the generic error path. This followed prompt 098's bounded navigation change; it did not establish a trading-runner stop or restart.

## Implementation

The planner tests actual integer-rounded, input-capped cash purchases against material stock deficits before omitting sales. Insufficient cash selects bounded stock sales, with existing atomic purchase funding constrained to held cash plus encoded sale minima. Excluded funding inputs produce a wait rather than dust follow-ups. Empty plans outside the exact drift threshold now remain `observation-changed`; they do not finish the cycle or claim Ledger completion.

Intentional stream rotation has its own event and 15-second reconnect delay. Bounded fresh status/runner/view reads retain the last valid observation while pending, and invalidate on actual failure. Stream and short-read view responses share one complete public contract. Delayed reads, ignored aborts, superseded wallets and control suspension retain their existing safeguards.

## Verification and limits

Isolated suite runs passed: planner/core/chain 75/75; runtime/Ledger 38/38; UI/server rotation 185/185; batch runtime, Simple transactions and fee runtime 45/45. These are suite run counts, not a deduplicated total. A second agent reviewed planner/runtime integration without finding a concrete regression. All fixtures use disposable state. No live runner, targets, receipts, cadence, notification settings or delegation were changed; no signing or trade was initiated. Only verified read-only chart listeners were refreshed. An already-running trading process needs an owner-controlled Stop/Start to load the new planner; existing cooldown and pending-operation barriers remain authoritative. Complete live Simple target rebalancing and Clear Signing remain unverified.

Both refreshed listeners served the new rotation handler. The Ledger endpoint still reported running; the current Codex chart reloaded with its matching Stop control available and the saved cooldown visible. Capacity rotation itself is covered by the isolated HTTP/UI tests rather than by flooding the owner's live browser with extra tabs. Final typecheck and whitespace checks passed.
