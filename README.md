# Rebalance

A local portfolio rebalancer controlled from **one Codex or Claude Code conversation**, with a portfolio selector and read-only allocation chart. Built from scratch during **ETHOnline 2026**.

The current demo is **USDG 5%, with Apple (AAPL), Nvidia (NVDA), Microsoft (MSFT) and AMD at 23.75% each**, currently implemented on **Robinhood mainnet (4663)**. The latest user decision prioritizes recognizable technology companies; [selection rationale and route evidence](docs/DEMO_PORTFOLIO.md) describe its limits. Native ETH pays gas and stays outside the allocation.

Ask the agent to change a target. Integer arithmetic redistributes the other weights, and an explicit execution graph observes holdings, plans one corrective swap, signs, and checks its receipt. Once armed, the raw-key monitor runs with the agent closed and makes no LLM calls. There are no session keys, spending caps or budget counters.

**Implemented:** deterministic core, five-asset Uniswap v3 adapter, local raw-key and official Privy CLI signing adapters, durable pending-transaction recovery, agent CLI/skill, read-only chart and an optional Claude notification channel. Live routes and snapshots passed. A user-issued native skill command armed the runner on September 5; the first Apple swap has a verified successful mainnet receipt. After user-issued recovery and relaunch, the app recorded a completed five-asset rebalance on September 5 at 23:33:58 UTC, with a confirmed final swap and fresh holdings within the drift threshold. Privy uses the pinned official agent-wallet CLI for deterministic signing and recovery; its live Robinhood service acceptance and swap remain unverified. Ledger indexed address onboarding, disconnected monitoring and device signing are implemented. An explicit rebalance request enables one bounded cycle, with physical confirmation for every approval and swap. Actual Ledger transaction signing, display/rejection and swap evidence remain unverified; Key Ring remains a subsequent milestone. Signer selection never falls back to a different backend. See [Ledger execution and limits](docs/LEDGER_EXECUTION.md) and [Privy setup and evidence](docs/PRIVY.md).

The [fee decision](docs/prompts/017-mainnet-cadence-codex.md) accepts the measured mainnet fees and cancels the conditional testnet migration. The funded demo retains its network, wallet and allocation; its user-armed monitor completed the first five-asset rebalance after recovery. [Earlier fee and testnet research](docs/FEE_CHECK.md) is preserved as history.

**Wallet portfolios:** each wallet has its own allocation, state and deterministic background runner. In the agent-linked selector, choose a wallet to connect this conversation and open its chart; later selections made through the agent also update the open view. Use **← Portfolios** to return to the grid. **New portfolio** starts deterministic Local key, Privy or Ledger setup directly. On macOS, local accounts share one seed stored in macOS Keychain, with public references in the project; Privy opens its sign-in page when needed; Ledger verifies a new account address on the device. Successful setup adds the portfolio and connects this conversation while its setup dialog remains active. An already-added Privy wallet is identified explicitly and offers **Open existing portfolio** instead of redirecting. Navigation and setup do not arm trading. On a connected portfolio chart, **Start / Stop** at the top right controls that wallet’s deterministic runner. The adjacent public address opens the wallet on the **Robinhood chain 4663** explorer. Start uses saved targets and preserves pending recovery/cadence; Stop prevents new work while submitted transactions still settle. Ledger Start enables monitoring; it does not request a signature. Bare local URLs allow viewing; open through the agent to link the chat or start wallet setup. See [wallet portfolios and commands](docs/PORTFOLIOS.md).

Keep the selector or chart beside the conversation as a [companion view](docs/COMPANION_VIEW.md). Claude Code in an already running cmux workspace can open or reuse a browser split through the command wrapper. Claude Code Desktop uses the host’s available native Browser/Preview tools; automatic pane control is not assumed. If a pane is unavailable, the returned local URL remains usable.

## Use through your agent

