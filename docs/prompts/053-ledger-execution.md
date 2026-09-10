# Ledger transaction execution — 2026-09-10

## Human requests and scope

The user asked to return to Ledger integration after the device arrived, to use the official Ledger CLI and https://developers.ledger.com/ethonline, then said: “wire it. use the hackathon page again as I mentioned and always push to main”. They clarified the intervening PR #20 task as preview-only, and subsequently requested: “and continue wiring ledger”.

Prior product decisions remain: Robinhood mainnet only, deterministic planning/execution with no LLM in the loop, independent wallet portfolios, direct signing without session keys or spending caps, automatic raw-key/Privy signing, and physical Ledger transaction confirmation. Connection and wallet setup alone do not authorize transactions. Current authorization is to implement, validate and push this wiring; tests will not arm a funded runner or sign/broadcast a live transaction.

## Implementation plan committed before code

1. Reuse pinned Ledger DMK, native HID and Ethereum Signer Kit, including the existing indexed onboarding journal and shared hardware lock. Resolve only a physically verified saved account; verify device identity and serialized sender. Sign the exact prepared Robinhood legacy transaction, with no CLI requote or fallback signer. Bound observable waits and native cleanup. Suppress SDK signing-report telemetry while retaining explicitly disclosed metadata/context requests; report actual display limitations without promising universal Clear Signing.
2. Enable Start/launch for Ledger public monitoring. Add an explicit `ledger rebalance --request-id <UUID>` command that queues one wallet/config/runner-bound request with bounded expiry. Claim durably before hardware access; only that runner's in-memory request may progress through freshly observed/quoted approval and swap legs. Replay, restart, stop, target change, rejection, timeout, uncertain send or failed traversal cannot reactivate old signing intent. Every transaction still requires physical confirmation.
3. Preserve pending-hash reconciliation, two observed confirmations, one pending operation per wallet, existing swap cadence and cycle deadlines. Ledger does not use automatic cancellation signing. Local request file events wake deterministic monitoring immediately, with the existing watchdog as fallback. Notifications never invoke signing; actionable Ledger drift is retained once, routine retries stay local.
4. Add focused tests for exact hardware signing, failure/identity boundaries, request replay/restart/expiry/stop, normal launch/controls, and unchanged automatic signer behavior. Run project typecheck and tests, record actual outcomes and remaining physical signing evidence. Update usage/SDK/feedback docs and push coherent commits to main. PR #20 remains separate.

## Source and reuse

Rechecked https://developers.ledger.com/ethonline on 2026-09-10. Its human-approval direction uses Ledger primitives; its two highlighted headless-secret directions specifically require Key Ring. Required tooling/DX feedback remains part of submission.

Official implementation guidance: LedgerHQ/agent-skills at `2edb3937d80dec28f46c87c29aae841e6874fc7d`, `skills/dmk/ledger-dmk-implementation/SKILL.md` and its referenced API/code/platform guidance. Read as development instructions, not copied into this repository. Installed package types and source maps take precedence over older examples. Existing locked dependencies remain DMK 1.9.0, Node HID 1.0.1, Ethereum Signer Kit 1.18.0 and Context Module 2.5.0 (Apache-2.0); viem 2.56.3 is reused for exact serialization and signer recovery. No new library, key, credential or seed is introduced.

Earlier physical onboarding established a genuine Nano Gen5 and physically verified an indexed Ethereum address. This is onboarding evidence, not proof of transaction signing, Clear Signing, a successful swap or prize qualification. The installed standalone wallet-cli 2.1.0 was used for device diagnostics only; the application's indexed signing path uses the SDK because the observed CLI flow does not preserve the application's exact prepared transaction and reserved account path.

## Delegated work

- Signer implementation: exact serialized signing, reusable onboarding/device helpers, public account identity and focused fixtures; no live hardware signing.
- Launch/control implementation: Ledger monitoring enablement and accurate chart wording, with replay and setup-only semantics preserved.
- Root implementation: durable per-rebalance request, runtime/scheduler/command/dispatch integration, documentation, independent review and verification.
