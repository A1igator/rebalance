# Batched rebalances

Phase batching was added September 12 under [prompt 081](prompts/081-hackathon-demo-and-batched-rebalance.md). [Prompt 082](prompts/082-ledger-completion-and-mixed-batch-check.md) verified the successful sequential Ledger run and removed tiny residual-sale churn. [Prompt 083](prompts/083-atomic-sales-and-purchases.md) combines sales and purchases in one atomic transaction.

The production runtime prepares a Uniswap SwapRouter02 deadline multicall using the existing Robinhood router and signing backends. Every sale precedes every purchase; every output goes directly to the configured wallet. No new contract, custody, smart account, relayer or service is required.

| Starting condition | Expected transactions when the prepared amounts remain valid |
| --- | --- |
| USDG funding, four stocks to buy, insufficient USDG allowance | One exact aggregate USDG approval, then one multicall with four purchases: **two transactions** |
| Cash-funded or already invested portfolio, sufficient input allowances | **One swap transaction**, containing the required sales followed by purchases |
| Mixed portfolio with deficient allowances | One approval per deficient distinct input token, then **one mixed swap transaction** |

For example, selling AAPL and NVDA to buy MSFT and AMD can require AAPL, NVDA and aggregate USDG approvals, followed by one four-swap multicall. That is four network transactions if all three allowances are insufficient, or one if they are sufficient. These are prepared-plan examples, not a universal transaction limit: market/target changes, a refreshed exact allowance, a failed transaction or further material drift can require more work.

ERC20 approvals belong to each token and cannot be made on the wallet's behalf by inserting approve calls into router multicall. The application does not introduce unlimited allowances or assume permit support. Each approval and the final multicall requires physical confirmation for Ledger; the deterministic backend prepares them without per-leg model requests.

## Atomic funding and execution

Preparation starts from actual holdings at one fresh block. The pure planner selects required sales. Sale quotes provide both expected and minimum output; only the **enforced minimum** can fund purchases within the same transaction. The purchase budget is bounded by:

```text
fixed USDG purchase inputs
    <= starting USDG + sum(encoded sale minimum outputs) - integer cash reserve
```

Every sale must have its stock input already held. The reserve preserves the configured cash target against the chosen conservative valuation and integer rounding; it is not a guarantee of exact final portfolio percentages after market changes. When minimum proceeds leave no spendable surplus, purchases shrink or are omitted. Better sale proceeds remain as additional USDG. Optimistic quoted proceeds never authorize purchases.

Multicall delegates each swap in order while preserving the wallet as payer. An earlier sale transfers USDG to the wallet; a later purchase pulls that received USDG using the wallet's router allowance. Each stock/pool is used at most once across the whole batch, so an independently pinned quote cannot ignore the batch's own earlier trade in that pool. Each leg has an exact input, explicit wallet recipient, minimum output and common onchain expiry. Failure of any leg reverts every swap in that transaction.

Final preparation independently rebuilds holdings, sales, minima, purchase allocation, quotes and exact aggregate approvals together. A previous quote or caller-supplied future balance cannot bypass funding validation. The status proposal and fee counts follow the freshly prepared full plan; projected post-sale holdings are never displayed as actual balances.

The original phase planner remains useful for legacy explicit-phase APIs and projections. With actual cash surplus available, stock residuals within the user's saved drift band do not delay purchases. Material stock overweights, cash shortfalls and zero-threshold behavior preserve required sales. This avoids the tiny corrective sales observed during the old sequential run.

## Receipts, estimates and validation limits

The complete multicall uses one pending hash and one receipt. Success is announced only after a confirmed swap and a fresh within-threshold portfolio observation. A failed final purchase cannot be treated as successful earlier sales. Pending/reverted records, uncertain-send recovery, cycle timing, configuration changes, Stop and device confirmation retain their existing boundaries.

Whole-call gas simulation covers the current multicall once. While allowances are missing, ordinary state cannot yet simulate the future swap; the fee guard conservatively reserves reference gas per planned inner swap plus the remaining deficient approvals. Counts must include both sales and purchases. The estimate is not a guaranteed bill or an actual-spend budget. See [fee targets](FEE_TARGET.md).

The [September 12 sequential audit](evidence/ledger-rebalance-2026-09-12.json) found four separate purchases, two tiny AAPL sales and eight approvals, including one earlier approval. Every swap contained only one router inner call. That verifies the existing Ledger execution path, not live execution of the new combined multicall. Batching also does not establish Clear Signing or remove the adapter's conditional SDK fallback refusal.

Validation uses disposable local state and offline RPC/signing fixtures, including the real chain builder inside the runtime. Cases cover exact distinct approvals, one preapproved mixed swap, minimum-proceeds execution, lower final quotes, higher actual proceeds retained as cash, one receipt barrier, a reverted final purchase and quiet observation invalidation. The fixture models mined state and does not itself prove EVM rollback; atomicity follows the cited contract semantics. No local EVM execution or deployed-bytecode equivalence was verified. Live combined Ledger execution requires its own owner-controlled confirmation and verified receipt. A source update does not hot-reload an already running runner; an owner-controlled Stop/Start loads the new backend while preserving journals and cadence. No live restart or transaction is performed by the implementation tests.

Source semantics: [Multicall](https://github.com/Uniswap/v3-periphery/blob/main/contracts/base/Multicall.sol), [V3 SwapRouter](https://github.com/Uniswap/swap-router-contracts/blob/main/contracts/V3SwapRouter.sol), [pool transfers](https://github.com/Uniswap/v3-core/blob/main/contracts/UniswapV3Pool.sol), [wallet payments](https://github.com/Uniswap/v3-periphery/blob/main/contracts/base/PeripheryPayments.sol). Existing deployment/identity evidence remains in [the route check](ROUTE_CHECK.md); this review does not independently reproduce deployed bytecode equivalence.