Open this repository in Codex or Claude Code and invoke the project **Rebalance skill**: `$rebalance` in Codex or `/rebalance` in Claude Code. The [single-call launch](docs/prompts/019-single-skill-arming.md) requests setup and starts the selected runner: **automatic trading for raw-key/Privy, public monitoring for Ledger** under your saved allocation. Startup is implemented in the deterministic [launcher](src/launch.ts), which preserves configuration, reconciles receipts, reuses/starts the chart and runner, and verifies actual readiness. Scoped setup-only, status, event and stop requests perform only their named operation. The shared [skill](skills/rebalance/SKILL.md) handles user input and reports results.

For Codex, a project **UserPromptSubmit hook** can route bare `$rebalance`, typed or selected through the project's skill suggestion, directly to the launcher without an LLM tool decision. The picker form is an exact Markdown reference to this repository's canonical skill file; the handler also supports the exact observed browser-context framing around that complete request. It installs missing locked dependencies and records the invocation identity so duplicate delivery cannot rearm after a stop. **The user must review and trust the hook first**; no trust or approval settings are changed by this implementation. The documented review interface is `/hooks` in Codex CLI. A subsequent user-issued literal command produced a native hook result with verified arming. Direct and framed input forms also pass isolated tests; that does not establish every native picker/framing path. [Hook setup, matching and limits](docs/LAUNCH.md)

One-time setup: open Codex CLI in the repository, choose **Review hooks**, and trust the **UserPromptSubmit** entry from **`.codex/hooks.json`** that runs **`scripts/rebalance-hook.mjs`**. Use `/hooks` if the startup review screen is absent. The initial native discovery check found this hook correctly loaded but untrusted; a later check confirmed it trusted. Project trust alone is insufficient. Then type `$rebalance` or choose its skill suggestion for normal launch in the existing conversation.

