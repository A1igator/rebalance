# Privy prize and architecture assessment

Checked against official sources on **2026-09-04**. The owner subsequently accepted the TEE trust model, making Privy the third planned partner. No Privy dependency, account, wallet, transaction, prize enrollment or integration has been created yet.

## Recommendation

**Yes, Privy has an agent path, and Best financial flow is our planned third prize.** The owner accepts its TEE-based signing dependency. Delivery still requires a meaningful working Privy-backed financial flow in that optional mode. Uniswap and Ledger remain the other planned partners; the event allows at most three partner selections. Adding an adapter alone does not establish eligibility or a competitive entry.

## Prize fit

[ETHOnline 2026 — Privy](https://ethglobal.com/events/ethonline2026/prizes#privy) offers **$2,500 for Best financial flow**. Requirements include Privy as a core product integration, at least one Privy wallet, a functional financial flow using generally available features, working demo/source access, and an explanation of the user benefit. Swaps are explicitly in scope. The published requirements do not demand an interactive graphical UI, an agent framework or a specific feedback filename.

The separate $2,500 B2B prize asks for an organization/business workflow and a Privy control such as policies, signers, quorums or intents. The personal rebalancer fits financial flow more naturally. Do not invent a business use case merely to select a second category.

## Official agent paths

- **Agent CLI:** Privy publishes `@privy-io/agent-wallet-cli` and agent skills. Its documented setup includes browser authorization followed by agent/terminal requests. That browser setup is an interaction mismatch to resolve before choosing this path for the strictly agent-controlled product. [Agent CLI](https://docs.privy.io/recipes/agent-integrations/agent-cli)
- **Headless SDK/REST:** Privy's agentic-wallet documentation supports scoped signing and explicitly describes recurring portfolio rebalancing. A local deterministic scheduler can use an API without invoking an LLM on each run. Prefer assessing this route through the existing narrow local control boundary. [Agentic wallets](https://docs.privy.io/recipes/agent-integrations/agentic-wallets), [signer model](https://docs.privy.io/wallets/using-wallets/signers/overview)
- **Coding assistance:** official MCP/docs and skills support Claude Code/Codex. These help build an integration but are not themselves a qualifying wallet/financial flow. [AI development tooling](https://docs.privy.io/basics/get-started/using-llms)

## Compatibility and tradeoffs

Privy's documented signing architecture performs signing in its enclave through API requests. A local daemon does not make that signer local; the relevant requests leave the machine and signing needs the service. This differs from both the local raw-key backend and Ledger. Keep the user's preferred local paths functional and make any Privy mode explicit. [Signer architecture](https://docs.privy.io/wallets/using-wallets/signers/overview)

The planned `privy` profile reuses the deterministic planner and local config, with Privy wallet authorization and request handling. The user permits automatic swaps without per-trade human input and has [removed spending caps/budget accounting while retaining Privy-specific prize features](prompts/006-minimal-mvp.md). A single Privy wallet suffices for direct swaps; no custom vault or mandatory owner/executor-wallet split is required. The local daemon, rather than an LLM, sizes and dispatches trades.

Keep supported Privy-native contract/method or signer restrictions for a focused allowed/denied-operation demonstration. Verify actual API semantics before claiming enforcement. Do not add monetary caps, usage counters or a generic cross-signer policy engine. The [latest decision](prompts/008-direct-signing-and-ledger-connect.md) removes session keys entirely: Privy signs its own wallet's swaps automatically; it is not a delegated signer over the Ledger wallet.

The view-only chart is compatible. Agent-only user controls are also plausible with SDK/REST, but verify actual provisioning/authentication flows instead of claiming that the existing CLI has no browser step. Developer account setup and wallet ownership/authorization configuration remain unresolved.

The project targets **Robinhood mainnet only (4663)**. Verify its actual Privy wallet signing/submission and authorization behavior. The earlier Robinhood Testnet gas-sponsorship listing does not establish mainnet support or sponsorship. Gas sponsorship is not required for this MVP; use ordinary fee payment when appropriate. Do not switch chains to obtain a provider feature. [Gas network support](https://docs.privy.io/wallets/gas-and-asset-management/gas/overview)

Privy supports private-key import/export, but importing a key places signing in its API-managed model; it does not implement this project's local raw-key backend. Exporting and doing everything locally may weaken the claim that Privy is core. Keep these concepts separate. [Private-key import](https://docs.privy.io/wallets/wallets/import-a-wallet/private-key), [export](https://docs.privy.io/wallets/wallets/export)

## Delivery gates

- [ ] Core raw-key/Uniswap flow and deterministic tests are working.
- [ ] A concrete Privy wallet flow offers user value and executes real supported mainnet operations with receipt evidence.
- [ ] Agent-mediated setup/control, ownership, credentials and network support are verified, with a focused demonstration of supported Privy authorization restrictions and no spending limits.
- [ ] Swaps execute with the coding agent closed and no per-trade human input; a pending transaction/provider-request record prevents duplicate sends.
- [x] Owner accepts Privy's TEE-based hosted signing for the optional mode; local backends remain independent by design.
- [ ] Working source, wallet/transaction evidence and user-benefit explanation meet the prize requirements.
- [x] Plan Privy as the third partner alongside Uniswap/Ledger; defer 1inch and do not exceed the event partner limit. Actual submission is pending.

This is a planned entry, not confirmation of eligibility, submission, acceptance or a win.
