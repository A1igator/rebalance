# Rebalance — MVP plan

Created: **2026-09-04**. Track: **ETHOnline 2026, Start from Scratch**. Status: the local application, raw-key graph, five-asset adapter, chart and optional Claude notification channel are implemented. Live read-only checks pass; funded swap receipts, Privy and Ledger execution remain pending.

The [implementation clarifications](docs/prompts/012-agent-graph-rwas-notifications.md) specify one existing agent conversation, a project startup/control skill, an explicit graph, **USDG + four RWAs**, and optional `/rc` notifications. The current demo assets are USDG, AAPL, NVDA, MSFT and AMD; native ETH is gas-only. See [README](README.md) for runnable commands and [RWA evidence](docs/RWA_CHECK.md). The user-requested local wallet exists. The [current demo allocation](docs/DEMO_PORTFOLIO.md), following the [technology and name-recognition decisions](docs/prompts/014-positive-impact-demo.md), is **USDG 5%, with AAPL, NVDA, MSFT and AMD 23.75% each**. The technology focus supersedes the initial solar/healthcare theme for the demo; this is not an audited ethical or anti-monopoly certification. Mainnet funding is confirmed; the raw-key monitor remains unarmed and no app trade has been submitted.

The [direct-signing decision](docs/prompts/008-direct-signing-and-ledger-connect.md) removes the session-key feasibility work. Raw-key/Privy swaps are automatic; Ledger tracks drift and prompts to rebalance when connected. The [simplification decision](docs/prompts/006-minimal-mvp.md) still excludes spending caps and budget accounting while retaining sponsor-specific features. Earlier discussions remain in Git as history. Cloud LLM input and Privy's TEE signing are accepted. Physical Ledger testing waits for the device to arrive.

Robinhood **mainnet (4663)** remains the selected network. The [latest decision](docs/prompts/017-mainnet-cadence-codex.md) accepts the measured mainnet fees and cancels the conditional testnet migration in [prompt 016](docs/prompts/016-fees-and-testnet.md). The user requests less frequent rebalancing and Codex remote access. Default cycle starts are one hour apart, with a fixed ten-minute window for sequential legs and the existing five-percentage-point drift trigger. [Fee and testnet evidence](docs/FEE_CHECK.md) stays in the record; the wallet, assets, weights and dependencies remain unchanged.

## 1. What we are building

The [hook trust diagnosis](docs/prompts/021-hook-trust-handoff.md) confirms that the installed CLI discovers the launch hook but marks it untrusted. Native user review is the remaining activation setup; application code must report handled failures clearly, and actual Desktop dispatch remains a separate validation step.

The [deterministic launch wiring](docs/prompts/020-deterministic-launch-hook.md) moves repeatable startup into a typed launcher. A user-reviewed Codex prompt hook recognizes a bare `$rebalance`, dispatches directly to that code, and supplies public results to the conversation without asking an LLM to choose startup commands. Hook trust and native notification/Remote setup remain user/host responsibilities. Preparing and testing the wiring does not establish live activation, desktop event compatibility or a funded trade.

The [single-skill launch correction](docs/prompts/019-single-skill-arming.md) supersedes the assistant's setup-only interpretation in [prompt 018](docs/prompts/018-skill-initialization.md). A user-issued bare `$rebalance` or `/rebalance` requests setup and arming together, with no separate arming message. The agent prepares dependencies/wallet/targets, refreshes state, reuses/opens the chart and requested notifications, then starts or reuses the deterministic runner where its execution permissions allow. Narrow setup-only/status/event requests do only that operation. The current assistant cannot activate real-money trading; report this as an incomplete launch, not as a product requirement for a separate user start. Preserve pending records and cycle timing, and verify actual runner state rather than a spawn acknowledgement.

A local portfolio rebalancer with one Claude Code/Codex conversation as its only application command interface and a **view-only pie chart**, with no header, footer or other sections. The [UI simplification](docs/prompts/015-pie-only-ui.md) keeps ticker/percentage labels within the chart; empty-wallet targets are explicitly distinguished from current holdings. Ask the agent to change AAPL from 20% to 30%; deterministic code updates the complete allocation and handles subsequent rebalancing. A repository skill starts and controls the local monitor; no embedded chat is needed.

