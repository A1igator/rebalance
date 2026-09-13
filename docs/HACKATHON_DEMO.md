# Rebalance hackathon demo and final testing plan

Prepared September 12, 2026. Operator runbook for the final submission. This plan does not execute trades, change the selected network or establish that any remaining test has passed.

Submission deadline: **September 13, 2026, 12:00 EDT / 16:00 UTC**, as rechecked by the coordinating agent against the official event pages. Finish the evidence and recording before the final upload window; September 16 is not the submission deadline.

## Product story and scope

“Describe your allocation in one agent conversation. Rebalance turns it into a local, deterministic portfolio workflow, uses Uniswap to correct drift, and keeps Ledger confirmation at each transaction.”

Lead with the complete user experience: one conversation, a recognizable portfolio, a useful allocation view and an understandable result. Explain Ledger as the device approval boundary and Uniswap as the execution integration. Show the receipt and refreshed holdings that substantiate the outcome. The deterministic runner, rather than repeated model decisions, handles observation, preparation and receipt progression.

The implemented application remains **Robinhood mainnet, chain 4663**, with USDG and four configured stock tokens. Ethereum mainnet testing through standalone Ledger CLI is a separate compatibility experiment. It is not an implemented second application network, a migrated portfolio or a completed app rebalance. Native ETH pays gas. Do not call the stock tokens direct share ownership, the app trustless, or Context Module use proof of Clear Signing.

## Current evidence baseline

| Area | Established | Still required for the stronger demonstration |
| --- | --- | --- |
| Complete application / Uniswap | A five-asset Robinhood rebalance was recorded on September 5; its final successful swap receipt and fresh holdings within the drift threshold were verified. Direct Uniswap v3 quote, approval and swap integration is implemented. | A reproducible current product walkthrough; final source/contract links; updated feedback. Label historical trade evidence by date and signer instead of presenting it as a new live run. |
| Ledger application | Nano Gen5 indexed onboarding; direct DMK/Signer Kit integration; a completed sequential rebalance at **23:25 UTC September 12**, with final swap receipt at block **61493058** and fresh on-target holdings. | A reliable recording, observed device wording, explicit rejection behavior, and a separate live test of the new combined batch. Earlier fallback failures are historical; success does not prove Clear Signing. |
| Ledger compatibility test | Public RPC confirmed USDC and native ETH on Ethereum. Official CLI 2.1.0 discovery succeeded but returned a different first account; it did not reach the intended funded indexed account. | A supported way to select the intended CLI account, a usable fresh quote and any subsequent device/receipt evidence. Funding alone is not quote, signature or swap evidence. Keep this result separate from application support. |
| Privy | Official Agent Sandbox/CLI adapter, public wallet onboarding and isolated transaction validation fixtures. | Current service authorization, actual supported signing and a completed Privy financial flow on the application's chain. Cached public wallet metadata does not establish these. |
| Key Ring | A focused credential-broker direction exists in the plan. | Enrollment, working credential use, demonstrated allowed/denied operation and an accurately described isolation boundary. None is currently implemented. |

