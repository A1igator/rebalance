# Rebalance — MVP plan

Created: **2026-09-04**. Track: **ETHOnline 2026, Start from Scratch**. Status: planning only; no application code or project deployment exists yet.

The [simplification decision](docs/prompts/006-minimal-mvp.md) removes spending limits and generic security infrastructure while retaining Ledger- and Privy-specific features that strengthen their prize demos. The [subsequent session-key discussion](docs/prompts/007-session-key-reconsideration.md) adds a focused feasibility check without restoring caps or budget accounting. Earlier decisions remain in Git as history. Cloud LLM input and Privy's TEE signing are accepted. Physical Ledger testing waits for the device to arrive.

## 1. What we are building

A local portfolio rebalancer with Claude Code/Codex as its only application command interface and a **view-only pie chart**. Ask the agent to change ETH from 20% to 30%; deterministic code updates the complete allocation and handles subsequent rebalancing.

| Signer | Rebalancing behavior |
| --- | --- |
| Local raw private key | Automatically sign and execute when drift exceeds the threshold |
| Privy | Automatically sign through Privy and execute when drift exceeds the threshold |
| Ledger | Prepare the corrective swap and ask for physical device confirmation |

Automatic modes need no per-trade human input and no LLM calls. They work with the coding agent closed. **There are no per-trade, daily or cumulative spending caps or budget counters.** Trade size comes from the target allocation and available balance. Keep sponsor-specific authorization features, such as supported Privy contract/method restrictions, without monetary limits or a new human-approval requirement.

The user configures the wallet, signer, network, assets, target weights, drift threshold and polling interval through the agent. Use ordinary swap settings for slippage and transaction expiry. Changing targets applies on the next evaluation; report the resulting complete allocation without adding another approval workflow.

## 2. Smallest useful implementation

Use one TypeScript project with a few modules, not a package monorepo:

| Module | Purpose |
| --- | --- |
| Config and planner | Local settings, integer allocation arithmetic, valuation, drift and corrective trade |
| Network and Uniswap | Read balances/prices, obtain a route, build the required approval/swap and read receipts |
| Signers | Local key, Privy and Ledger implementations of the same signing interface |
| CLI and loop | Configure, status, start/stop, request Ledger signing and open the chart |
| Chart | Bundled local pie chart and current execution status; no editing or signing controls |

Keep ordinary config and a small pending-transaction record on disk. A database, generic policy engine and bespoke control/authentication protocol are unnecessary for the shared app. Ledger Key Ring and Privy authorization remain focused integration modules for their prize demos. The agent invokes the local CLI; serve only chart/read data on loopback. Keep signing and mutation out of the chart.

Use one active wallet/profile, one selected chain, one Uniswap integration and a small fixed asset set for the demo. No generalized routing, custom custody vault, multi-wallet orchestration or plugin framework. An existing account/session module is a separate candidate for unattended Ledger-authorized execution, evaluated below.

## 3. Deterministic loop

1. Load the latest config and check any pending transaction before starting another operation.
2. Read balances and usable prices for the configured assets. Use correct decimals and integer base units; weights total 10,000 basis points. Missing/stale prices or an unavailable route produce no trade.
3. Calculate allocation drift. If it exceeds the configured threshold, compute one corrective swap through the quote asset. For partial target edits, proportionally redistribute the other weights with deterministic rounding.
4. Build the transaction using the selected chain, token addresses, wallet recipient and Uniswap router. Check available balance and enough native currency for estimated gas. Keep the route's slippage/minimum-output and expiry settings. Skip zero-sized trades.
5. Before each dispatch, save a minimal pending marker with the selected chain/account and nonce or available provider request identifier. Execute automatically with local-key/Privy, or wait for Ledger device confirmation. Make required token approvals for the swap amount through the same signer; do not build an allowance-management product.
6. Update the pending record with the returned transaction/provider identifier and wait for its receipt. Refresh balances before calculating another trade, including a buy dependent on earlier sale proceeds.

