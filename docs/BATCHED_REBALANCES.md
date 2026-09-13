# Batched rebalances

Added September 12 under [prompt 081](prompts/081-hackathon-demo-and-batched-rebalance.md).

The runtime prepares an atomic Uniswap SwapRouter02 multicall for each rebalance phase. It uses the same verified Robinhood router and signing backends; no new contract, smart account, relayer or service is required.

| Starting condition | Network transactions required for a phase |
| --- | --- |
| USDG funding, four stocks to buy, insufficient USDG allowance | One exact aggregate USDG approval, then one multicall with four purchases: **two transactions** |
| Same purchases with sufficient USDG allowance | One multicall transaction |
| Several overweight stocks, then purchases, sufficient allowances | One sales multicall, confirmed receipt and fresh cash, then one purchase multicall: **two swap transactions** |
| Same mixed portfolio with deficient allowances | Those two swap batches, plus one approval per deficient stock input and any required aggregate USDG approval |

Two transactions is achievable for the cash-funded example or a mixed portfolio with sufficient allowances, not a universal maximum. ERC-20 approvals belong to each token and cannot be made on the wallet's behalf by inserting approve calls into router multicall. The application does not introduce unlimited allowances or assume permit support. Exact approval amounts can require refreshing if balances, targets or market prices change before the subsequent phase is built.

## Execution

The pure [phase planner](../src/core.ts) collects executable overweight stock sales when an overweight exceeds the saved drift band or cash has no surplus. Otherwise it distributes only the wallet's currently held USDG surplus across stock deficits, preserving the USDG target reserve and deterministic integer rounding. After sales, fees/slippage can leave stocks slightly above recomputed targets. Those residuals no longer cause extra sales while they are within the user's band and cash can fund purchases. A material overweight or cash shortfall still takes the sales path; a zero threshold remains strict. Hypothetical sale proceeds are never included in a buy budget. Material price changes, changed targets, reverts or refreshed exact approvals can still require additional transactions.

The [chain adapter](../src/chain.ts) validates one to four distinct stock routes in the same direction, verifies aggregate input balance and allowance, and reads corporate-action state and fresh quotes at one block. It emits one exact approval for each deficient input token, or a multicall with one exactInputSingle per stock, the configured wallet as recipient, per-leg minimum output and a shared expiry. One failed inner call reverts the entire swap transaction. Slippage checks still apply independently to every leg.

The [runtime](../src/runtime.ts) reconciles the single batch receipt before refreshing holdings and planning another phase. Success is not announced from an approval or submitted hash; a confirmed swap and fresh within-threshold holdings are required. Pending/reverted records, cycle timing, configuration changes and Stop keep their existing boundaries. A code update does not hot-reload an already running process; the owner can Stop and Start the portfolio to load the new backend without deleting journals or resetting its recorded cadence.

Ledger physically confirms each approval transaction and each swap batch. The backend prepares these directly; no per-leg model request is needed. The [existing sequential Ledger flow completed live](LEDGER_EXECUTION.md#verified-sequential-rebalance-batch-validation-pending). Batching does not change the conditional SDK fallback refusal or establish Clear Signing compatibility. Live batch execution and readable device display are separate validation checks.

## Fee estimates and evidence

The current multicall's simulated buffered gas is counted once, covering all of its inner swaps. For an approval, the future batch cannot yet be simulated against ordinary state; the fee guard conservatively reserves measured reference gas per planned swap leg, plus only the distinct approvals still required in that phase. Later phases retain conservative reference estimates and are refreshed before execution. This remains an estimate of remaining fees, not a guaranteed final bill or actual-spend budget. See [fee targets](FEE_TARGET.md).

Tests use only disposable local state and offline RPC/signing fixtures. They cover aggregate approval, four encoded swaps, fresh minimum outputs, distinct input allowances, funding limits, atomic pending/revert handling, Stop/configuration invalidation and batch fee accounting. Mixed-portfolio runtime tests also cover separate input approvals, two swap batches with sufficient allowances, lower actual sale proceeds, and pending/minimum-confirmation barriers before any new observation or purchase. They use positive retained stock targets and verify that tolerated residuals do not create another sales phase. Live Ledger batch execution is not established by these fixtures.

The [September 12 sequential transaction audit](evidence/ledger-rebalance-2026-09-12.json) found four separate purchases, two tiny AAPL sales and eight approvals (including one earlier approval). This explains why the old run required so many confirmations. Batching groups purchases and sales, while the residual fix removes that observed small-sale churn; it does not promise two transactions regardless of allowance or market conditions.

Upstream semantics: [Uniswap Multicall](https://github.com/Uniswap/v3-periphery/blob/main/contracts/base/Multicall.sol), [V3 SwapRouter](https://github.com/Uniswap/swap-router-contracts/blob/main/contracts/V3SwapRouter.sol). Existing dependency and deployment provenance stays in [the route evidence](RWA_CHECK.md).