| Signer | Rebalancing behavior |
| --- | --- |
| Local raw private key | Automatically sign and execute when drift exceeds the threshold |
| Privy | Automatically sign through Privy and execute when drift exceeds the threshold |
| Ledger | Track drift while disconnected; on connection, refresh the rebalance and prompt through the agent for physical device confirmation |

Automatic modes need no per-trade human input and no LLM calls. They work with the coding agent closed. **There are no per-trade, daily or cumulative spending caps or budget counters.** Trade size comes from the target allocation and available balance. Keep sponsor-specific authorization features, such as supported Privy contract/method restrictions, without monetary limits or a new human-approval requirement.

The user configures the wallet, signer, assets, target weights, drift threshold, polling interval and interval between rebalance cycles through the agent. The network is Robinhood mainnet, chain ID 4663. Use ordinary swap settings for slippage and transaction expiry. Changing targets applies on the next evaluation; report the resulting complete allocation without adding another approval workflow. Target edits and restarts do not reset the persisted cycle interval.

## 2. Smallest useful implementation

Use one TypeScript project with a few modules, not a package monorepo:

| Module | Purpose |
| --- | --- |
| Config and planner | Local settings, integer allocation arithmetic, valuation, drift and corrective trade |
| Network and Uniswap | Read balances/prices, obtain a route, build the required approval/swap and read receipts |
| Signers | Local key, Privy and Ledger implementations of the same signing interface |
| CLI and loop | Configure, status, start/stop, monitor Ledger connection, notify/request signing and open the chart |
| Chart | Bundled local pie chart and current execution status; no editing or signing controls |

Keep ordinary config, a small pending-transaction record and cycle timestamps on disk. A database, generic policy engine and bespoke control/authentication protocol are unnecessary for the shared app. Ledger Key Ring and Privy authorization remain focused integration modules for their prize demos. The agent invokes the local CLI; serve only chart/read data on loopback. Keep signing and mutation out of the chart.

The [execution graph](docs/AGENT_GRAPH.md) links agent target-setting to deterministic observation, planning, execution and independent receipt reconciliation through local state. A small optional MCP channel delivers retained meaningful events into the same Claude session. `/rc` can expose it on a phone; Claude chooses mobile push delivery. For Codex, use native Remote for the existing conversation and a native five-minute current-chat heartbeat that only checks retained events. These are notification paths outside trading, with no signing or permission-relay tools and no custom Codex bridge. Trading runs without either agent. See [notification setup and limits](docs/NOTIFICATIONS.md).

Use one active wallet/profile on the selected Robinhood network, one Uniswap integration and a small fixed asset set for the demo. No session keys, delegation modules, custom custody vault, generalized routing, multi-wallet orchestration or plugin framework. Maximize compatibility with current Ledger Agent Stack components for the demo.

## 3. Deterministic loop

1. Load the latest config and check any pending transaction before starting another operation.
2. Read balances and usable prices for the configured assets. Use correct decimals and integer base units; weights total 10,000 basis points. Missing/stale prices or an unavailable route produce no trade.
3. Calculate allocation drift. If it exceeds the configured threshold, compute one corrective swap through the quote asset. Ledger mode can do this from its saved public address while disconnected; retain a needs-rebalance status until the device connects. For partial target edits, proportionally redistribute the other weights with deterministic rounding.
4. Apply the persisted cycle interval before preparing new execution. By default a new cycle can start once an hour; its fixed ten-minute active window allows sequential approval/swap legs after each receipt resolves. Window expiry stops new dispatches, while pending receipts still reconcile. Restarts and target edits do not extend the window or reset the next eligible start.
5. Build the transaction for Robinhood chain ID 4663 using its token addresses, wallet recipient and Uniswap router. Check available balance and enough native currency for estimated gas. Keep the route's slippage/minimum-output and expiry settings, bounded by the active window. Skip zero-sized trades.
6. Before each dispatch, save a minimal pending marker with the selected chain/account and nonce or available provider request identifier. Persist cycle timing before its first dispatch. Execute automatically with local-key/Privy, or wait for Ledger device confirmation. Make required token approvals for the swap amount through the same signer; do not build an allowance-management product.
7. Update the pending record with the returned transaction/provider identifier and wait for its receipt. Refresh balances before calculating another trade, including a buy dependent on earlier sale proceeds.

