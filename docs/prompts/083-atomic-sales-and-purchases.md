# Atomic sales and purchases in one rebalance transaction

Date: September 12, 2026.

User request: “can we merge the sales and purchase into one batch too?” This extends the completed phase-batch and residual-sale milestone in prompt082.

## Implementation plan

Use the existing SwapRouter02 deadline multicall, with every stock sale first and every purchase after it. Every call sends output to the configured wallet; subsequent calls pull USDG from that same wallet. No new contract, custody, relayer, smart account, unlimited allowance, provider or network is added.

At one fresh block, derive the sales from actual holdings and quote their exact inputs. Plan purchases using only held USDG plus the **minimum USDG output encoded into those sale calls**, less a conservatively rounded target cash reserve. Never fund buys using optimistic amountOut. A sale that cannot supply its minimum reverts the whole transaction. Any better proceeds stay in the wallet. Use each stock/pool at most once, so independently pinned quotes do not ignore an earlier trade in the same pool.

Rebuild the full plan, sale minimums, purchase amounts/quotes, aggregate approvals and display/fee counts together during final transaction preparation. Actual held balances remain required for stock sales. Any relaxation of the USDG pre-balance check must require the bounded earlier-sale funding proof; plain or malformed batches cannot bypass balance checks. Preserve exact inputs, per-leg minima, explicit recipients, common expiry, whole-call gas simulation and existing supported token constraints.

The final transaction remains one swap operation/hash. Pending receipts, canonical confirmations, uncertain-send recovery, cycle/fee guards, Stop/settings invalidation and physical Ledger confirmation stay intact. Extra ERC20 approvals remain separate, one per deficient distinct input token. A fresh onchain observation after the receipt decides completion. One swap transaction is not a guarantee of one total transaction or exact final target percentages under market changes.

## Validation and scope

Add pure and encoded-call regressions for invested portfolios, low starting cash, conservative minimum proceeds, reserve protection, rounding, repeated pools/order/overflow rejection, updated quotes and exact aggregate allowances. Add real-runtime coverage for one mixed swap after approvals, one pending hash and full-batch revert without partial completion. Where practical, execute a disposable local EVM contract fixture to validate same-transaction balance visibility and rollback, clearly distinguishing it from deployed Robinhood evidence.

Use disposable test state with network/device signing forbidden. No live trade, runner restart, wallet/configuration edit, secret inspection or new approval request is part of implementation. Verify focused affected tests and typecheck, update provenance/evidence docs, and push reviewed source to main under the owner's standing instruction. Existing unrelated stock-link edits remain excluded.

## Source basis

Official Uniswap Multicall uses sequential delegatecall with propagated failure; V3SwapRouter exactInputSingle uses msg.sender as payer; pool output transfer precedes return and subsequent safeTransferFrom sees the received balance. Official chain deployment mapping and prior identity checks establish the configured router identity; this source review alone does not prove new live batch execution or deployed bytecode equivalence.
