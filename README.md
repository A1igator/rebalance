# Rebalance

A local, agent-controlled portfolio rebalancer for **ETHOnline 2026 — Start from Scratch**.

Ask Claude Code/Codex to change ETH from 20% to 30%. Deterministic code updates the allocation and rebalances when drift exceeds the threshold. Local-key and Privy modes execute automatically, even with the coding agent closed. Ledger mode waits for physical confirmation. The local pie chart is view only.

**Status: planning only.** No application, signer integration or project deployment exists yet. The repository began after the published hacking start on September 4, 2026.

## Minimal MVP

- One TypeScript app, ordinary local config, agent-facing CLI, deterministic loop and chart.
- No spending caps, budget accounting, generic policy engine or custom custody vault.
- Basic swap correctness: integer amounts, usable route/prices, slippage/expiry, available balance/gas and one pending operation at a time.
- Reuse Ledger Agent Stack/DMK and applicable Uniswap components. Keep Key Ring and a focused credential broker for the Ledger demo; hardware work waits for device arrival.
- Keep Privy's TEE wallet and supported scoped authorization for its prize demo, without monetary caps or per-trade human approval.
- Robinhood remains viable, with Base as an alternative. Choose one network and verify stock-route availability separately.

**Next milestone:** an actual automatic raw-key testnet Uniswap swap, receipt and chart update. Local fixtures/forks are tests. Add the real Ledger and Privy flows through the same planner.

Also assess one existing account/session module for Ledger-authorized unattended swaps: approve a session once, then execute until expiry or revocation. This is a feasibility check, with no spending caps or budget counters; the direct signing flow remains the baseline until verified.

Cloud LLM input and Privy's TEE signing are accepted. Keep application data local and secrets outside chat/Git/logs. Disclose external service and public-chain dependencies accurately.

## Project documents

- [PLAN.md](PLAN.md): minimal scope, delivery sequence and essential checks.
- [Ledger Agent Stack](docs/LEDGER_AGENT_STACK.md), [network candidates](docs/NETWORK.md), [Privy assessment](docs/PRIVY.md) and [platform research](docs/RESEARCH.md).
- [Hackathon checklist](docs/HACKATHON.md), [AI provenance](docs/AI_USAGE.md), [simplification prompt](docs/prompts/006-minimal-mvp.md) and [session discussion](docs/prompts/007-session-key-reconsideration.md).
- [Uniswap feedback](FEEDBACK.md), [Ledger feedback](docs/LEDGER_FEEDBACK.md) and [repository governance](docs/REPOSITORY.md).

Planned partners: **Uniswap, Ledger and Privy**. Integrations and submissions remain pending. Before submission, add reproducible setup, exact code/contract links, actual receipts, dependency attribution and the human-narrated demo.

Read [AGENTS.md](AGENTS.md) before implementation. No install/run/test command exists yet. Original project work uses the [MIT license](LICENSE); third-party materials retain their own licenses.
