# Center execution states and rebalance fee target — 2026-09-10

The human requested current center states such as “rebalancing...”, a failed-rebalance error, a specific gas-above-target state showing gas prices, removal of the Details fee breakdown, and only the target rebalance fee retained there. They also asked about a hypothetical trust-minimized paymaster path using USDG instead of holding ETH.

## Plan before implementation

Retain and refine current center execution/Ledger/receipt states; distinguish an execution failure from a stale read and from a fee-target wait. Remove routine gas balance/price/swap-cost breakdown from Details, retaining the wallet's target rebalance fee and existing cadence fields. Show current gas and estimated rebalance cost only when the configured target blocks execution.

Add an optional per-wallet USD network-fee target controlled through the agent. Ask for the user's target before applying it to a live portfolio; leave existing portfolios unchanged when unset. Use deterministic integer estimates from the existing portfolio planner, gas estimates/references and a fresh explicitly labelled ETH/USD source. Check projected network fees before signing; over-target or unavailable pricing produces a local waiting state and no transaction or chat notification. This is an estimated fee target, not an actual-spend budget or gas guarantee; no generic policy engine, spending-cap accounting or session delegation is added. Re-evaluate through the existing event-driven graph. Preserve raw-key/Privy automatic operation and explicit physical Ledger confirmation.

Record trust assumptions and source freshness. Existing display-only gas values must not silently become execution inputs; any reused source must have an explicit fresh validation path. Test boundary rounding, missing/stale source behavior, no-send/no-sign over target, and clear center states. Do not start/restart funded runners or submit transactions as validation. Commit/push changes with actual test evidence.

Research paymaster availability in official Robinhood/provider documentation. Distinguish provider support, canonical USDG acceptance and smart-account/7702 integration from our current legacy EOA path. Do not create provider credentials, deploy accounts, enable a paymaster or claim ETH-free operation based on documentation alone.
