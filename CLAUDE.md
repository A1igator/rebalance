# Claude Code project context

Read [AGENTS.md](AGENTS.md), [PLAN.md](PLAN.md) and [docs/HACKATHON.md](docs/HACKATHON.md).

Build the smallest working rebalancer: one TypeScript app, local config, deterministic loop, three signer implementations and a view-only local chart. Raw-key/Privy swaps run automatically without human or LLM input. Ledger tracks drift while disconnected, refreshes on connection and prompts through the agent to rebalance with physical confirmation. Connection alone never authorizes signing. All app commands go through the agent.

No session keys, delegation modules, spending caps, budget counters, generic policy engine or custom custody vault. Keep Ledger Key Ring/credential-broker and Privy-native scoped authorization features for their prize demos, with focused allowed/denied-operation evidence and no monetary limits. Maximize current Ledger Agent Stack compatibility through direct signing. Keep basic correct swap arithmetic, slippage, balance/gas and pending-transaction handling. Keep secrets out of chat/Git/logs.

Reuse applicable Ledger Agent Stack components; defer hardware testing/enrollment until arrival. Robinhood mainnet (4663) is the sole target for live integration/deployments/demo. No alternative chain, testnet or mock-stock demo milestone; keep local correctness tests. Use Robinhood's own token/price semantics. Cloud LLM input and Privy's TEE are accepted. Preserve hackathon history and [AI/provenance records](docs/AI_USAGE.md).

Operational entrypoint: use the project `rebalance` skill in this same conversation. The current fixed allocation assets are USDG, TSLA, AAPL, NVDA and AMZN; native ETH is gas-only. User weights are required before arming. `npm run cli -- status`, `graph` and `events` return public local state. The optional `rebalance-events` MCP channel only reports retained notifications and acknowledges session handling. `/rc` phone use needs the user's Claude setup; no live mobile delivery or Ledger/Privy execution is claimed. See `docs/NOTIFICATIONS.md`.
