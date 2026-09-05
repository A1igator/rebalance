# Agent interface, five RWAs and notifications — 2026-09-04

Exact additional human requests during implementation:

> does it look like arming a monitor in claude code?

> let's do pure usdg and RWAs. WETH is boring

> and like 5 assets not 2

> can we also use /rc and notifications to tell ledger users it's time for a rebalance and everyone else that a rebalance was done

These refine the ongoing authorized implementation. The prior graph/article/single-session/skill requests are preserved in [011](011-implementation-start.md). Five assets means USDG plus four real Robinhood stock tokens; ETH pays gas outside the pie. The previous WETH/USDG spike remains historical evidence, but WETH is removed from the live allocation and wrapping is removed from the app interface. Targets have not been chosen by the assistant. The user-requested wallet is local and unarmed.

## Material implementation specifications and delegated work

The root agent delegated the following bounded tasks while implementing the CLI, graph, notifications and documentation. These are the implementation instructions that materially changed the work; routine status messages and tool output are not reproduced.

- **Storage:** implement private atomic JSON writes with bigint serialization, file/directory sync, missing-only null reads, an exclusive process lock with stale-PID handling and ownership-aware release, and a minimal pending transaction type. Test cross-process exclusion, corrupt records and complete writes. No database or generic infrastructure.
- **Initial chain adapter:** use viem 2.56.3 and verified Robinhood manifest; block-pin fresh reads, check chain/assets/contracts, quote actual integer input across available standard v3 fees, make exact approvals only if necessary, use SwapRouter02's seven-field exactInputSingle inside deadline-enforcing multicall. Requote after approvals and before swapping. Expose expiry to final dispatch checks. Read-only verification only; no signer/funding/broadcast.
- **Five-asset correction:** replace the initial WETH pair with USDG plus TSLA, AAPL, NVDA and AMZN, subject to official canonical metadata and live route verification. Check stock/USDG factory pools, liquidity and bidirectional quotes. Save public evidence and failures. Stock valuation uses actual ERC20-to-USDG quotes; do not apply a share multiplier twice. Check advisory oraclePaused during corporate actions. Do not invent a market calendar, oracle/uptime guarantee, fake asset or alternate-chain fallback.
- **Stock-semantics research:** independently verify official token/feed/corporate-action semantics, wallet transfer versus direct issuer mint/burn requirements, market closure behavior and applicable issuer restrictions. Distinguish canonical metadata, a quotable pool and actual sender execution evidence. Retain independent feed research for later rather than adding a new runtime price dependency.
- **Wallet and dispatch review:** use only temporary test wallets; never inspect the user's key. Verify repeated/concurrent wallet creation, environment override versus file identity, metadata recovery and private file modes. Test durable transaction hash before dispatch, exact signed fields, wrong key/chain/nonce refusal, uncertain outcomes, two-confirmation receipt reconciliation, reverts/reorgs and stop/expiry before signing/broadcast. Remove only records proved unsent within the current process; preserve barriers once dispatch was attempted.
- **Single-session skill and graph:** create a concise canonical project skill for the existing Codex/Claude conversation, with typed CLI operations and user-selected targets. No extra chat or model loop. Share the canonical skill via repository-local Codex/Claude directories. Document intent/config, observation/planning, execution and receipt/recovery feedback as an explicit graph with shared local state.
- **Notification addition:** build an optional same-session Claude MCP channel solely for meaningful retained events, using official channel/Remote Control documentation. Keep command/signing control in the CLI. No HTTP ingress or permission relay. Distinguish Ledger drift attention from confirmed, within-threshold completion. Deduplicate, preserve offline events and acknowledge session handling without claiming phone delivery. Document Claude's channel opt-in and user-managed mobile setup. Do not start a new Claude conversation or change global settings on the user's behalf.
- **Notification tests:** use an actual local MCP client/stdio handshake against the server in temporary directories; verify event delivery, the acknowledgement-only tool, absent signing capability, persistence, deduplication and restart replay. No Claude/mobile account or live notification service.
- **Lifecycle review:** independently exercise background start/stop timing, real runner status, cached snapshots and changed target display, and completion notifications after receipt reconciliation. Use isolated public-wallet fixtures, mocked/blocked RPC and no actual signing. Fix concrete regressions and persist the tests.
- **Independent skill forward test:** use the skill for the realistic request, “Show status, change TSLA from 20% to 30% while proportionally adjusting the rest, and keep the monitor stopped.” Use the actual CLI in an isolated directory with a public fixture wallet and no key/RPC. Confirm complete weights and no runner/send. This exposed stale status after a target edit, which the lifecycle work addresses.

## Root decisions

One TypeScript app; no additional agent orchestration service. The graph's recurring nodes are ordinary deterministic functions. Claude's optional event channel can trigger a conversational response and mobile notification, but cannot influence routine trading unless the human changes configuration through the normal agent command path. Keys, local wallet state and notification history stay outside Git. No actual asset funding, stock purchase, approval, swap, Privy operation, Ledger signing or phone push was performed in this session.
