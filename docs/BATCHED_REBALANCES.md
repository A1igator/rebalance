# Batched rebalances

The default path below uses separate token approvals. The explicit [Calibur option](CALIBUR.md) also batches those approvals into the swap transaction for a Ledger wallet. First use requires a delegation authorization plus transaction signature; later rebalances require one transaction signature. This new path has separate validation evidence from the September 13 direct-router result.


Phase batching was added September 12 under [prompt 081](prompts/081-hackathon-demo-and-batched-rebalance.md). [Prompt 082](prompts/082-ledger-completion-and-mixed-batch-check.md) verified the successful sequential Ledger run and removed tiny residual-sale churn. [Prompt 083](prompts/083-atomic-sales-and-purchases.md) combines sales and purchases in one atomic transaction.

The production runtime prepares a Uniswap SwapRouter02 deadline multicall using the existing Robinhood router and signing backends. Every sale precedes every purchase; every output goes directly to the configured wallet. No new contract, custody, smart account, relayer or service is required. A live combined Ledger rebalance was verified on **September 13 at 05:24:24 UTC**: one AAPL approval, one USDG approval and one multicall containing an AAPL sale followed by AMD, NVDA and MSFT purchases. Fresh app status recorded on-target completion at 05:24:28.752 UTC. [Public receipts and bounded nonce audit](evidence/ledger-combined-rebalance-2026-09-13.json).

| Starting condition | Expected transactions when the prepared amounts remain valid |
| --- | --- |
| USDG funding, four stocks to buy, insufficient USDG allowance | One exact aggregate USDG approval, then one multicall with four purchases: **two transactions** |
| Cash-funded or already invested portfolio, sufficient input allowances | **One swap transaction**, containing the required sales followed by purchases |
| Mixed portfolio with deficient allowances | One approval per deficient distinct input token, then **one mixed swap transaction** |

For example, selling AAPL and NVDA to buy MSFT and AMD can require AAPL, NVDA and aggregate USDG approvals, followed by one four-swap multicall. That is four network transactions if all three allowances are insufficient, or one if they are sufficient. These are prepared-plan examples, not a universal transaction limit: material market/target changes, an externally changed allowance, a failed transaction or further material drift can require more work.

ERC20 approvals belong to each token and cannot be made on the wallet's behalf by inserting approve calls into router multicall. The application does not introduce unlimited allowances or assume permit support. Each approval and the final multicall requires physical confirmation for Ledger; the deterministic backend prepares them without per-leg model requests.

## Stable approval amounts

[Prompt 091](prompts/091-ledger-approval-stability.md) fixes repeated exact approvals caused by small price movements. Before signing each prepared transaction, the runtime retains its aggregate input amounts in wallet-local `batch-inputs.json`. Later fresh preparation may reduce those amounts, never increase them or introduce a missing input token. Bounds tighten after every preparation, so a decrease followed by an increase cannot invalidate an earlier exact approval. Stock inputs are clipped before fresh quotes; total USDG purchase spending is capped before allocation across purchases.

The record contains public amounts and a wallet/configuration/cycle identity, not saved quotes, calldata or permission to trade. Approval receipts and restarts retain it. A newly confirmed swap ends that batch; a changed configuration or cycle allows fresh preparation. Unknown/reverted sends keep their receipt barriers. If current holdings need entirely different inputs, the active window closes and existing cadence determines the next evaluation; this is not reported as on-target or completion.

## Atomic funding and execution

Preparation starts from actual holdings at one fresh block. The pure planner selects required sales. Sale quotes provide both expected and minimum output; only the **enforced minimum** can fund purchases within the same transaction. The purchase budget is bounded by:

```text
fixed USDG purchase inputs
    <= starting USDG + sum(encoded sale minimum outputs) - integer cash reserve
```

Every sale must have its stock input already held. The reserve preserves the configured cash target against the chosen conservative valuation and integer rounding; it is not a guarantee of exact final portfolio percentages after market changes. When minimum proceeds leave no spendable surplus, purchases shrink or are omitted. Better sale proceeds remain as additional USDG. Optimistic quoted proceeds never authorize purchases.

Multicall delegates each swap in order while preserving the wallet as payer. An earlier sale transfers USDG to the wallet; a later purchase pulls that received USDG using the wallet's router allowance. Each stock/pool is used at most once across the whole batch, so an independently pinned quote cannot ignore the batch's own earlier trade in that pool. Each leg has an exact input, explicit wallet recipient, minimum output and common onchain expiry. Failure of any leg reverts every swap in that transaction.

