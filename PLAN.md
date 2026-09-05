# Rebalance — MVP plan

Created: **2026-09-04**. Track: **ETHOnline 2026, Start from Scratch**. Status: planning only; no application code or project deployment exists yet.

The [latest decision](docs/prompts/008-direct-signing-and-ledger-connect.md) returns to direct signing and removes the session-key feasibility work. Raw-key/Privy swaps are automatic; Ledger tracks drift and prompts to rebalance when connected. The [simplification decision](docs/prompts/006-minimal-mvp.md) still excludes spending caps and budget accounting while retaining sponsor-specific features. Earlier discussions remain in Git as history. Cloud LLM input and Privy's TEE signing are accepted. Physical Ledger testing waits for the device to arrive.

The [mainnet decision](docs/prompts/009-mainnet-only.md) makes all live integration, deployments and demo transactions mainnet-only. Robinhood mainnet (4663) is the first target; Base mainnet (8453) is the alternative. Local tests remain development checks, with no testnet milestone.

## 1. What we are building

A local portfolio rebalancer with Claude Code/Codex as its only application command interface and a **view-only pie chart**. Ask the agent to change ETH from 20% to 30%; deterministic code updates the complete allocation and handles subsequent rebalancing.

| Signer | Rebalancing behavior |
| --- | --- |
| Local raw private key | Automatically sign and execute when drift exceeds the threshold |
| Privy | Automatically sign through Privy and execute when drift exceeds the threshold |
| Ledger | Track drift while disconnected; on connection, refresh the rebalance and prompt through the agent for physical device confirmation |

Automatic modes need no per-trade human input and no LLM calls. They work with the coding agent closed. **There are no per-trade, daily or cumulative spending caps or budget counters.** Trade size comes from the target allocation and available balance. Keep sponsor-specific authorization features, such as supported Privy contract/method restrictions, without monetary limits or a new human-approval requirement.

The user configures the wallet, signer, network, assets, target weights, drift threshold and polling interval through the agent. Use ordinary swap settings for slippage and transaction expiry. Changing targets applies on the next evaluation; report the resulting complete allocation without adding another approval workflow.

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

Use one active wallet/profile, one selected chain, one Uniswap integration and a small fixed asset set for the demo. No session keys, delegation modules, custom custody vault, generalized routing, multi-wallet orchestration or plugin framework. Maximize compatibility with current Ledger Agent Stack components for the demo.

## 3. Deterministic loop

1. Load the latest config and check any pending transaction before starting another operation.
2. Read balances and usable prices for the configured assets. Use correct decimals and integer base units; weights total 10,000 basis points. Missing/stale prices or an unavailable route produce no trade.
3. Calculate allocation drift. If it exceeds the configured threshold, compute one corrective swap through the quote asset. Ledger mode can do this from its saved public address while disconnected; retain a needs-rebalance status until the device connects. For partial target edits, proportionally redistribute the other weights with deterministic rounding.
4. Build the transaction using the selected chain, token addresses, wallet recipient and Uniswap router. Check available balance and enough native currency for estimated gas. Keep the route's slippage/minimum-output and expiry settings. Skip zero-sized trades.
5. Before each dispatch, save a minimal pending marker with the selected chain/account and nonce or available provider request identifier. Execute automatically with local-key/Privy, or wait for Ledger device confirmation. Make required token approvals for the swap amount through the same signer; do not build an allowance-management product.
6. Update the pending record with the returned transaction/provider identifier and wait for its receipt. Refresh balances before calculating another trade, including a buy dependent on earlier sale proceeds.

Keep one pending operation at a time. Its pre-dispatch marker and subsequent transaction/provider identifier allow restart reconciliation. If a send may have succeeded but its identifier was not recorded, stop new execution with unresolved status rather than sending again. On Ledger rejection, keep monitoring but dismiss the signing request until a new connection or explicit agent request; do not reopen it every poll. No automatic replacement, retry, cooldown or escalation framework is needed.

For Ledger, a connection event, startup with the device already attached, or new excessive drift while connected triggers a fresh check. First reconcile pending sends, then reload config/balances and recalculate drift. If a rebalance is still needed, prepare a fresh quote and queue one actionable prompt through the agent. Clear the request if drift has resolved. If the agent is unavailable, keep the request pending for its next interaction; notification delivery must use the actual agent integration, with no LLM calls in monitoring.

Hardware detection is distinct from readiness to sign: check the Ethereum app/device state and selected account before requesting the signature. Connecting never authorizes a swap. Do not retain an old unsigned transaction as ready to execute after reconnect; refresh it. A disconnection after submission still requires receipt reconciliation, including any approval already sent.

If config changes while a Ledger request is pending, rebuild from current config before asking for a signature. Device approval applies to the transaction actually being signed. Stop prevents new work; it does not undo a broadcast transaction. Reconcile already accepted provider requests before resuming.

These are the mechanics needed to produce the intended swap, not a separate security or spending-policy system. Keep keys/API secrets in ignored local configuration or the selected provider's credential mechanism, outside chat, source control and logs. Use the selected signer/account explicitly; no silent backend fallback.

## 4. Reuse Ledger Agent Stack

Prioritize existing Ledger tools over custom equivalents. Adopt the official DMK skills and reuse native transport, Ethereum signing, device lifecycle and applicable Uniswap swap components. Pin versions/source/licenses when actually adopting them. Read the [source assessment](docs/LEDGER_AGENT_STACK.md).

