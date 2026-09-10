# Ledger tooling and documentation feedback

**Status: physical address onboarding verified; transaction wiring implemented, with live transaction/display evidence pending.** No external feedback submission is claimed.

The initial September 4 deferral ended when the Nano Gen5 arrived. Keep address verification, isolated signing fixtures and actual mainnet signing evidence separate; the raw-key backend does not establish Ledger execution.

Target: [ETHOnline 2026 — AI Agents x Ledger, From Scratch](https://ethglobal.com/events/ethonline2026/prizes/ledger). The [event portal](https://developers.ledger.com/ethonline) requires tooling feedback with every submission.

Complete with actual evidence:

- Hardware model, firmware, Ethereum app, OS, transport and DMK/Signer Kit versions.
- Setup, documentation and device-discovery experience.
- Selected-chain domain and transaction signing behavior, including meaningful device display.
- Context resolution, any credentials or external requests, and local-operation limitations.
- Confirm/reject/disconnect results and protection of the proposal-to-authorization boundary.
- Drift tracking without the device, connection/app readiness detection, one fresh agent prompt on connect and reconciliation of earlier sends.
- Specific confusing flows, gaps and suggested improvements; screenshots or PRs if useful.
- Reproduction instructions and exact code links.

Distinguish actual Clear Signing behavior from host UI previews and generic signing support. Agent Stack reuse is planned; record adopted versions and actual scope. If Ring is adopted, record its observed local/remote lifecycle and broker enforcement separately.

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
