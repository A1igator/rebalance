# Swap and rebalance fee estimates

Date: **2026-09-05 America/Toronto** (September 6 UTC). Prior chart milestone `f3fc1a1` is retained.

## Material user request

> gas to rebalance/swap would specifically be helpful. also I don't think that usd price is correct for 0.41786 gwei is it? I thought it was like 5 cents

## Explanation and implementation plan

The previous number was USD **per gas unit**, mathematically correct but unhelpful as a transaction cost. At approximately $2,500/ETH, 0.41786 gwei is about $0.00000104465 per unit; 48,000 units cost about five cents. Historical five-to-six-cent measurements in `FEE_CHECK.md` were approvals, not this app's stock swap.

- Replace the visible per-unit USD number with approximate swap and additional approval costs, alongside the live gwei rate and existing ETH/USD balance.
- Use independently verified gas units from the app's actual successful Robinhood swap and immediately preceding USDG approval: **168,785 swap gas** and **57,976 approval gas**. Keep public receipt evidence and benchmark identifiers in the repository. Current gas and ETH/USD quotes remain separate, timed inputs.
- Project the number of remaining swaps with the existing pure integer planner and copied public holdings at fixed observed prices. No quote, dispatch, signing or trading-state mutation occurs. Bound projection traversal; invalid, stale, pending or nonconvergent state yields unavailable, never a fabricated estimate.
- Display a rebalance range from that many reference swaps through the same swaps plus one reference approval per leg. Show zero/on-target only when fresh validated holdings satisfy the saved threshold. Match projection wallet, targets and balances to current chart status so an older result cannot survive a portfolio edit or new trade.
- Explicitly label estimates and their historical gas/fixed-price basis. Real gas usage, allowances, calldata, token behavior and prices vary. This range is not a gas cap, budget, route simulation or guaranteed full-cycle fee. Exclude LP fees, price impact and bridging. Do not sum an invented complete historical cycle from the final receipt alone.
- Keep estimates local and view-only. Reload only the chart server as needed; preserve the active runner and its state. Record tests, visual verification and actual public observations.

## Sources and delegation

- [Arbitrum gas estimation](https://docs.arbitrum.io/arbitrum-essentials/how-to-estimate-gas): total fees include parent-chain posting costs within charged gas; those costs and estimated gas can vary. Do not add an extra L1 fee to the measured gas again. Sampled `gasUsedForL1 = 0` does not establish zero future posting fees.
- [Coinbase prices](https://docs.cdp.coinbase.com/coinbase-app/track-apis/prices): the existing ETH/USD reference source.
- Public Robinhood receipts and canonical blocks establish the two application-specific gas samples; [retained evidence](../evidence/robinhood-app-gas-reference.json) records exact values.
- Gas agent verifies and records reference receipts. Projection agent owns the isolated pure estimator and tests. UI agent owns cost formatting, projection identity/freshness and layout tests. Root owns HTTP integration, provenance, final review, checks and read-only server reload.