Shared Ledger EVM configuration includes Robinhood mainnet/testnet and Base. The inspected CLI quote command has a narrower currency guard than its execution path, so validate the packaged flow rather than rejecting Robinhood. Its execute command requotes; verify the actual amount, recipient and normal swap settings used by our integration.

Ledger signing still requires a real device confirmation. Software and Privy signing do not count as Ledger evidence. Test disconnected monitoring, connection/readiness detection, a single fresh rebalance prompt, signing/rejection and meaningful display after the device arrives. Reuse does not require an LLM in the monitor loop. Use the current device-confirmed flow; no roadmap session/delegation capability is required.

Retain **Key Ring and a small credential broker** for Ledger prize value: protect a credential actually used by the app, expose the needed service operation without returning the secret, and demonstrate an allowed request plus a denied unrelated request. Use endpoint/method scopes; no spending budgets are needed. Ring supplies encryption, while the broker supplies the operation restriction. Implement only the isolation needed for the specific claim and describe its actual limits. Do not build a generalized secret-management platform. Device enrollment waits for arrival.

Ledger evidence should show device signing/rejection, useful Agent Stack reuse, the working Ring flow and actual tooling feedback. Disclose any external service or telemetry used by adopted components.

## 5. Privy prize integration

Use a real Privy TEE wallet to execute automatic swaps through the same deterministic loop. Retain Privy-native scoped authorization and supported contract/method restrictions where they demonstrate useful integration. Show a permitted swap and rejection of an unrelated operation if those controls support it; verify the exact SDK/API semantics before claiming enforcement. No spend caps, budget counters or per-swap human approval are added.

Keep this inside the Privy integration rather than a generic cross-signer permissions engine. The application still works in raw-key or Ledger mode independently. See [PRIVY.md](docs/PRIVY.md) for prize requirements and evidence.

## 6. Network and assets

Use Robinhood mainnet (4663) first, with Base mainnet (8453) as the alternative under the user's any-L2 preference. Verify a usable existing Uniswap route and Ledger integration on the selected mainnet. All broadcasts and project deployments target mainnet; do not switch to a testnet when an integration is unavailable. Keep the detailed evidence in [NETWORK.md](docs/NETWORK.md).

The first milestone is an **actual automatic raw-key mainnet Uniswap swap, receipt and chart update**. Local fixtures/forks are development tests. Start with two or three supported live assets and a quote asset, using canonical token identities and an executable route. ETH/USDC is a candidate to verify. Do not deploy mock-stock tokens or test pools as a substitute for the live demo.

Actual stock swaps require usable Uniswap liquidity and correct token/price behavior. Base's B20 stocks use native precompiles; validate canonical identities and documented semantics rather than requiring ordinary token bytecode. Handle stock feed pauses/trading hours and corporate-action multipliers correctly. These facts are documented in the network research; do not add a generalized asset-validation framework.

Use a clearly labelled RPC mode initially. A compatible existing local node/light client can follow the working swap; no custom light-client development is in the MVP. The local app and accepted cloud LLM/Privy services have distinct trust boundaries. Public chain activity and issuer/oracle/chain assumptions remain. The repository is still planning-only; no mainnet transaction or wallet setup has occurred yet.

## 7. Delivery sequence and evidence

Dates are 2026, America/Toronto. The [hackathon checklist](docs/HACKATHON.md) remains authoritative for event rules and submission requirements.

| When | Deliverable |
| --- | --- |
| Sep 4 | Commit the simplified plan, prompts and research; preserve owner-bypass main protection |
| Sep 5 | Pin reusable components, verify the selected mainnet/assets/route and implement config/planner |
| Sep 6 | Automatic raw-key mainnet swap with receipt; agent CLI and view-only chart |
| Sep 7 | Working drift loop and basic pending-transaction recovery; first check-in before 23:59 |
| After device arrival, Sep 8 target | Ledger connect-triggered rebalance prompt, signing/display/rejection and focused Key Ring broker demo; delivery date is not assumed |
| Sep 9 | Real automatic Privy swap and supported scoped-authorization demo through the same loop |
| Sep 10 | Complete the core demo and essential integration checks; second check-in before 23:59 |
| Sep 11–12 | Actual sponsor feedback, setup/code/receipt links and human-narrated demo |
| Sep 13 before noon | Owner submits the completed entry |

Acceptance covers correct integer allocation/trade calculation; actual automatic raw-key and Privy mainnet swaps without model calls; Ledger drift tracking while disconnected, a fresh prompt on connection and actual mainnet signing/confirmation or rejection; correct route/amount/slippage settings; no duplicate send after restart; and a chart that only displays information. Add focused evidence for Ledger Ring credential handling and Privy's supported authorization restrictions. Use local tests for correctness and actual mainnet receipts for live integration evidence, without building a generic security-testing platform.

Planned partners remain **Uniswap, Ledger and Privy**. Show substantive integrations, preserve dependency attribution, complete required feedback and record only evidence actually obtained. See [Privy](docs/PRIVY.md), [Ledger feedback](docs/LEDGER_FEEDBACK.md), [Uniswap feedback](FEEDBACK.md) and [AI provenance](docs/AI_USAGE.md).
