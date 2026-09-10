# USDG paymaster implementation — September 10, 2026

## Human request

“so do the work? I want paymaster”

This follows the USDG paymaster feasibility check in prompt 057 and docs/PAYMASTER_CHECK.md. The owner wants the implementation, not only research. Their standing instruction is to commit and push main. Existing wallet addresses, targets, signer selection, stopped/running state and incident archives must be preserved.

## Plan before implementation

Implement an optional USDG gas-payment transport for Robinhood mainnet 4663, alongside the existing native-ETH transaction path. Use the documented Alchemy ERC-20 paymaster capability and same-address EIP-7702 account execution where its exact preparation/signature schemas can be validated. No session keys or general permission/budget engine. Pin the delegate/account version instead of silently following provider defaults; validate chain, wallet, delegate, requested calls, injected USDG paymaster approval and quoted fee before any signature. Native signing is never a silent fallback when the USDG transport is selected.

Retain deterministic observation, planning, cadence, user-selected fee target and event-based monitoring. Add signer capabilities for exact authorization and typed data through local Keychain, official Privy Agent Sandbox and existing Ledger SDK adapters. Keep Ledger physical confirmation and consumed rebalance-request checks before every signature/send. Preparation/estimation is read-only; activating account delegation or initiating a live operation requires a concrete user-authorized execution path. Do not activate or modify an existing portfolio during fixture verification.

Persist operation identity before submission, treat unknown sends as receipt barriers, and reconcile actual on-chain user-operation success, wallet, nonce and requested operation before reporting completion or allowing another leg. Do not send a legacy same-nonce cancellation for a UserOperation. Preserve full-rebalance fee-target meaning when using USDG quotes and reserve the quoted gas payment when spending USDG.

Provide a local-only provider credential/configuration setup path, clear status and read-only quote check. Never expose API credentials or signed authorization material in chat, URLs displayed by the app, logs or public output. An Alchemy billing-enabled app and active canonical-USDG policy may require owner setup. Prepare all code and a concrete final setup path before asking for any necessary external action; do not claim canonical token acceptance or a live sponsored swap from mocks.

Use current official Alchemy, Robinhood, viem, Ledger and Privy sources plus installed SDK code; record versions/licenses for dependencies actually adopted. A requested Tenjin search failed to connect, and its escalation was rejected over external project disclosure; do not retry or reroute it. Parallel agents audit provider preparation/receipt schemas and signer capabilities while root owns integration.

Validate exact intent/quote/signature binding, ETH-free balance handling, user-operation hash persistence and receipt reconciliation, failed/unknown sends, no native fallback, per-wallet config, native-path compatibility, Ledger cancellation and missing provider setup using isolated fixtures via npm test. Verify fresh provider infrastructure read-only when possible, record actual outcomes, refresh only read-only companions, and commit/push coherent implementation milestones with AI provenance.
