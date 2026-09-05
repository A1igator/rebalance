# Claude Code project context

Read [AGENTS.md](AGENTS.md), [PLAN.md](PLAN.md) and [docs/HACKATHON.md](docs/HACKATHON.md).

Build the smallest working rebalancer: one TypeScript app, local config, deterministic loop, three signer implementations and a view-only local chart. Raw-key/Privy swaps run automatically without human or LLM input. Ledger tracks drift while disconnected, refreshes on connection and prompts through the agent to rebalance with physical confirmation. Connection alone never authorizes signing. All app commands go through the agent.

No session keys, delegation modules, spending caps, budget counters, generic policy engine or custom custody vault. Keep Ledger Key Ring/credential-broker and Privy-native scoped authorization features for their prize demos, with focused allowed/denied-operation evidence and no monetary limits. Maximize current Ledger Agent Stack compatibility through direct signing. Keep basic correct swap arithmetic, slippage, balance/gas and pending-transaction handling. Keep secrets out of chat/Git/logs.

Reuse applicable Ledger Agent Stack components; defer hardware testing/enrollment until arrival. Robinhood remains viable, with Base as an alternative. Cloud LLM input and Privy's TEE are accepted. Preserve hackathon history and [AI/provenance records](docs/AI_USAGE.md).
