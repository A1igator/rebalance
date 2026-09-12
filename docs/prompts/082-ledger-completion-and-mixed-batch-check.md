# Verify Ledger completion and batching after initial funding

Date: 2026-09-12. Human correction and request:

> last live result everything worked you can see the portfolio in the browser

> you can also check why it took so many transactions to make sure the batching will fix it. batching should work for live rebalancing too post usdg

Verify the displayed account, its current backend state, completion record and public transaction receipts. Correct stale current documentation claiming that Ledger has never completed a swap while preserving the dated earlier failed attempt. Distinguish a successful sequential rebalance from the subsequently introduced batching implementation. Inspect public transaction history to count actual approvals and swaps, rather than assuming every confirmation was a swap.

Add an isolated full-runtime regression for an already invested portfolio: distinct-token approvals, one sales batch, successful receipt and fresh actual cash, then one purchase batch and fresh completion. Exercise the sufficient-allowance case and a lower-than-projected proceeds case without treating expected sales as spendable funds. Existing live runner, targets, wallets, pending records, signing policy and chain selection remain unchanged. No live trade or control click is part of this verification. Commit and push the evidence/documentation/tests under the existing main preference.


Pre-implementation refinement: review identified that a sale's slippage can slightly lower total portfolio value, leaving already-sold stocks microscopically above their recomputed targets. If cash surplus is available and every remaining overweight stock is within the configured drift band, proceed to purchases rather than repeatedly selling those tolerated residuals. A stock outside the band still takes sales priority; when cash is not in surplus, sales remain available to fund deficits. Preserve the user's threshold and test ordinary positive-target lower-proceeds cases. This avoids hidden corrective transaction churn after a sales batch.