Keep one pending operation at a time. Its pre-dispatch marker and subsequent transaction/provider identifier allow restart reconciliation. If a send may have succeeded but its identifier was not recorded, stop new execution with unresolved status rather than sending again. On Ledger rejection, keep monitoring but dismiss the signing request until a new connection or explicit agent request; do not reopen it every poll. The persisted cadence limits cycle frequency; it is not a gas budget or a one-transaction-per-hour guarantee. No automatic replacement, blind retry or escalation framework is needed.

For Ledger, a connection event, startup with the device already attached, or new excessive drift while connected triggers a fresh check. First reconcile pending sends, then reload config/balances and recalculate drift. If a rebalance is still needed, prepare a fresh quote and queue one actionable prompt through the agent. Clear the request if drift has resolved. If the agent is unavailable, keep the request pending for its next interaction; notification delivery must use the actual agent integration, with no LLM calls in monitoring.

Hardware detection is distinct from readiness to sign: check the Ethereum app/device state and selected account before requesting the signature. Connecting never authorizes a swap. Do not retain an old unsigned transaction as ready to execute after reconnect; refresh it. A disconnection after submission still requires receipt reconciliation, including any approval already sent.

If config changes while a Ledger request is pending, rebuild from current config before asking for a signature. Device approval applies to the transaction actually being signed. Stop prevents new work; it does not undo a broadcast transaction. Reconcile already accepted provider requests before resuming.

These are the mechanics needed to produce the intended swap, not a separate security or spending-policy system. Keep keys/API secrets in ignored local configuration or the selected provider's credential mechanism, outside chat, source control and logs. Use the selected signer/account explicitly; no silent backend fallback.

## 4. Reuse Ledger Agent Stack

Prioritize existing Ledger tools over custom equivalents. Adopt the official DMK skills and reuse native transport, Ethereum signing, device lifecycle and applicable Uniswap swap components. Pin versions/source/licenses when actually adopting them. Read the [source assessment](docs/LEDGER_AGENT_STACK.md).

Shared Ledger EVM configuration includes Robinhood mainnet. The inspected CLI quote command has a narrower currency guard than its execution path, so validate the packaged Robinhood flow. Its execute command requotes; verify the actual amount, recipient and normal swap settings used by our integration.

Ledger signing still requires a real device confirmation. Software and Privy signing do not count as Ledger evidence. Test disconnected monitoring, connection/readiness detection, a single fresh rebalance prompt, signing/rejection and meaningful display after the device arrives. Reuse does not require an LLM in the monitor loop. Use the current device-confirmed flow; no roadmap session/delegation capability is required.

Retain **Key Ring and a small credential broker** for Ledger prize value: protect a credential actually used by the app, expose the needed service operation without returning the secret, and demonstrate an allowed request plus a denied unrelated request. Use endpoint/method scopes; no spending budgets are needed. Ring supplies encryption, while the broker supplies the operation restriction. Implement only the isolation needed for the specific claim and describe its actual limits. Do not build a generalized secret-management platform. Device enrollment waits for arrival.

Ledger evidence should show device signing/rejection, useful Agent Stack reuse, the working Ring flow and actual tooling feedback. Disclose any external service or telemetry used by adopted components.

## 5. Privy prize integration

Use a real Privy TEE wallet to execute automatic swaps through the same deterministic loop. Retain Privy-native scoped authorization and supported contract/method restrictions where they demonstrate useful integration. Show a permitted swap and rejection of an unrelated operation if those controls support it; verify the exact SDK/API semantics before claiming enforcement. No spend caps, budget counters or per-swap human approval are added.

Keep this inside the Privy integration rather than a generic cross-signer permissions engine. The application still works in raw-key or Ledger mode independently. See [PRIVY.md](docs/PRIVY.md) for prize requirements and evidence.