Final preparation independently rebuilds holdings, sales, minima, purchase allocation, quotes and exact aggregate approvals together. A previous quote or caller-supplied future balance cannot bypass funding validation. The status proposal and fee counts follow the freshly prepared full plan; projected post-sale holdings are never displayed as actual balances.

The original phase planner remains useful for legacy explicit-phase APIs and projections. Stock residuals within the user's saved drift band do not delay purchases when actual, integer-rounded and input-capped cash purchases can bring every material stock deficit inside the band. Positive cash dust alone is insufficient: otherwise bounded stock sales fund the purchases, even when each stock surplus is individually tolerated. This projection selects the funding phase only; actual purchase authority still comes from held cash and encoded sale minima. If retained input bounds exclude the funding stocks, the runtime waits rather than submitting cash-dust follow-ups or declaring completion. Material stock overweights, cash shortfalls and zero-threshold behavior retain required sales. See [prompt 099](prompts/099-funded-batch-planning-and-stream-rotation.md).

## Receipts, estimates and validation limits

The complete multicall uses one pending hash and one receipt. Success is announced only after a confirmed swap and a fresh within-threshold portfolio observation. A failed final purchase cannot be treated as successful earlier sales. Pending/reverted records, uncertain-send recovery, cycle timing, configuration changes, Stop and device confirmation retain their existing boundaries.

Whole-call gas simulation covers the current multicall once. While allowances are missing, ordinary state cannot yet simulate the future swap; the fee guard conservatively reserves reference gas per planned inner swap plus the remaining deficient approvals. Counts must include both sales and purchases. The estimate is not a guaranteed bill or an actual-spend budget. See [fee targets](FEE_TARGET.md).

The [September 12 sequential audit](evidence/ledger-rebalance-2026-09-12.json) found four separate purchases, two tiny AAPL sales and eight approvals, including one earlier approval. Every swap contained only one router inner call. That verifies the existing Ledger execution path. The [September 13 audit](evidence/ledger-rebalance-2026-09-13.json) additionally verifies a live three-sale multicall followed by a separate purchase multicall under the older phase-batching runner. It contained seven confirmed transactions: five approvals, including a duplicate AMD approval for a 459629799-atomic-unit increase, and two swaps. For that three-stock-sale/one-purchase shape, current combined preparation needs four deficient-token approvals plus one mixed swap (five transactions), or fewer with sufficient allowances. It does not establish a universal two-signature mixed rebalance or explain an eighth unbroadcast physical prompt. Those earlier audits are historical; the later [combined run](evidence/ledger-combined-rebalance-2026-09-13.json) confirms two distinct approvals plus one four-leg multicall, with no duplicate approval in its audited block range. The number of physical review screens was not independently observed. Batching does not establish Clear Signing or remove the adapter's conditional SDK fallback refusal.

Validation uses disposable local state and offline RPC/signing fixtures, including the real chain builder inside the runtime. Cases cover exact distinct approvals, one preapproved mixed swap, minimum-proceeds execution, lower final quotes, higher actual proceeds retained as cash, one receipt barrier, a reverted final purchase and quiet observation invalidation, rising input requirements and shrink-then-rise prices across fresh chain adapters. Both changing-price runtime cases retain exactly one approval per input and one mixed swap. The fixture models mined state and does not itself prove EVM rollback; atomicity follows the cited contract semantics. No local EVM execution or deployed-bytecode equivalence was verified. The later owner-run combined Ledger execution now has a verified successful receipt and on-target app observation; that live evidence is separate from the fixtures. A source update does not hot-reload an already running runner; an owner-controlled Stop/Start loads the new backend while preserving journals and cadence. No live restart or transaction is performed by the implementation tests.

Source semantics: [Multicall](https://github.com/Uniswap/v3-periphery/blob/main/contracts/base/Multicall.sol), [V3 SwapRouter](https://github.com/Uniswap/swap-router-contracts/blob/main/contracts/V3SwapRouter.sol), [pool transfers](https://github.com/Uniswap/v3-core/blob/main/contracts/UniswapV3Pool.sol), [wallet payments](https://github.com/Uniswap/v3-periphery/blob/main/contracts/base/PeripheryPayments.sol). Existing deployment/identity evidence remains in [the route check](ROUTE_CHECK.md); this review does not independently reproduce deployed bytecode equivalence.