Keep one pending operation at a time. Its pre-dispatch marker and subsequent transaction/provider identifier allow restart reconciliation. If a send may have succeeded but its identifier was not recorded, stop with unresolved status rather than sending again. Stop on an unresolved send error or Ledger rejection and expose the status through the agent/chart. No automatic replacement, retry, cooldown or escalation framework is needed.

If config changes while a Ledger request is pending, rebuild from current config before asking for a signature. Device approval applies to the transaction actually being signed. Stop prevents new work; it does not undo a broadcast transaction. Reconcile already accepted provider requests before resuming.

These are the mechanics needed to produce the intended swap, not a separate security or spending-policy system. Keep keys/API secrets in ignored local configuration or the selected provider's credential mechanism, outside chat, source control and logs. Use the selected signer/account explicitly; no silent backend fallback.

## 4. Reuse Ledger Agent Stack

Prioritize existing Ledger tools over custom equivalents. Adopt the official DMK skills and reuse native transport, Ethereum signing, device lifecycle and applicable Uniswap swap components. Pin versions/source/licenses when actually adopting them. Read the [source assessment](docs/LEDGER_AGENT_STACK.md).

Shared Ledger EVM configuration includes Robinhood mainnet/testnet and Base. The inspected CLI quote command has a narrower currency guard than its execution path, so validate the packaged flow rather than rejecting Robinhood. Its execute command requotes; verify the actual amount, recipient and normal swap settings used by our integration.

Ledger signing still requires a real device confirmation. Software and Privy signing do not count as Ledger evidence. Test signing, rejection and meaningful display after the device arrives. Reuse does not require an LLM in the monitor loop.

Retain **Key Ring and a small credential broker** for Ledger prize value: protect a credential actually used by the app, expose the needed service operation without returning the secret, and demonstrate an allowed request plus a denied unrelated request. Use endpoint/method scopes; no spending budgets are needed. Ring supplies encryption, while the broker supplies the operation restriction. Implement only the isolation needed for the specific claim and describe its actual limits. Do not build a generalized secret-management platform. Device enrollment waits for arrival.

Ledger evidence should show device signing/rejection, useful Agent Stack reuse, the working Ring flow and actual tooling feedback. Disclose any external service or telemetry used by adopted components.

## 5. Privy prize integration

Use a real Privy TEE wallet to execute automatic swaps through the same deterministic loop. Retain Privy-native scoped authorization and supported contract/method restrictions where they demonstrate useful integration. Show a permitted swap and rejection of an unrelated operation if those controls support it; verify the exact SDK/API semantics before claiming enforcement. No spend caps, budget counters or per-swap human approval are added.

Keep this inside the Privy integration rather than a generic cross-signer permissions engine. The application still works in raw-key or Ledger mode independently. See [PRIVY.md](docs/PRIVY.md) for prize requirements and evidence.

## 6. Session keys: focused feasibility check

The user is considering returning to session keys for unattended Ledger-authorized swaps. Our own Ledger signing adapter can support agent-mediated review and device confirmation; session delegation is the additional capability. The baseline above remains the first integration target while this path is checked, rather than rebuilding the earlier vault/budget architecture.

Ledger's [roadmap](https://shop.ledger.com/pages/ledger-agent-stack) labels agent intents, queued approvals and bounded autonomy as coming soon. It does not provide a currently verified session-delegation API. We can demonstrate a compatible account/session integration using Ledger to approve the session, but must attribute the delegation enforcement to that integration.

Use an existing smart-account/session module if it works on the selected chain. A signature over local configuration alone cannot make a second key spend an ordinary EOA's funds. [Ethereum account abstraction](https://ethereum.org/roadmap/account-abstraction) explains the account-logic distinction. [Rhinestone Smart Sessions](https://docs.rhinestone.dev/smart-wallet/smart-sessions/overview) is one candidate with action and timeframe controls independently of spending-limit policies; its SDK support is experimental, and no package, chain compatibility or Ledger flow has been tested here.

