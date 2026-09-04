# Ledger tooling and documentation feedback

**Status: pending physical-device integration.** No hardware result, SDK integration, screenshot or external feedback submission is claimed.

Physical integration is deferred as of **2026-09-04** until the owner's device arrives. Complete device-specific feedback after actual testing; simulated authorization or the separate raw-private-key backend cannot satisfy it.

Target: [ETHOnline 2026 — AI Agents x Ledger, From Scratch](https://ethglobal.com/events/ethonline2026/prizes/ledger). The [event portal](https://developers.ledger.com/ethonline) requires tooling feedback with every submission.

Complete with actual evidence:

- Hardware model, firmware, Ethereum app, OS, transport and DMK/Signer Kit versions.
- Setup, documentation and device-discovery experience.
- Robinhood chain/domain and policy signing behavior, including meaningful device display.
- Context resolution, any credentials or external requests, and local-operation limitations.
- Confirm/reject/disconnect results and protection of the proposal-to-authorization boundary.
- Specific confusing flows, gaps and suggested improvements; screenshots or PRs if useful.
- Reproduction instructions and exact code links.

Distinguish actual Clear Signing behavior from host UI previews and generic signing support. If `wallet-cli ring` or Agent Stack is later used, add its version, capability scope and observed local/remote behavior.
