---
name: rebalance
description: "Operate the local Rebalance app from a Codex or Claude Code conversation: configure user-selected allocations, inspect holdings, start or stop deterministic rebalancing, and open the read-only chart. Use for portfolio operation, not generic repository development."
---

# Rebalance

Use the existing conversation as the app's interactive interface. Translate the user's intent into the local CLI, report public results, and let the local process perform recurring work. Core operation uses the CLI without MCP. An optional MCP channel delivers notifications into the same running Claude Code session; it does not participate in trading.

## Start with local state

Run commands from the Rebalance repository. If dependencies are missing, install the repository's locked dependencies with `npm ci`. Inspect `npm run cli -- status` before making changes; retain the existing wallet and configuration. Use `npm run cli -- graph` when execution or recovery needs explanation.

Use only public wallet metadata and CLI status. Never read, print, copy, or inspect private-key files, secret environment values, seed phrases, or credentials. `wallet create` handles key generation locally and returns the public address. Do not replace an existing wallet to resolve an error.

The initial live signer is `private-key` on Robinhood mainnet, chain ID 4663. Privy and Ledger are deferred adapters; do not present them as working signing options. The portfolio has five assets: USDG, TSLA, AAPL, NVDA, and AMZN. Use the app's verified asset manifest and public status; do not substitute similarly named tokens or assume a listed asset has an executable route. Native ETH is reserved for gas and is excluded from the pie and target weights.

## Translate the requested operation

| User intent | CLI |
| --- | --- |
| Show wallet, configuration, holdings, or operation state | `npm run cli -- status` |
| Create a local wallet | `npm run cli -- wallet create` |
| Set the complete allocation | `npm run cli -- configure --targets USDG=20,TSLA=20,AAPL=20,NVDA=20,AMZN=20` |
| Change one existing target | `npm run cli -- targets set USDG 30` |
| Inspect current holdings and preview the deterministic plan | `npm run cli -- check` |
| Start automatic local rebalancing | `npm run cli -- start --background` |
| Stop scheduling rebalances | `npm run cli -- stop` |
| Start the local read-only chart | `npm run cli -- chart --background` |
| Inspect the graph's state and recent path | `npm run cli -- graph` |
| Inspect persisted notification events | `npm run cli -- events` |
| Acknowledge a handled event | `npm run cli -- events ack ID` |

The numbers above are syntax examples, not recommendations or authorized allocations. Substitute the user's percentages for all five symbols. Never invent investment weights; replace `ID` with an actual event ID. If the user has not supplied targets and none are saved, finish independent setup and ask for the desired five-asset split before configuring. Targets must total 100%; the CLI accepts percentages with up to two decimal places and stores integer basis points.

For a one-target change, the CLI proportionally redistributes the remainder among the other configured assets. Report the resulting full allocation. If the prior targets cannot be redistributed, request a complete split instead of guessing.

An explicit request to start automatic rebalancing authorizes the local runner's subsequent swaps under the saved configuration. Start it, inspect its reported state, and let it continue without asking the LLM or user to approve each trade. A target edit while the runner is active affects subsequent plans. A request to inspect or configure alone does not start recurring execution. Stopping the runner stops future scheduling; it does not cancel an already broadcast transaction.

Do not automatically convert native ETH into portfolio holdings. It remains the wallet's gas asset. Report a transaction as confirmed only after a receipt is observed.

## Report observations accurately

Use `check` to inspect a plan without submitting a swap. After an authorized change or start, use `status` or `graph` to report the configuration, public wallet, runner status, and any pending operation. Open the chart at the local URL reported by `chart` when the user asks to view it. The chart is informational; all configuration and execution requests stay in this conversation.

Valuations are USDG equivalents derived from fresh onchain DEX quotes, not a USD price oracle. These token quotes already price the actual ERC-20 amount; do not multiply them by the issuer's share multiplier. DEX prices may differ from underlying stock prices, including when stock markets are closed. Chain state and receipts currently come from RPC. Describe this as RPC mode, not consensus-verified or completely trustless operation. The local raw-key runner can keep working after this conversation closes while its process and computer remain running.

Stock-token quantities are ERC-20 token units, not necessarily equivalent underlying shares. Issuer dividend and split adjustments can change that relationship. Preserve the app's corporate-action oracle-pause and route errors; an unavailable price is not zero holdings, and a missing quote does not establish that wallet KYC is required. Do not bypass an unavailable route or `oraclePaused()` guard to complete a rebalance, or invent an underlying-market calendar rule for this DEX-quote strategy.

If a transaction is pending, uncertain, or unresolved, preserve its records and transaction identity. Use status and the built-in receipt/recovery path; never delete pending state, blindly retry a send, create a fresh nonce, or start a second runner to force progress. A missing receipt is not proof of failure. Report what remains unresolved and the public transaction hash when available.

For the state flow, receipt feedback, and trust boundaries, read [the graph design](../../docs/AGENT_GRAPH.md).

## Optional phone notifications in the same session

When the user requests phone updates, use the project's `rebalance-events` notification channel. For a Claude Code session started with that project server configured, the startup command is:

```sh
claude --dangerously-load-development-channels server:rebalance-events --remote-control
```

To preserve a previous conversation when restarting, add `--continue` or resume the chosen session. `/rc` enables Remote Control within an existing Claude Code conversation. The user accepts Claude's project/channel consent prompts themselves; do not alter global configuration or bypass consent. This development-channel flag is separate from skipping tool permissions. [Claude CLI flags](https://code.claude.com/docs/en/cli-usage), [channels](https://code.claude.com/docs/en/channels).

Phone push requires Claude Code 2.1.110 or later, the Claude mobile app signed into the same account and organization, OS notification permission, active Remote Control, and `/config` → `Push when Claude decides`. Claude chooses whether to push, so do not guarantee one push per event or claim delivery based on a local acknowledgement. [Remote Control notifications](https://code.claude.com/docs/en/remote-control).

Use public events to report that Ledger device confirmation is needed when that adapter is available, or that an automatic rebalance completed after receipt confirmation. A notification never authorizes signing. The channel has no signing or permission-relay tools. Acknowledge a handled event through its acknowledgement tool or the CLI command above; preserve unresolved events for later delivery. If the session/channel is closed, the local trading process continues independently and events remain available through `events` when the agent returns.
