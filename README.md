# Rebalance

A local portfolio rebalancer controlled from **one Codex or Claude Code conversation**, with a view-only pie chart. Built from scratch during **ETHOnline 2026**.

The current demo is **USDG 5%, with Apple (AAPL), Nvidia (NVDA), Microsoft (MSFT) and AMD at 23.75% each**, currently implemented on **Robinhood mainnet (4663)**. The latest user decision prioritizes recognizable technology companies; [selection rationale and route evidence](docs/DEMO_PORTFOLIO.md) describe its limits. Native ETH pays gas and stays outside the allocation.

Ask the agent to change a target. Integer arithmetic redistributes the other weights, and an explicit execution graph observes holdings, plans one corrective swap, signs, and checks its receipt. Once armed, the raw-key monitor runs with the agent closed and makes no LLM calls. There are no session keys, spending caps or budget counters.

**Implemented:** deterministic core, five-asset Uniswap v3 adapter, local raw-key signing, durable pending-transaction recovery, agent CLI/skill, read-only chart and an optional Claude notification channel. Live read-only routes and snapshots passed; **no funded approval/swap receipt has been produced yet**. Privy execution, Ledger hardware signing/connection handling and Key Ring remain subsequent milestones. Selecting those modes never falls back to a software signer.

The [fee decision](docs/prompts/017-mainnet-cadence-codex.md) accepts the measured mainnet fees and cancels the conditional testnet migration. The funded demo retains its network, wallet and allocation; its monitor remains unarmed in recorded checks. [Earlier fee and testnet research](docs/FEE_CHECK.md) is preserved as history.

## Use through your agent

Open this repository in Codex or Claude Code and invoke the project **Rebalance skill**: `$rebalance` in Codex or `/rebalance` in Claude Code. The [single-call launch](docs/prompts/019-single-skill-arming.md) requests setup **and arming automatic trading** under your saved allocation. It installs missing locked dependencies, reuses/creates the appropriate wallet, preserves or collects your allocation, refreshes public state, reuses/opens the view-only chart and requested notifications, then starts or reuses the deterministic runner. No separate arming message is part of this workflow. Repeated launches preserve wallet/configuration, cycle timing and pending transactions. Scoped setup-only, status, event and stop requests perform only their named operation. Its canonical source is [SKILL.md](skills/rebalance/SKILL.md), shared by the project skill directories.

The executing agent must be allowed to perform the requested actions. The current assistant cannot activate real-money stock-token trading, so it can prepare this workflow but cannot complete the funded launch here. The skill must report that restriction and the actual runner state, which remains unarmed in current checks. An already active runner is reused; setup or a background spawn acknowledgement alone is not successful arming.

For contributors and reproducible verification, the underlying commands are:

```sh
npm ci
npm run typecheck
npm test
npm run cli -- wallet create
npm run cli -- status
```

`wallet create` prints only the public address and preserves an existing wallet. Its key is stored in ignored `.local/private-key`, with owner-only file permissions. A teammate can instead provision that file or `REBALANCE_PRIVATE_KEY` locally. Never paste private bytes into the agent, command arguments or Git.

Supply all five target percentages. This is a syntax example, **not a selected allocation**:

```sh
npm run cli -- configure --targets USDG=20,AAPL=20,NVDA=20,MSFT=20,AMD=20
npm run cli -- targets set AAPL 30
npm run cli -- check
npm run cli -- chart --background
npm run cli -- start --background
npm run cli -- stop
```

`check` reads/plans/quotes without signing. `start` arms automatic raw-key execution under the saved targets; no per-swap agent or human confirmation is required. Fund the selected Robinhood wallet with the actual portfolio tokens and native ETH for gas before a live run. Defaults are 5 percentage points of drift, one hour between rebalance cycle starts, 0.5% swap slippage, 120-second expiry and 30-second polling. Each cycle has a fixed ten-minute active window for sequential approval/swap legs; expiry is bounded by that window. Receipt reconciliation runs first, even between cycles. Cycle timing survives restarts and target edits, so polling does not cause a fresh rebalance every 30 seconds. This limits frequency without introducing a spending cap or promising one transaction per hour.

