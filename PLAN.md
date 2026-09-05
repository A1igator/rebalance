# Rebalance — MVP plan

Created: **2026-09-04**. Track: **ETHOnline 2026, Start from Scratch**. Status: the local application, raw-key graph, five-asset adapter, chart and optional Claude notification channel are implemented. Live read-only checks pass; funded swap receipts, Privy and Ledger execution remain pending.

The [implementation clarifications](docs/prompts/012-agent-graph-rwas-notifications.md) specify one existing agent conversation, a project startup/control skill, an explicit graph, **USDG + four RWAs**, and optional `/rc` notifications. The current demo assets are USDG, AAPL, NVDA, MSFT and AMD; native ETH is gas-only. See [README](README.md) for runnable commands and [RWA evidence](docs/RWA_CHECK.md). The user-requested local wallet exists. The [current demo allocation](docs/DEMO_PORTFOLIO.md), following the [technology and name-recognition decisions](docs/prompts/014-positive-impact-demo.md), is **USDG 5%, with AAPL, NVDA, MSFT and AMD 23.75% each**. The technology focus supersedes the initial solar/healthcare theme for the demo; this is not an audited ethical or anti-monopoly certification. Mainnet funding is confirmed; trading remains unarmed while the fee/network decision below is resolved.

The [latest decision](docs/prompts/008-direct-signing-and-ledger-connect.md) returns to direct signing and removes the session-key feasibility work. Raw-key/Privy swaps are automatic; Ledger tracks drift and prompts to rebalance when connected. The [simplification decision](docs/prompts/006-minimal-mvp.md) still excludes spending caps and budget accounting while retaining sponsor-specific features. Earlier discussions remain in Git as history. Cloud LLM input and Privy's TEE signing are accepted. Physical Ledger testing waits for the device to arrive.

Robinhood remains the sole chain family. The [latest fee instruction](docs/prompts/016-fees-and-testnet.md) authorizes switching to **Robinhood testnet (46630)** before the full demo if mainnet fees exceed roughly one US cent. The [measured fees](docs/FEE_CHECK.md) exceed that target. Current code and assets still target mainnet (4663); testnet migration is pending because the exact stock assets and routes are unverified. Keep execution stopped while resolving that gap. The earlier mainnet-only preference is superseded to this extent; no alternative chain or undisclosed mock-stock substitution is selected.

## 1. What we are building

A local portfolio rebalancer with one Claude Code/Codex conversation as its only application command interface and a **view-only pie chart**, with no header, footer or other sections. The [UI simplification](docs/prompts/015-pie-only-ui.md) keeps ticker/percentage labels within the chart; empty-wallet targets are explicitly distinguished from current holdings. Ask the agent to change AAPL from 20% to 30%; deterministic code updates the complete allocation and handles subsequent rebalancing. A repository skill starts and controls the local monitor; no embedded chat is needed.

| Signer | Rebalancing behavior |
| --- | --- |
| Local raw private key | Automatically sign and execute when drift exceeds the threshold |
| Privy | Automatically sign through Privy and execute when drift exceeds the threshold |
| Ledger | Track drift while disconnected; on connection, refresh the rebalance and prompt through the agent for physical device confirmation |

Automatic modes need no per-trade human input and no LLM calls. They work with the coding agent closed. **There are no per-trade, daily or cumulative spending caps or budget counters.** Trade size comes from the target allocation and available balance. Keep sponsor-specific authorization features, such as supported Privy contract/method restrictions, without monetary limits or a new human-approval requirement.

The user configures the wallet, signer, assets, target weights, drift threshold and polling interval through the agent. Current implementation fixes the network to Robinhood mainnet, chain ID 4663; changing an RPC URL alone cannot implement the pending testnet migration. Use ordinary swap settings for slippage and transaction expiry. Changing targets applies on the next evaluation; report the resulting complete allocation without adding another approval workflow.

## 2. Smallest useful implementation

Use one TypeScript project with a few modules, not a package monorepo:

| Module | Purpose |
| --- | --- |
| Config and planner | Local settings, integer allocation arithmetic, valuation, drift and corrective trade |
| Network and Uniswap | Read balances/prices, obtain a route, build the required approval/swap and read receipts |
| Signers | Local key, Privy and Ledger implementations of the same signing interface |
| CLI and loop | Configure, status, start/stop, monitor Ledger connection, notify/request signing and open the chart |
| Chart | Bundled local pie chart and current execution status; no editing or signing controls |

Keep ordinary config and a small pending-transaction record on disk. A database, generic policy engine and bespoke control/authentication protocol are unnecessary for the shared app. Ledger Key Ring and Privy authorization remain focused integration modules for their prize demos. The agent invokes the local CLI; serve only chart/read data on loopback. Keep signing and mutation out of the chart.

The [execution graph](docs/AGENT_GRAPH.md) links agent target-setting to deterministic observation, planning, execution and independent receipt reconciliation through local state. A small optional MCP channel delivers retained meaningful events into the same Claude session. `/rc` can expose it on a phone; Claude chooses mobile push delivery. The notification channel has no signing or permission-relay tools, and trading runs without it. See [notification setup and limits](docs/NOTIFICATIONS.md).

Use one active wallet/profile on the selected Robinhood network, one Uniswap integration and a small fixed asset set for the demo. No session keys, delegation modules, custom custody vault, generalized routing, multi-wallet orchestration or plugin framework. Maximize compatibility with current Ledger Agent Stack components for the demo.

## 3. Deterministic loop

