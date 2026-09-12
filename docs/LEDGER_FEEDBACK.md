# Ledger tooling and documentation feedback

**Status: physical address onboarding verified; a live backend request reached the transaction prompt with “transaction check unavailable.” A subsequent USDG approval was signed and confirmed onchain; readable display and swap evidence remain pending.** No external feedback submission is claimed.

The initial September 4 deferral ended when the Nano Gen5 arrived. Keep address verification, isolated signing fixtures and actual mainnet signing evidence separate; the raw-key backend does not establish Ledger execution.

Target: [ETHOnline 2026 — AI Agents x Ledger, From Scratch](https://ethglobal.com/events/ethonline2026/prizes/ledger). The [event portal](https://developers.ledger.com/ethonline) requires tooling feedback with every submission.

Complete with actual evidence:

- Hardware model, firmware, Ethereum app, OS, transport and DMK/Signer Kit versions.
- Setup, documentation and device-discovery experience.
- Selected-chain domain and transaction signing behavior, including meaningful device display.
- Context resolution, any credentials or external requests, and local-operation limitations.
- Confirm/reject/disconnect results and protection of the proposal-to-authorization boundary.
- Drift tracking without the device, connection/app readiness detection, fresh backend transaction preparation on connect and reconciliation of earlier sends.
- Specific confusing flows, gaps and suggested improvements; screenshots or PRs if useful.
- Reproduction instructions and exact code links.

Distinguish actual Clear Signing behavior from host UI previews and generic signing support. Agent Stack reuse is implemented; record adopted versions and actual scope. If Ring is adopted, record its observed local/remote lifecycle and broker enforcement separately.

## Documentation/source observations — no runtime test

The [source assessment](LEDGER_AGENT_STACK.md) pins the inspected code and supporting links. Items to validate and refine into sponsor feedback:

- The EVM documentation and existing Robinhood/Base configs are broader than the explicit three-currency guard in `swap quote`; `swap execute` follows a different resolution path. A command-by-command chain matrix and consistent validation would remove ambiguity. Our initial blanket no-L2 interpretation was incorrect and has been corrected.
- Execute obtains a fresh quote and lacks a sufficient exact-transaction/slippage-settings interface for this application's deterministic planner. Evaluate a reusable builder without introducing a spending-policy engine.
- Verify analytics and hosted-service behavior before claiming a local, telemetry-free integration.
- Ring handles encryption; our constrained credential broker would be separate project work. Record service dependencies and isolation guarantees accurately.

These observations are not hardware feedback, successful integration evidence or an external submission.

## Observed integration experience — September 10

- On macOS arm64 with Node 24.18.0, the official wallet-cli 2.1.0 completed a genuine check and discovered the primary Ethereum account. The application's DMK/Signer Kit subsequently completed physical verification of its separately reserved indexed account. No transaction was signed or broadcast for that onboarding. Earlier locked-device and USB-access failures were real; Finder's mounted Ledger Wallet installer volumes did not establish hardware USB visibility.
- The installed CommonJS exports loaded under native Node; the packages' ESM extensionless imports did not. A tested native-Node example using the published constructors and cleanup APIs would shorten setup.
- CLI account discovery did not offer the application's exact reserved index/prepared-transaction flow. The existing SDK path preserves both. A documented API for exact prepared transactions, account path and minimum-output/expiry would make CLI reuse easier.
- Context Module signing reports are separate from DMK logger subscribers. Documenting a supported telemetry opt-out and the remaining metadata requests would improve privacy claims. This app suppresses report methods while retaining context resolution.
- The Signer Kit's observable reports fallback but its completed signature does not establish how the transaction was displayed. Exposing a verified display/context result would help applications report Clear Signing accurately. This application cancels the explicit fallback transition; real Robinhood device display remains to be observed.
- Node HID owns a process exit listener in addition to transport subscriptions. Explicit lifecycle documentation and cleanup tests would make long-running agents with repeated device operations easier to integrate.

Still to record: exact firmware/Ethereum app versions, real approval/swap signing and rejection, on-device network/token wording, confirmed mainnet receipt, and the final human-narrated demonstration. The unit suite uses injected observable/RPC fixtures and cannot establish these outcomes.


## Live validation and direct device flow — September 12

The user requested direct backend-to-device preparation while running, with physical confirmation for each approval/swap. The compulsory agent-request gate has been removed in source. Bounded requests are now an internal backend execution record; a rejected, timed-out or failed attempt durably suppresses repeat prompts until real disconnection/reconnection or an optional explicit retry. Process startup or a discovery error alone cannot clear that suppression. Receipt reconciliation, cycle timing, fresh preparation and device-account verification remain required.

Before this change, physical address verification succeeded for the selected indexed account. After funding, one explicit live request was consumed and finished as unavailable before recording a transaction hash; the user reported no device prompt. A separate subsequent public-address read through the same SDK completed for the selected account. These observations do not localize the original failure to signing, metadata or hardware transport, and they do not establish Clear Signing or a completed swap.

Fixed diagnostics now distinguish connection, anchor/account reads, signing/context steps, signature verification and cleanup. They retain allowlisted SDK steps/error categories, APDU status codes and network status/timeout fields, without arbitrary provider messages, URLs, context payloads, signatures or transaction bytes. This is intended to make the next actual device attempt diagnosable without enabling SDK logs or blind-sign fallback.

Pinned Node HID 1.0.1 source review identified two lifecycle hazards: its discovered-device BehaviorSubject starts with a synthetic empty list, and its destroy/exit cleanup removes all listeners from the shared USB emitter. The app now treats initial emptiness as unknown until that listener has observed a device, and uses a guarded per-instance lifecycle adapter that removes only callbacks installed by that transport. Eight injected lifecycle tests cover monitor/signer coexistence, teardown and failure paths. This is a compatibility seam against the pinned emitted private method/controller, not a new official SDK API or live reconnect proof. A supported per-transport disposal API and discovery-initialization signal would remove the need for these adaptations.


## Transaction Check prerequisite — September 12

The owner reported a transaction prompt with “transaction check unavailable” on Nano Gen5. The backend reached `signer.eth.steps.signTransaction`; the attempt ended cancelled, with no pending or last-transaction record. Cancellation does not establish whether the user rejected it or the prompt expired. No completed signature, broadcast receipt or readable token/amount/spender/network display was established.

Our custom Context Module omitted `originToken`. This was an application integration omission: [Ledger's wallet guide](https://developers.ledger.com/docs/clear-signing/for-wallets) and [custom-context migration example](https://developers.ledger.com/docs/device-interaction/dmk-ts/integration/migrations/signers/eth/1_3_3_to_1_4_0) document the credential. Runtime wiring is now implemented, but no actual token is available. The pinned Context Module 2.5.0 substitutes an empty token and omits `X-Ledger-Client-Origin`; it does not immediately throw for that missing prerequisite. Its check loader can return a generic service error while signing proceeds with other contexts. Clearer early diagnostics would have made this omission easier to identify.

Missing authentication is a confirmed gap, not a proven sole cause of the on-device message: no service response was captured in this test. Robinhood 4663 Transaction Check coverage and trusted contract metadata remain unverified. A published chain/contract coverage check and a fast hackathon origin-token enrollment path would help custom-chain integrations. Successful threat screening alone would not verify Clear Signing. The support draft and runtime setup caveat are in [Ledger execution](LEDGER_EXECUTION.md); no external request or feedback submission has been sent.


## Verified approval, unsupported swap and companion Retry — September 12

A further owner-requested attempt completed an exact 1.1875 USDG approval to the configured Robinhood Uniswap router. Public RPC verified receipt success at block 61423563 and decoded the expected sender, token, spender and amount. [Evidence](evidence/ledger-approval-2026-09-12.json). The swap then requested the SDK's blind-signing fallback, which the adapter refused; the owner reported a device message directing them to enable transaction signing. This differs from the earlier unavailable Transaction Check warning and does not establish Clear Signing.

The owner requested a Retry button rather than disconnect/reconnect or an agent command after cancellation. The companion now offers an explicit wallet/request-bound retry while preserving device confirmation, pending receipt barriers and fallback refusal. This closes an application workflow gap; it does not repair unsupported transaction display.

Current public ERC-7730 data has no Robinhood-4663 entry for our router; the existing Router02 descriptor covers Ethereum mainnet/direct methods rather than our deadline-bearing multicall. One credential-free CAL request returned HTTP 403, so the hosted metadata inventory remains unknown. The [execution guide](LEDGER_EXECUTION.md) records the exact gap and source links. A searchable chain/deployment/selector support matrix and clear separation of credential failures, absent descriptors and device-setting errors would help integrators. No external feedback submission is claimed.

## Device presence and failed USB writes — September 12

The owner reported ineffective Retry despite a visible device. Request-journal timestamps established immediate dispatch, but public-account reads failed before any transaction prompt. Our narrow diagnostic allowlist had omitted the official Node HID `NodeHidSendReportError` tag, hiding the actionable layer. Adding that fixed tag and retaining explicit chart states corrected the application diagnostics. USB discovery alone did not establish command readiness; a later enumeration contained no Ledger device. No specific cable, firmware or hardware defect was established, and no physical connection fix is claimed from the UI tests.


## Published CLI indexed-account discovery — September 12

An owner-approved official CLI 2.1.0 account-discovery check initially reported a locked device. After the owner unlocked it, Ethereum discovery completed but returned only the first account, which differed from the funded account previously verified through the SDK at an indexed derivation path. The public discover command exposes network/output/device-timeout, with no account index, derivation path or gap-limit option. The source's scan stops at an unused account; a later funded indexed account can therefore be unreachable through this command. Quote inputs require discovered session labels, so we did not substitute the wrong address or fabricate a local session.

Suggested improvement: expose an explicit account index/path or bounded empty-account scan option, and allow a public-address read-only quote without first requiring device discovery. This would make multi-account application comparisons reproducible without altering existing wallets. This observation concerns the published discovery/quote workflow, not a claim that Ethereum swaps or indexed hardware signing are unsupported. [Sanitized outcomes](evidence/ledger-mainnet-account-check-2026-09-12.json).