## 6. Network and assets

The implemented integration and current demo use **Robinhood mainnet (4663)**. The user accepted its measured fees in [prompt 017](docs/prompts/017-mainnet-cadence-codex.md), canceling the conditional testnet migration. Historical testnet observations remain in [NETWORK.md](docs/NETWORK.md) and [FEE_CHECK.md](docs/FEE_CHECK.md); they do not establish stock support and are not an active implementation path. No demo-issued stock tokens, new test pools or alternative chain are selected.

The first live milestone is a **user-started automatic raw-key Uniswap rebalance on Robinhood mainnet, receipts and chart update**. The current five assets are **USDG, AAPL, NVDA, MSFT and AMD**. All four stock/USDG routes passed mainnet bidirectional sample quote checks, with canonical metadata and corporate-action reads preserved in [the original RWA check](docs/RWA_CHECK.md) and [current demo evidence](docs/DEMO_PORTFOLIO.md). The small verified manifest also retains TSLA, AMZN, RUN and MRNA for existing configurations; each portfolio selects USDG plus four stocks. WETH is excluded from the portfolio. Local fixtures/forks are development tests; no mock-stock or test-pool demo substitutes for a live receipt.

Actual stock swaps require usable Uniswap liquidity and correct Robinhood token/price behavior. Runtime values actual ERC20 units with fresh DEX quotes in USDG and blocks activity for advisory corporate-action oraclePaused flags. It does not apply share multipliers again or claim independent share-price/market-hours verification. Feed research remains a later option. Technical ERC20 compatibility does not establish user eligibility under the issuer's rules. Use Robinhood's own semantics without a generalized asset-validation framework.

Use a clearly labelled Robinhood RPC mode initially. A compatible existing local node/client can follow the working swap; reviewed Helios documentation does not establish Robinhood/Nitro support, and no custom light-client development is in the MVP. The local app and accepted cloud LLM/Privy services have distinct trust boundaries. Public chain activity and issuer/chain assumptions remain. A local wallet has been created and funded; the app has not submitted an approval or swap.

## 7. Delivery sequence and evidence

Dates are 2026, America/Toronto. The [hackathon checklist](docs/HACKATHON.md) remains authoritative for event rules and submission requirements.

| When | Deliverable |
| --- | --- |
| Sep 4 | Commit the simplified plan, prompts and research; preserve owner-bypass main protection |
| Sep 5 | Pin reusable components, verify Robinhood mainnet assets/router/route and implement config/planner |
| Sep 6 | Validate persisted cadence, then collect a user-started raw-key mainnet swap receipt and chart update |
| Sep 7 | Working drift loop and basic pending-transaction recovery; first check-in before 23:59 |
| After device arrival, Sep 8 target | Ledger connect-triggered rebalance prompt, signing/display/rejection and focused Key Ring broker demo; delivery date is not assumed |
| Sep 9 | Real automatic Privy swap and supported scoped-authorization demo through the same loop |
| Sep 10 | Complete the core demo and essential integration checks; second check-in before 23:59 |
| Sep 11–12 | Actual sponsor feedback, setup/code/receipt links and human-narrated demo |
| Sep 13 before noon | Owner submits the completed entry |

Acceptance covers correct integer allocation/trade calculation; actual automatic raw-key and Privy swaps on Robinhood mainnet without model calls; Ledger drift tracking while disconnected, a fresh prompt on connection and actual signing/confirmation or rejection on that same network; correct route/amount/slippage settings; persisted cadence and no duplicate send after restart; and a chart that only displays information. Add focused evidence for Ledger Ring credential handling and Privy's supported authorization restrictions. Use local tests for correctness and actual receipts labeled with their network and asset provenance for integration evidence, without building a generic security-testing platform.

Planned partners remain **Uniswap, Ledger and Privy**. Show substantive integrations, preserve dependency attribution, complete required feedback and record only evidence actually obtained. See [Privy](docs/PRIVY.md), [Ledger feedback](docs/LEDGER_FEEDBACK.md), [Uniswap feedback](FEEDBACK.md) and [AI provenance](docs/AI_USAGE.md).