For Claude, the project **UserPromptExpansion hook** routes a bare user-issued **`/rebalance`** directly to the same launcher using native `prompt_id` (Claude 2.1.196+). It is prepared in `.claude/settings.json`; the user accepts any native project/hook consent. Scoped arguments and model-invoked Skill calls do not arm. Isolated tests pass; native Claude dispatch remains to be observed on the next user invocation. [Claude entry contract](docs/LAUNCH.md#claude-deterministic-skill-entry--2026-09-06)

The current assistant prepares/tests the wiring but cannot activate real-money trading or trust the live hook on the user's behalf. Routine pending-state recovery belongs to the user-started deterministic runner, including pending transactions carried into a full raw-key launch. Native Remote pairing remains host setup. The launcher restores configured, enabled event notifications and preserves paused preferences. An armed status is not proof of a completed trade.

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
npm run cli -- launch --setup-only
npm run cli -- launch
npm run cli -- stop
```

`check` reads/plans/quotes without signing. `launch --setup-only` prepares services without starting an inactive runner; full `launch` prepares and starts/reuses automatic raw-key/Privy execution or Ledger monitoring under the saved targets. The low-level `start --background` command remains available. No per-swap agent or human confirmation is required for raw-key/Privy mode. Fund the selected Robinhood wallet with the actual portfolio tokens and native ETH for gas before a live run. Defaults are 5 percentage points of drift, one hour between cycle starts when a swap has succeeded, 0.5% swap slippage, 120-second expiry and a 30-second quiet-feed fallback. Each cycle has a fixed ten-minute active window for sequential approval/swap legs; expiry is bounded by that window. Receipt reconciliation runs first, even between cycles. Cycle timing survives restarts and target edits, so events and fallback checks do not cause a fresh rebalance every 30 seconds. This limits frequency without introducing a spending cap or promising one transaction per hour.

Targets, risk policies and [portfolio settings](docs/LIVE_SETTINGS.md) can be changed through the agent while running. Edits invalidate unbroadcast plans and preserve already-submitted transactions and saved cooldowns; a settings edit never starts a stopped runner.

For Ledger, connect and unlock the device, open Ethereum, then explicitly request a rebalance with `npm run cli -- ledger rebalance --request-id <UUID>` on its running monitor. Use a fresh UUID for that user request and `npm run cli -- ledger status` to inspect it. The runner consumes the request once, refreshes the portfolio and quotes, and asks for physical confirmation of each sequential approval/swap. Rejection, expiry, stop, changed configuration, restart or an uncertain send ends its authority; another cycle needs a new request. Connection, Start and notifications never create that authority. Pending hashes remain receipt barriers, and Ledger cancellation signing is disabled. See [the Ledger workflow](docs/LEDGER_EXECUTION.md), including explicit receipt recovery after a revert.

Partial target edits proportionally redistribute the remaining weights. Select USDG and four stocks from the [verified manifest](src/assets.ts); only those five enter monitoring and valuation. Replacing symbols changes the tracked allocation and does not automatically liquidate tokens removed from it. Our demo wallet was empty when its selection changed.

Each wallet’s allocation chart displays: actual holdings on the outer ring, saved targets on a thin inner ring with matching colors, and ticker/actual/target percentages alongside. Empty wallets show explicitly labeled targets only. The ring center reports current drift/execution status. An animated Settings overlay opens without moving the chart and shows this wallet’s drift trigger, cycle interval and optional rebalance fee target. The top address opens the displayed wallet on the Robinhood explorer. Stock segments and labels open Google stock searches. Hover or focus emphasizes the matching actual/target segments and name together with outward movement; reduced-motion preferences disable movement. Ring separator edges are parallel. Gas prices and estimated fees appear only in the center when the fee target blocks execution. ETH is excluded from allocation slices, weights and portfolio value. Pending receipts and read failures label retained observations as last known holdings. Allocation edits and Ledger signing requests stay in the agent conversation. The default [portfolio grid](http://127.0.0.1:4663/) opens each wallet’s separate `/chart` URL. `status`, `graph` and `events` are the agent's read interfaces. `stop` prevents new work; an already submitted transaction still settles.

Set a wallet-specific estimated network-fee target through the agent: `npm run cli -- --profile <address> fees target 0.05` sets five US cents; `fees status` reads it and `fees clear` removes it. Unset wallets retain their existing behavior. The deterministic graph waits locally when the estimated remaining rebalance exceeds the target or a fresh ETH/USD quote is unavailable. Ledger monitoring checks fees before requesting attention; actual signing still requires its explicit request and device confirmations. See [fee estimation and limits](docs/FEE_TARGET.md).

The execution fee estimate uses a fresh public Coinbase ETH/USD response, the current transaction’s RPC gas estimate and buffered gas price, plus measured gas references for projected remaining swaps/approvals. It does not read the cached display-price endpoint. This adds an explicit external pricing dependency for wallets using fee targets. Estimated network fees are not guaranteed final costs, and do not include swap fees, slippage or recovery cancellations. Native ETH remains required. The unused paymaster experiment was removed under [prompt 068](docs/prompts/068-remove-unused-paymaster.md); no gas-provider account or API-key setup is required. [Provider research](docs/PAYMASTER_ALTERNATIVES.md) remains historical.

An armed raw-key runner automatically handles stale sends after a 30-second receipt grace. It can cancel the original nonce once, then waits for a verified receipt; cancellation/revert can continue the current active window. Hourly cooldown applies to cycles with a successful swap; a new cycle without one may retry after its original ten-minute window. It never blindly retries an uncertain send or asks an LLM to recover. Read-only `recover` and the explicit **`$rebalance recover`** command remain available. A full raw-key launch starts this recovery path through unresolved/reverted state after a successful preflight; no separate recovery or stop/start command is required. Source edits do not hot-reload an active process, and a completed recovery journal does not reload code. See [recovery behavior](docs/RECOVERY.md).

## Graph and notifications

[The graph design](docs/AGENT_GRAPH.md) connects agent intent, local configuration, observation, deterministic planning, execution and independent receipt reconciliation. Signed transaction hashes are saved before dispatch. Unknown outcomes block later sends until reconciled; no blind resend occurs. One process owns execution at a time.

The optional [notification channel](docs/NOTIFICATIONS.md) feeds retained events into the **same running Claude session**. With `/rc`, that session can be used from a phone. Ledger drift, runtime-attention, transaction-recovery and completed-rebalance alerts are distinct; completion requires a confirmed swap and a fresh portfolio within the drift threshold. Phone pushes are Claude-controlled and require user setup. The channel neither signs nor relays permissions. Trading remains independent of it.

Recognized routine portfolio-read and quote-retry alerts without a transaction hash, plus successful automatic recovery events, stay in local history and never escalate to chat with elapsed time. Failures needing agent or human action, Ledger requests and requested completion notifications remain eligible for delivery. This shared filter is deterministic and independent of the trading runner.


For Codex, a file-driven notification worker queues retained events into the same loaded conversation through native shared queue storage without taking over its active writer. Use [native Remote](https://learn.chatgpt.com/docs/remote-connections) for phone access. A native notification test reached this conversation on September 6 and was acknowledged; the five-minute heartbeat was then removed. Codex's own ten-second revision check handles these cross-process additions, as explained in the [notification guide](docs/NOTIFICATIONS.md); no periodic model check is needed. Trading remained unarmed during validation. Phone delivery remains unverified.

## What the evidence establishes

- [Current demo](docs/DEMO_PORTFOLIO.md): recognizable technology names, full Robinhood catalog snapshot and additional MSFT/AMD route checks.
- [Original RWA route check](docs/RWA_CHECK.md): canonical assets, actual Uniswap pools, bidirectional quotes, metadata, raw public RPC evidence and remaining funded-sender checks.
- [Implementation](src/chain.ts): direct Uniswap QuoterV2, exact token approvals and SwapRouter02 deadline multicalls. [Execution](src/transactions.ts) and [graph](src/graph.ts) contain dispatch/recovery behavior.
- Values are **DEX estimates in USDG**, not independent USD share-price oracles. Actual token units are quoted without applying corporate-action multipliers twice. Advisory `oraclePaused()` blocks new activity during relevant corporate actions. DEX and underlying stock-market prices can differ.
- Current chain verification is **RPC mode**, not a light client or fully trustless operation. Issuer, chain and RPC dependencies remain. Token compatibility does not establish user eligibility or direct ownership of shares; see the official access details linked in the RWA report.
- The app bundles its UI locally and has no application telemetry or cloud LLM dependency. Ledger signing uses external metadata/context services; its display and dependency limits are documented in [Ledger execution](docs/LEDGER_EXECUTION.md). Optional Claude or Codex notifications share selected events with the configured agent session.

## Hackathon record

[Plan](PLAN.md) · [Rules/check-ins](docs/HACKATHON.md) · [AI and dependency provenance](docs/AI_USAGE.md) · [Ledger Stack](docs/LEDGER_AGENT_STACK.md) · [Privy](docs/PRIVY.md) · [Uniswap feedback](FEEDBACK.md) · [Ledger feedback](docs/LEDGER_FEEDBACK.md)

Planned partners: **Uniswap, Ledger and Privy**. Source/spec/prompt history is preserved on `main`; actual Ledger transaction, Privy swap, phone-delivery and submission evidence remain to be collected. Read [AGENTS.md](AGENTS.md) before development. Original work is [MIT licensed](LICENSE); dependencies retain their licenses.

The [execution timing guide](docs/EXECUTION_TIMING.md) explains event-driven receipt progression, bounded fallback checks, the 30-second recovery grace, RPC discovery reuse, fee headroom and local chart streaming. Event notification delivery remains separate from trading and native phone notification behavior.