The smallest proposed session contains a signer, selected account/chain, permitted rebalance operations and recipient, expiry, and owner revocation. **No spending cap, cumulative counter, usage-count limit or budget reservation.** Verify the actual permitted swap call and recipient; merely allowing a generic router method does not establish swap-only permissions.

The feasibility demo is: owner authorizes the session → its software/Privy-held key performs one automatic Uniswap swap → an unrelated operation is rejected → expiry or revocation stops another execution. Choose one session signer for the spike rather than multiplying modes. Confirm account funding/address, transaction submission and gas dependencies, then test actual Ledger authorization after arrival. Promote this path only with evidence; do not silently change existing wallet ownership.

If adopted, Ledger approves session creation/renewal/revocation; it does not sign each automatic swap. Keep the simple agent/device signing experience and view-only chart. Scope and duration define the session's boundaries; there is no maximum-loss or spending-limit claim. Privy service policies and onchain session permissions remain distinct mechanisms.

## 7. Network and assets

Robinhood remains viable; Base is an alternative under the user's any-L2 preference. Verify the existing integration path and choose one network before implementation depends on it. Base Sepolia is a documented Uniswap testnet candidate. Keep the detailed evidence in [NETWORK.md](docs/NETWORK.md).

The first milestone is an **actual automatic raw-key testnet Uniswap swap, receipt and chart update**. Local fixtures/forks are tests, not the deliverable. Start with two or three supported test assets and a quote asset. Label stock-like test tokens as test tokens; do not claim real equity exposure.

Actual stock swaps require usable Uniswap liquidity and correct token/price behavior. Base's B20 stocks use native precompiles; validate canonical identities and documented semantics rather than requiring ordinary token bytecode. Handle stock feed pauses/trading hours and corporate-action multipliers correctly. These facts are documented in the network research; do not add a generalized asset-validation framework.

Use a clearly labelled RPC mode initially. A compatible existing local node/light client can follow the working swap; no custom light-client development is in the MVP. The local app and accepted cloud LLM/Privy services have distinct trust boundaries. Public chain activity and issuer/oracle/chain assumptions remain. Mainnet trading is outside this planning task.

## 8. Delivery sequence and evidence

Dates are 2026, America/Toronto. The [hackathon checklist](docs/HACKATHON.md) remains authoritative for event rules and submission requirements.

| When | Deliverable |
| --- | --- |
| Sep 4 | Commit the simplified plan, prompts and research; preserve owner-bypass main protection |
| Sep 5 | Pin reusable components, select network/assets/route, implement config/planner and assess one existing session module |
| Sep 6 | Automatic raw-key testnet swap with receipt; agent CLI and view-only chart |
| Sep 7 | Working drift loop and basic pending-transaction recovery; first check-in before 23:59 |
| After device arrival, Sep 8 target | Ledger native signing/display/rejection and focused Key Ring broker demo; delivery date is not assumed |
| Sep 9 | Real automatic Privy swap and supported scoped-authorization demo through the same loop |
| Sep 10 | Complete the core demo and essential integration checks; second check-in before 23:59 |
| Sep 11–12 | Actual sponsor feedback, setup/code/receipt links and human-narrated demo |
| Sep 13 before noon | Owner submits the completed entry |

Acceptance covers correct integer allocation/trade calculation; actual automatic raw-key and Privy swaps without model calls; actual Ledger confirmation/rejection; correct route/amount/slippage settings; no duplicate send after restart; and a chart that only displays information. Add focused evidence for Ledger Ring credential handling and Privy's supported authorization restrictions. Test these behaviors without building a generic security-testing platform.

Planned partners remain **Uniswap, Ledger and Privy**. Show substantive integrations, preserve dependency attribution, complete required feedback and record only evidence actually obtained. See [Privy](docs/PRIVY.md), [Ledger feedback](docs/LEDGER_FEEDBACK.md), [Uniswap feedback](FEEDBACK.md) and [AI provenance](docs/AI_USAGE.md).