1. Load the latest config and check any pending transaction before starting another operation.
2. Read balances and usable prices for the configured assets. Use correct decimals and integer base units; weights total 10,000 basis points. Missing/stale prices or an unavailable route produce no trade.
3. Calculate allocation drift. If it exceeds the configured threshold, compute one corrective swap through the quote asset. Ledger mode can do this from its saved public address while disconnected; retain a needs-rebalance status until the device connects. For partial target edits, proportionally redistribute the other weights with deterministic rounding.
4. Build the transaction for Robinhood chain ID 4663 using its token addresses, wallet recipient and Uniswap router. Check available balance and enough native currency for estimated gas. Keep the route's slippage/minimum-output and expiry settings. Skip zero-sized trades.
5. Before each dispatch, save a minimal pending marker with the selected chain/account and nonce or available provider request identifier. Execute automatically with local-key/Privy, or wait for Ledger device confirmation. Make required token approvals for the swap amount through the same signer; do not build an allowance-management product.
6. Update the pending record with the returned transaction/provider identifier and wait for its receipt. Refresh balances before calculating another trade, including a buy dependent on earlier sale proceeds.

Keep one pending operation at a time. Its pre-dispatch marker and subsequent transaction/provider identifier allow restart reconciliation. If a send may have succeeded but its identifier was not recorded, stop new execution with unresolved status rather than sending again. On Ledger rejection, keep monitoring but dismiss the signing request until a new connection or explicit agent request; do not reopen it every poll. No automatic replacement, retry, cooldown or escalation framework is needed.

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

The implemented integration uses **Robinhood mainnet (4663)**. The fee-triggered move to **Robinhood testnet (46630)** is authorized but not implemented: canonical test USDG and a candidate DEX deployment were observed, while the four stock addresses and usable routes remain unverified. Resolve the asset/liquidity gap before changing runtime manifests. Demo-issued stock tokens and new pools would change the previous no-mock scope and have been offered as an explicit choice, not silently adopted. Keep detailed evidence in [NETWORK.md](docs/NETWORK.md) and [FEE_CHECK.md](docs/FEE_CHECK.md).

The first live milestone is an **actual automatic raw-key Uniswap rebalance on the resolved Robinhood network, receipts and chart update**. The current five assets are **USDG, AAPL, NVDA, MSFT and AMD**. All four stock/USDG routes passed mainnet bidirectional sample quote checks, with canonical metadata and corporate-action reads preserved in [the original RWA check](docs/RWA_CHECK.md) and [current demo evidence](docs/DEMO_PORTFOLIO.md). The small verified manifest also retains TSLA, AMZN, RUN and MRNA for existing configurations; each portfolio selects USDG plus four stocks. WETH is excluded from the portfolio. Local fixtures/forks are development tests; no mock-stock or test-pool demo substitutes for a live receipt.

Actual stock swaps require usable Uniswap liquidity and correct Robinhood token/price behavior. Runtime values actual ERC20 units with fresh DEX quotes in USDG and blocks activity for advisory corporate-action oraclePaused flags. It does not apply share multipliers again or claim independent share-price/market-hours verification. Feed research remains a later option. Technical ERC20 compatibility does not establish user eligibility under the issuer's rules. Use Robinhood's own semantics without a generalized asset-validation framework.

Use a clearly labelled Robinhood RPC mode initially. A compatible existing local node/client can follow the working swap; reviewed Helios documentation does not establish Robinhood/Nitro support, and no custom light-client development is in the MVP. The local app and accepted cloud LLM/Privy services have distinct trust boundaries. Public chain activity and issuer/chain assumptions remain. A local wallet has been created and funded; the app has not submitted an approval or swap.

## 7. Delivery sequence and evidence

Dates are 2026, America/Toronto. The [hackathon checklist](docs/HACKATHON.md) remains authoritative for event rules and submission requirements.

| When | Deliverable |
| --- | --- |
| Sep 4 | Commit the simplified plan, prompts and research; preserve owner-bypass main protection |
| Sep 5 | Pin reusable components, verify Robinhood mainnet assets/router/route and implement config/planner |
| Sep 6 | Resolve the fee/testnet asset decision, then obtain a raw-key Robinhood swap receipt and chart update |
| Sep 7 | Working drift loop and basic pending-transaction recovery; first check-in before 23:59 |
| After device arrival, Sep 8 target | Ledger connect-triggered rebalance prompt, signing/display/rejection and focused Key Ring broker demo; delivery date is not assumed |
| Sep 9 | Real automatic Privy swap and supported scoped-authorization demo through the same loop |
| Sep 10 | Complete the core demo and essential integration checks; second check-in before 23:59 |
| Sep 11–12 | Actual sponsor feedback, setup/code/receipt links and human-narrated demo |
| Sep 13 before noon | Owner submits the completed entry |

Acceptance covers correct integer allocation/trade calculation; actual automatic raw-key and Privy swaps on the resolved Robinhood network without model calls; Ledger drift tracking while disconnected, a fresh prompt on connection and actual signing/confirmation or rejection on that same network; correct route/amount/slippage settings; no duplicate send after restart; and a chart that only displays information. Add focused evidence for Ledger Ring credential handling and Privy's supported authorization restrictions. Use local tests for correctness and actual receipts labeled with their network and asset provenance for integration evidence, without building a generic security-testing platform.

Planned partners remain **Uniswap, Ledger and Privy**. Show substantive integrations, preserve dependency attribution, complete required feedback and record only evidence actually obtained. See [Privy](docs/PRIVY.md), [Ledger feedback](docs/LEDGER_FEEDBACK.md), [Uniswap feedback](FEEDBACK.md) and [AI provenance](docs/AI_USAGE.md).
