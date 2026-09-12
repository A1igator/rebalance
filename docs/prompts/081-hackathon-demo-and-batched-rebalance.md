# Hackathon demo and batched Ledger rebalance

Date: 2026-09-12. Human requests, in order:

> idc that much about readablity rather hackathon demo being good because there is top 10 prizes too

> let's do the hackathon plan then. what's next for ledger testing. I unlocked the device

> can we use multicall for a rebalance so one doesn't need to do 4 transactions each time?

> it took me like 10 transactions to rebalance. please reduce it lower or to 2 if possible

## Scope and design before implementation

Prioritize an honest, complete product demo and prepare a short hackathon runbook. Continue permitted public-account and read-only quote checks on the separately funded Ethereum account; this does not migrate the Robinhood application or authorize a different discovered account.

Replace the single-leg execution planner with deterministic phase batches. Collect overweight-stock sales into one router multicall, reconcile its receipt and observe actual balances before preparing one USDG-funded buy batch. Each pool appears once per phase. Quote each amount afresh, retain per-leg minimum output, recipient, network, aggregate balance/allowance checks, and the common deadline. Never count hypothetical sale proceeds as available buy funds.

Approve the exact aggregate amount needed for each input token. Starting with USDG and buying four stocks should require one aggregate approval and one atomic swap transaction; an already sufficient allowance removes that approval. General rebalances can require additional approvals for distinct sold tokens and a separate sell phase, so two transactions is not a universal promise. No unlimited approvals, smart account, permit-signing fallback, new contract, relayer or change to Ledger blind-signing refusal.

Keep one pending hash per batch and the existing receipt, restart, cadence, Stop, live-config and hardware-confirmation boundaries. Fee estimation must count the actual batch gas once and remaining legs/approvals conservatively. Completion still requires fresh within-threshold holdings after a successful receipt. Include isolated planner/ABI/runtime/fee regression tests; no live controls, signing or swaps as validation. Preserve unrelated stock-link changes. Commit and push authorized work to main.
