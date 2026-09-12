# Ledger tooling and documentation feedback

**Status: physical address onboarding verified; a live backend request reached the transaction prompt with “transaction check unavailable.” Completed signing, readable display and swap evidence remain pending.** No external feedback submission is claimed.

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