The latest [Ledger execution record](LEDGER_EXECUTION.md#verified-sequential-rebalance-batch-validation-pending) establishes successful sequential swaps and portfolio completion. Earlier approval-only and unsupported-attempt notes are historical. The new batch implementation is fixture-tested and must not be presented as the path used by those sequential receipts.

## Immediate Ledger testing sequence

This is an operator runbook. The coordinating agent prepares and reports the read-only results; the owner controls any physical confirmation and authorized financial execution.

1. **Establish account readiness.** With the Ledger unlocked and Ethereum open, perform the already scoped public-account check. Verify the expected address and derivation path, and distinguish USB discovery from a successful account response. Record model, OS, SDK/CLI version and firmware/Ethereum-app versions only when actually observed. Do not treat the unlocked screen as proof the transport works.
2. **Prepare the separate Ethereum mainnet quote only when the correct account is available.** The current published CLI exposes no account-index/path option and discovery can stop at the first unused account. Do not substitute its first discovered address or fabricate a session for the funded indexed account. This is currently blocked, so prioritize the application test instead of repeating discovery. Verify chain 1, the intended public account, canonical token identity, available input and native gas balance. Inspect the fresh quote's input/output, minimum received, spender/router, recipient, expiry and estimated network cost. A quote is a read-only compatibility result; it is not authorization or completed execution. Report an unsupported pair or unavailable quote plainly.
3. **Evaluate the concrete transaction before the owner confirms.** Use the reviewed test amount and intended account. Explain whether an approval is needed and that approval and swap are separate. Record what the actual device displays and whether Transaction Check is available. Do not equate Transaction Check with Clear Signing or enable blind signing as a troubleshooting step.
4. **Validate each authorized outcome independently.** If an approval is submitted, verify its chain, sender, token, spender, amount and successful receipt. If a swap is submitted, verify its sender, recipient, token movements and receipt, then refresh balances. Preserve any pending hash through uncertainty and do not retry an unresolved send. A standalone CLI success proves only that specific CLI/account/chain/transaction path.
5. **Decide the application path from evidence.** If the standalone test succeeds, document what it proves and reassess the exact Robinhood router/multicall display gap. Do not infer a network migration or replace the application flow. If it fails, capture the bounded failure stage and stop speculative retries; the existing verified sequential application rebalance remains the primary demo evidence.
6. **Capture application refusal and recovery behavior.** During a separately authorized app test, explicitly reject a device request, show that no new transaction hash was sent and that repeat prompts stay suspended. Show Stop preventing further preparation, or the wallet/request-bound Retry preparing fresh work after the cause is resolved. Existing receipt barriers and device confirmation remain in force. A cancelled/expired attempt without an observed user rejection must retain that distinction.

Acceptance: a Ledger test is complete only when the record states its account, chain, exact operation, observed device outcome and independent transaction result or confirmed absence of submission. The sequential app milestone of successful swaps plus fresh holdings is established. Live batching, approval-only attempts, standalone CLI checks and fixture tests remain separately labelled outcomes.

## Priorities before recording

**1. Make the complete product clear and dependable.** Rehearse portfolio selection, allocation explanation, current status, receipt evidence and refreshed holdings in one existing conversation with its companion view. Use a stable, already validated path. The judges should understand the problem and benefit before hearing SDK versions. Preserve historical evidence if a new run is not ready; never simulate an outcome as live.

**2. Record the working Ledger flow and validate batching separately.** The sequential rebalance has completed. [Batched application rebalances](BATCHED_REBALANCES.md) reduce a cash-funded four-stock case to one aggregate approval and one swap transaction; mixed holdings use one sales-and-purchases multicall with distinct approvals as needed. Pursue a scoped owner-controlled batch test when ready and label its actual outcome. Public account discovery alone does not resolve the separate device display support gap. The human-approval Ledger direction already uses meaningful official SDK primitives. Adding wallet-cli for its name or building Ring now is lower priority than a convincing transaction, refusal and outcome demonstration. CLI/Ring are necessary only for claims about the specific CLI/Ring directions; neither is a blanket requirement for this chosen SDK human-approval direction. Clear Signing remains an objective to verify, not an invented eligibility condition or an achieved feature.

**3. Finish Uniswap submission evidence.** Update `FEEDBACK.md` from the actual direct-v3 experience, remove stale statements contradicted by confirmed receipts, and link the exact final code and deployed contracts. Have the owner submit the required developer feedback form and retain confirmation. Do not substitute an unsent draft for completion.

**4. Gate the Privy entry on a working flow.** Verify service authorization and a real supported financial transaction through the existing Agent Sandbox adapter. If a complete Privy flow is unavailable, describe it as unverified and reassess the third partner selection. A public wallet, installed CLI or fixture is insufficient. Do not introduce a dashboard/app-secret integration or spend deadline time inventing provider policy claims.

**5. Freeze source and finish the submission.** Update README, AI-use/provenance records and Ledger feedback with actual outcomes; preserve meaningful history. Run the checks required by any final code change through the isolated test launcher. Complete applicable feedback, confirm participant/check-in status in the dashboard, select eligible From Scratch tracks, and save the submission URL, confirmation and final commit SHA. At most three partners are planned: Uniswap, Ledger and Privy. No submission or award is claimed until evidenced.

## Recording the physical Ledger without a phone

Use OBS on the Mac with a macOS Screen Capture source for Rebalance and a Video Capture Device source for a webcam aimed at the Ledger. Place the device view beside the app, check focus/text readability before recording, and show the prompt, physical confirmation, receipt and updated portfolio. An external webcam is easier to position; a built-in camera may suffice for a brief held-up shot. [OBS source guide](https://obsproject.com/kb/sources-guide), [webcam source](https://obsproject.com/kb/video-capture-sources).

No documented production Nano Gen5 screen-mirroring path was found in the official sources checked September 12. Ledger's [Speculos screenshot API](https://speculos.ledger.com/user/api.html) captures an emulator; any such footage must be labelled emulation and cannot establish the actual hardware result. The [DMK API](https://developers.ledger.com/docs/device-interaction/dmk-ts/integration/how_to/dmk) documents device state and command interaction, not a physical display video feed.

## Demo script: approximately 3 minutes 35 seconds

Record at least 720p with **human narration and normal playback speed**. Use desktop screen recording rather than filming the screen on a phone; do not use AI voiceover. Waiting sections may be cut with a clear transition and actual timestamps retained where they substantiate the result. Do not accelerate playback or splice approval and swap evidence into a false single operation. Capture the device through a recording setup allowed by the event rules, and keep all secret/recovery screens out of the recording.

| Time | Show | Say / acceptance criterion |
| --- | --- | --- |
| 0:00–0:25 | Conversation and portfolio chart together. | State the recurring portfolio-maintenance problem and the one-conversation workflow. The viewer can name the product's user and benefit. |
| 0:25–0:55 | Current portfolio, actual/target rings and saved settings; one genuine prepared allocation interaction if included. | Explain integer allocation, drift threshold and deterministic execution. ETH is gas-only. Do not create a new financial action just for a UI illustration. |
| 0:55–1:25 | Real Uniswap transaction/receipt evidence and refreshed holdings. | Identify chain, signer and date. Show the link between a corrective swap and the portfolio result. Distinguish approval from swap and recorded evidence from a current run. |
| 1:25–2:25 | Ledger app/device interaction, observed outcome and receipt or explicit refusal state. | Explain that the backend prepares and the owner physically approves each transaction. Show the completed sequential app swap and on-target result; describe fewer batch confirmations as offline-tested until a live batch result is separately verified. Any Ethereum CLI clip is labelled standalone compatibility testing. |
| 2:25–2:50 | Explicit rejection/Stop/Retry evidence, only as actually tested. | Show that refusal does not repeatedly reopen prompts and uncertain sends retain their receipt barrier. Avoid claiming a cancelled timeout was an observed human rejection. |
| 2:50–3:15 | Privy completed flow if validated; otherwise the product result and source evidence. | For Privy, name the hosted Agent Sandbox trust boundary and show a real financial outcome. Omit an unverified adapter from the success montage. |
| 3:15–3:35 | Final allocation/result, source link and brief limitations. | State the concrete benefit and what works today. Acknowledge remaining Ledger display or provider-support limits in one sentence. End within four minutes. |

## Finalist preparation and stop line

Prepare a four-minute finalist presentation and concise answers for three minutes of questions: why a deterministic runner, where Ledger changes spending authority, how Uniswap is used, what the pending journal prevents, which parts remain externally trusted and exactly what was tested. Use implementation and evidence to support technicality, originality, practicality, usability and impact; no prize outcome is predictable from an integration checklist.

Once the reliable product story, evidence, feedback and recording are ready, prioritize submitting on time over adding another integration. Key Ring, multichain support, session delegation and a general policy platform are not prerequisites for finishing this chosen demo. Keep limitations explicit rather than allowing late optional work to leave the main submission incomplete.

Sources: [official submission rules](https://ethglobal.com/events/ethonline2026/info/details), [Ledger hackathon portal](https://developers.ledger.com/ethonline), `docs/HACKATHON.md`, `docs/LEDGER_EXECUTION.md`, `docs/LEDGER_FEEDBACK.md`, `docs/LEDGER_AGENT_STACK.md`, `docs/PRIVY.md`, `README.md`, plus the coordinating agent's current official-page and funding checks. Recheck outcome claims before recording and submission.
