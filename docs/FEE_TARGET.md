# Estimated rebalance fee target

An optional `rebalanceFeeTargetUsdE8` belongs to each wallet configuration. The agent uses `fees target <USD>`, `fees status` and `fees clear`, with `--profile <address>` for explicit scope. Decimal input is converted exactly to integer units of one hundred-millionth of a dollar. Zero is valid; missing means no fee target. Other settings/allocations survive fee edits, and ordinary configuration edits preserve the target.

The human selected $0.05 for the raw-key portfolio on September 10. This is not a default for newly created wallets or the other registered portfolios.

## Deterministic calculation

The fixed-price planner projects the swaps remaining from fresh holdings to within the configured drift threshold, with a bound of 16 legs. Nonconvergence or invalid input has no usable estimate. Before dispatch, the current transaction uses `eth_estimateGas` and the current gas price, each with 20% integer-ceiling headroom. Remaining swaps use 168,785 gas and remaining approvals 57,976 gas from [measured application receipts](evidence/robinhood-app-gas-reference.json), also with 20% headroom. The projection conservatively includes one approval for each remaining swap, avoiding counting the current swap/approval twice.

A separate fresh [Coinbase ETH/USD spot](https://docs.cdp.coinbase.com/coinbase-app/track-apis/prices) request converts native cost into integer USD with ceiling rounding. The request has a four-second fetch/body deadline, bounded body, validated ETH/USD identity and exact decimal parsing. It never uses the display endpoint’s cache or last-good values. Providers receive no portfolio, balance, wallet or credential in this price request, but observe the host’s network request. The stored observation time is local response receipt, not an independently verified market-data timestamp. RPC and Coinbase remain trusted data dependencies.

Over-target or unavailable estimates become `fee-target` waiting state. No approval/swap is signed or sent. Raw-key/Privy retries remain deterministic and local, without notifications or an LLM turn. Existing chain events, cadence and watchdogs schedule the next check. Ledger can assess fees without a signing request or device access; it requests attention only once an affordable estimate and the existing drift/connection conditions permit it. Actual Ledger dispatch rechecks fees and still needs explicit request authority and physical approval. A price observation older than 30 seconds is refreshed again before signing/broadcast, including after a slow device confirmation.

The chart center shows state, trigger, cycle interval and saved fee target. Only a fee block shows the estimated cost and buffered gas price. Changing allocation, drift threshold or fee target invalidates saved fee-block details until the graph recomputes them. Missing pricing is a waiting state, not zero cost.

## Limits

This checks estimated **remaining rebalance network fees**, including projected approvals, before each transaction. It does not maintain an actual-spend budget. Changing prices, gas, routes, allowances and slippage can change subsequent legs or realized cost, so the selected amount is not a guaranteed final total. Historical gas references are approximations, not simulations of every future leg. DEX fees, price impact, bridging and recovery cancellations are excluded. A transaction already broadcast may still settle or require the existing recovery path. Existing nonce, receipt, account identity, deadline, stop and configuration checks remain in force.

Source changes do not hot-reload a running process. Enforcing the new check requires the runner to load this code; a saved target alone cannot upgrade an old process. Status records written by this version include `feeTargetVersion: 1`; that field is version evidence, not proof of a completed trade. Native ETH remains required. [Paymaster checks](PAYMASTER_CHECK.md) distinguish available infrastructure from an implemented USDG payment route.
