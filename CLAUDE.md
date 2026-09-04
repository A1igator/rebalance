# Claude Code project context

Read [AGENTS.md](AGENTS.md), [PLAN.md](PLAN.md) and [docs/HACKATHON.md](docs/HACKATHON.md).

The MVP monitors drift and executes deterministically. Raw-key and Privy modes are automatic under configured policy, with no per-trade human input; Ledger mode waits for physical confirmation. No custom vault/session-key contract is planned. All application interaction goes through the agent; the chart is view only. Never silently change signer/account. Ledger hardware testing waits for the device to arrive.

Keep Robinhood viable and evaluate Base under the user's any-L2 preference. Maximize Ledger Agent Stack reuse and distinguish its narrow CLI quote guard from its broader EVM configuration/execution. Read [the Ledger assessment](docs/LEDGER_AGENT_STACK.md) and [network decision](docs/NETWORK.md). Keep routine execution independent of models and policy validation shared across signers.

Cloud LLM input and Privy's TEE trust model are accepted. Keys and API secrets remain outside model prompts. Preserve hackathon history and commit material prompts/plans plus accurate [AI/reuse disclosures](docs/AI_USAGE.md).
