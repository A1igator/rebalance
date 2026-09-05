# Rebalance

A local, agent-controlled portfolio rebalancer for **ETHOnline 2026 — Start from Scratch**.

Ask Claude Code/Codex to change ETH from 20% to 30%. Deterministic code updates the allocation and rebalances when drift exceeds the threshold. Local-key and Privy modes execute automatically, even with the coding agent closed. Ledger mode tracks drift while disconnected and prompts through the agent for a fresh rebalance when connected; signing requires physical confirmation. The local pie chart is view only.

**Status: planning only.** No application, signer integration or project deployment exists yet. The repository began after the published hacking start on September 4, 2026.

## Minimal MVP

- One TypeScript app, ordinary local config, agent-facing CLI, deterministic loop and chart.
- No session keys, delegation modules, spending caps, budget accounting, generic policy engine or custom custody vault.
- Basic swap correctness: integer amounts, usable route/prices, slippage/expiry, available balance/gas and one pending operation at a time.
- Reuse Ledger Agent Stack/DMK and applicable Uniswap components. Keep Key Ring and a focused credential broker for the Ledger demo; hardware work waits for device arrival.
- Keep Privy's TEE wallet and supported scoped authorization for its prize demo, without monetary caps or per-trade human approval.
- **Robinhood mainnet (4663) only** for live integration, deployments and demo. Verify stock-route availability on Robinhood; no alternative chain.

**Next milestone:** an actual automatic raw-key Uniswap swap on Robinhood mainnet, receipt and chart update using live assets. Local fixtures/forks are development tests; no testnet or mock-stock demo is planned. Add the Ledger and Privy Robinhood flows through the same planner.

The demo uses direct signing and current Ledger Agent Stack components. Connecting the device refreshes the pending rebalance; it never authorizes a transaction by itself.

Cloud LLM input and Privy's TEE signing are accepted. Keep application data local and secrets outside chat/Git/logs. Disclose external service and public-chain dependencies accurately.

## Project documents

- [PLAN.md](PLAN.md): minimal scope, delivery sequence and essential checks.
- [Ledger Agent Stack](docs/LEDGER_AGENT_STACK.md), [Robinhood network](docs/NETWORK.md), [Privy assessment](docs/PRIVY.md) and [platform research](docs/RESEARCH.md).
- [Hackathon checklist](docs/HACKATHON.md), [AI provenance](docs/AI_USAGE.md), [direct-signing decision](docs/prompts/008-direct-signing-and-ledger-connect.md) and [Robinhood-only decision](docs/prompts/010-robinhood-only.md).
- [Uniswap feedback](FEEDBACK.md), [Ledger feedback](docs/LEDGER_FEEDBACK.md) and [repository governance](docs/REPOSITORY.md).

Planned partners: **Uniswap, Ledger and Privy**. Integrations and submissions remain pending. Before submission, add reproducible setup, exact code/contract links, actual receipts, dependency attribution and the human-narrated demo.

Read [AGENTS.md](AGENTS.md) before implementation. No install/run/test command exists yet. Original project work uses the [MIT license](LICENSE); third-party materials retain their own licenses.
