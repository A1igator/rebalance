# Rebalance

A local portfolio rebalancer for **ETHOnline 2026 — Start from Scratch**.

Ask Claude Code/Codex to propose a target change, such as “change ETH from 20% to 30%.” All application requests and reviews go through the agent; the local pie chart is view only. Choose local raw-private-key, Ledger or Privy signing. The agent presents the complete allocation and starts the selected authorization flow: explicit confirmation through the agent for software/Privy management operations, or confirmation on the Ledger device. A deterministic local engine then monitors drift and rebalances through Uniswap without invoking an LLM.

Cloud LLM assistance for proposals is accepted for this hackathon; a local model is not required.

**Status: planning only.** This repository starts from an empty Git history on September 4, 2026, after the published hacking start. There is no implemented application, deployed project contract, or completed integration yet.

**Next milestone:** deterministic allocation proposals, a real local raw-key signer, Robinhood/Uniswap simulation and the view-only chart. Physical Ledger integration is deferred until the owner's device arrives. Software signing is a supported mode that requires no Ledger; isolated simulation approvals remain separate from real authorization.

## Intended MVP

- View-only local pie chart showing current and target weights, proposal previews, status, and execution history; no editors or action buttons.
- Integer arithmetic and explicit policy rules for valuation, drift, trades, limits, and recovery.
- Agent as the sole application control interface for setup, changes, reviews, authorization requests, pause/resume, revocation and withdrawal; private keys stay in the local signer.
- Explicit raw-private-key or Ledger owner signing, sharing policy validation and bounded delegation to a separate local session key. Software mode trusts the authenticated agent/local host; Ledger adds physical confirmation.
- Optional Privy mode with TEE-backed wallet signing and a constrained executor; the owner accepts its service/TEE trust assumptions. Local calculation, scheduling and storage are shared across modes.
- Robinhood Chain integration and direct Uniswap execution, demonstrated first with test assets or a clearly labelled local fork.
- Local storage and no application telemetry or hosted backend.

“Completely trustless” is the design ambition, **not a present guarantee**. Robinhood's stock issuers and rollup governance remain trust assumptions; transactions are public; cloud coding assistants receive prompts sent to them. A supported Robinhood light client has not been established. The plan makes these boundaries explicit rather than treating ordinary RPC access as verification.

## Project documents

- [PLAN.md](PLAN.md): product, architecture, deterministic behavior, milestones, tests, and acceptance gates.
- [Hackathon compliance](docs/HACKATHON.md): deadlines, provenance, prize requirements, and submission checklist.
- [Research and trust limits](docs/RESEARCH.md): primary sources and unresolved integration questions.
- [AI assistance and dependency provenance](docs/AI_USAGE.md), including [initial planning prompts](docs/prompts/001-planning-session.md).
- [Uniswap feedback](FEEDBACK.md) and [Ledger feedback](docs/LEDGER_FEEDBACK.md): evidence templates to complete during implementation.
- [Repository governance](docs/REPOSITORY.md): public personal repository and owner bypass for `main`.

Planned prize targets: **Uniswap — Best Uniswap Stack Contribution**, **Ledger — AI Agents x Ledger**, and **Privy — Best financial flow**. Privy's TEE-based signing is accepted for its optional mode; local raw-key and Ledger modes remain available. See [the prize assessment](docs/PRIVY.md). All integrations and prize submissions are still pending.

## Judge evidence — pending implementation

Before submission, replace this section with exact commit-pinned links and line numbers for the Uniswap integration, project contracts, Ledger authorization path, deterministic planner, and tests. Include deployment chain IDs/addresses, transaction evidence, setup instructions, and the human-narrated demo. No integration or device behavior is claimed as verified yet.

## Development

Read [AGENTS.md](AGENTS.md) before contributing. The repository is currently documentation only; there is no install, run, or test command yet. Add reproducible commands and pinned dependency lockfiles with the first implementation milestone.

License: [MIT](LICENSE) for original project work. Third-party dependencies retain their own licenses and must be attributed.
