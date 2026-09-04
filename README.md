# Rebalance

A local, agent-controlled portfolio rebalancer for **ETHOnline 2026 — Start from Scratch**.

Ask Claude Code/Codex to change a target, such as “change ETH from 20% to 30%.” A deterministic local daemon detects drift and executes corrective swaps automatically in local-key or Privy mode. Ledger mode asks for physical confirmation. The local pie chart is view only.

**Status: planning only.** No application, signer integration or project deployment exists yet. The repository began with an empty history after the published hacking start on September 4, 2026.

## Current MVP

- Automatic local raw-key and Privy execution under configured limits, without per-trade human input. Ledger signing requires device confirmation.
- Deterministic allocation, valuation, drift detection, trade planning and execution. Routine automation needs no LLM calls and works with the coding agent closed.
- All application controls through the agent; no buttons, editor, wallet connection or signing access in the chart.
- **Robinhood remains viable; Base is an alternative.** Ledger's shared EVM configuration includes both. Base has live Coinbase tokenized stocks; executable stock routes on Uniswap remain a verification gate on either target.
- Reuse **Ledger Agent Stack**: official skills, DMK/Ethereum signing and applicable swap components; evaluate Key Ring for a scoped credential broker. The CLI's quote command has narrower chain coverage than its EVM execution path; verify the pinned version end to end.
- Direct wallet transactions; no custom custody vault or session-key contract in the MVP. Local software enforces automatic-mode limits, with verified Privy controls where available.

**Next milestone:** pin reusable Ledger components, validate/select the network and Uniswap route, then implement an automatic raw-key swap with an actual testnet receipt. Base Sepolia is a documented Uniswap testnet candidate; Robinhood is not ruled out by the CLI quote restriction. Local fixtures/forks remain tests. Physical Ledger work waits for the device to arrive; Privy follows through the shared signing interface.

Cloud LLM input and Privy's TEE signing are accepted for the hackathon. Local raw-key/Ledger modes remain available independently. Onchain activity is public, and issuer/oracle/chain/service assumptions are documented rather than described as eliminated.

## Project documents

- [PLAN.md](PLAN.md): signer-specific execution modes, implementation sequence and acceptance checks.
- [Ledger Agent Stack](docs/LEDGER_AGENT_STACK.md): reusable components, source-verified CLI limits and prize rationale.
- [Network choice](docs/NETWORK.md): Robinhood/Base, tokenized stocks, Uniswap and light-client evidence.
- [Hackathon checklist](docs/HACKATHON.md), [Privy assessment](docs/PRIVY.md), and [earlier platform research](docs/RESEARCH.md).
- [AI assistance/provenance](docs/AI_USAGE.md), including [latest user/task prompts](docs/prompts/005-ledger-stack-and-execution-modes.md).
- [Uniswap feedback](FEEDBACK.md), [Ledger feedback](docs/LEDGER_FEEDBACK.md), and [repository governance](docs/REPOSITORY.md).

Planned partner targets: **Uniswap — Best Uniswap Stack Contribution**, **Ledger — AI Agents x Ledger**, and **Privy — Best financial flow**. All integrations and submissions remain pending.

## Judge evidence and development

Before submission, add reproducible setup commands, exact commit-pinned code lines, dependency licenses, network/contract identities, actual transaction receipts and the human-narrated demo. Clearly distinguish physical Ledger tests, software signatures, Privy operations and local simulations.

Read [AGENTS.md](AGENTS.md) before implementation. No install/run/test command exists yet. Original project work uses the [MIT license](LICENSE); third-party materials retain their own licenses.