Partial target edits proportionally redistribute the remaining weights. Select USDG and four stocks from the [verified manifest](src/assets.ts); only those five enter monitoring and valuation. Replacing symbols changes the tracked allocation and does not automatically liquidate tokens removed from it. Our demo wallet was empty when its selection changed.

The UI is one pie chart with ticker/percentage labels, with no header, footer or dashboard sections. It shows current holdings when funded, otherwise explicitly labeled saved targets. Operation details stay in the agent conversation. The chart is at [127.0.0.1:4663](http://127.0.0.1:4663). It contains no editing, wallet-connect or signing controls. `status`, `graph` and `events` are the agent's read interfaces. `stop` prevents new work; an already submitted transaction still settles.

## Graph and notifications

[The graph design](docs/AGENT_GRAPH.md) connects agent intent, local configuration, observation, deterministic planning, execution and independent receipt reconciliation. Signed transaction hashes are saved before dispatch. Unknown outcomes block later sends until reconciled; no blind resend occurs. One process owns execution at a time.

The optional [notification channel](docs/NOTIFICATIONS.md) feeds retained events into the **same running Claude session**. With `/rc`, that session can be used from a phone. Ledger drift alerts and completed-rebalance alerts are distinct; completion requires a confirmed swap and a fresh portfolio within the drift threshold. Phone pushes are Claude-controlled and require user setup. The channel neither signs nor relays permissions. Trading remains independent of it.

For Codex, use [native Remote](https://learn.chatgpt.com/docs/remote-connections) to continue the existing conversation from the mobile app. A native [current-chat scheduled task](https://learn.chatgpt.com/docs/automations), configured as a five-minute heartbeat, checks retained events only and reports meaningful new events. It does not trade or create a custom Codex app-server/MCP bridge. The desktop host must remain available; mobile pairing and notification delivery depend on the user's setup and are not yet verified. See the same notification guide for setup and retained-event handling.

## What the evidence establishes

- [Current demo](docs/DEMO_PORTFOLIO.md): recognizable technology names, full Robinhood catalog snapshot and additional MSFT/AMD route checks.
- [Original RWA route check](docs/RWA_CHECK.md): canonical assets, actual Uniswap pools, bidirectional quotes, metadata, raw public RPC evidence and remaining funded-sender checks.
- [Implementation](src/chain.ts): direct Uniswap QuoterV2, exact token approvals and SwapRouter02 deadline multicalls. [Execution](src/transactions.ts) and [graph](src/graph.ts) contain dispatch/recovery behavior.
- Values are **DEX estimates in USDG**, not independent USD share-price oracles. Actual token units are quoted without applying corporate-action multipliers twice. Advisory `oraclePaused()` blocks new activity during relevant corporate actions. DEX and underlying stock-market prices can differ.
- Current chain verification is **RPC mode**, not a light client or fully trustless operation. Issuer, chain and RPC dependencies remain. Token compatibility does not establish user eligibility or direct ownership of shares; see the official access details linked in the RWA report.
- The app bundles its UI locally and has no application telemetry or cloud LLM dependency. Optional Claude or Codex notifications share selected events with the configured agent session.

## Hackathon record

[Plan](PLAN.md) · [Rules/check-ins](docs/HACKATHON.md) · [AI and dependency provenance](docs/AI_USAGE.md) · [Ledger Stack](docs/LEDGER_AGENT_STACK.md) · [Privy](docs/PRIVY.md) · [Uniswap feedback](FEEDBACK.md) · [Ledger feedback](docs/LEDGER_FEEDBACK.md)

Planned partners: **Uniswap, Ledger and Privy**. Source/spec/prompt history is preserved on `main`; actual hardware, Privy, receipt, phone-delivery and submission evidence remain to be collected. Read [AGENTS.md](AGENTS.md) before development. Original work is [MIT licensed](LICENSE); dependencies retain their licenses.
