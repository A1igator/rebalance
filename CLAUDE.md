# Claude Code project context

Read [AGENTS.md](AGENTS.md), [PLAN.md](PLAN.md) and [docs/HACKATHON.md](docs/HACKATHON.md).

Build the smallest working rebalancer: one TypeScript app, local config, deterministic loop, three signer implementations and a view-only local chart. Raw-key/Privy swaps run automatically without human or LLM input; Ledger requires physical confirmation. All app commands go through the agent.

No spending caps, budget counters, generic policy engine or custom custody vault. Keep Ledger Key Ring/credential-broker and Privy-native scoped authorization features for their prize demos, with focused allowed/denied-operation evidence and no monetary limits. Assess an existing account/session module for Ledger-authorized autonomy, with expiry/revocation and no monetary/usage counters; direct signing remains the baseline until verified. Keep basic correct swap arithmetic, slippage, balance/gas and pending-transaction handling. Keep secrets out of chat/Git/logs.

Reuse applicable Ledger Agent Stack components; defer hardware testing/enrollment until arrival. Robinhood remains viable, with Base as an alternative. Cloud LLM input and Privy's TEE are accepted. Preserve hackathon history and [AI/provenance records](docs/AI_USAGE.md).
