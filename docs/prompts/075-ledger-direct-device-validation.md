# Direct backend Ledger confirmation and live validation

Date: 2026-09-12. Recorded before implementation.

## Human request

The owner connected and funded their selected Ledger portfolio and asked to test the full Ledger flow and Clear Signing. They clarified: “physical confirmation is fine for every transaction, they just shouldn't all need to talk to the agent rather be directly done from backend to the ledger.” An intervening request to refund excess ETH was cancelled; no refund is authorized by this work.

## Intended behavior

Starting a Ledger portfolio enables deterministic preparation and direct device prompts when its device is connected and rebalance conditions permit. No chat request is needed to begin or advance its approvals/swaps. Each transaction still requires physical Ledger confirmation through the existing official signer and verified account. No session keys, unattended hardware signing, blind-signing fallback or raw-key fallback is introduced.

Keep one wallet runner, fresh balances/quotes/fees, saved cadence, stop/config invalidation, and receipt barriers. Suppress repeat prompts following rejection or failure; retry only after an explicit retry or an observed reconnection, with fresh preparation. Persist the suppression so a process restart cannot replay a rejected operation. Successful cycles remain eligible for future deterministic rebalancing. Disconnected monitoring and other portfolios remain independent.

Retain the explicit Ledger rebalance command as an optional retry/control, while replacing the compulsory agent-request wording in the UI and instructions. Notifications must not mediate the device flow or wake the model for work the backend handles itself.

## Validation and evidence

The first live request reached execution but finished with an unavailable result before a transaction hash was recorded; the owner saw no prompt. A separate read-only SDK address check succeeded for the selected verified account. Add only fixed, public diagnostic stages/error categories needed to distinguish connection, address readiness, metadata/signing, fallback and invalid signature failures; never persist signatures, keys, arbitrary SDK error payloads or provider credentials.

Use isolated fixtures for state transitions, failure/reconnect suppression, stop/receipt barriers and diagnostic redaction, plus typecheck and appropriate regressions. Then load the new code for the selected Ledger monitor and continue the owner's authorized live test. Record actual device wording, transaction receipts and limitations; address verification and passing fixtures do not prove Clear Signing or swap success.
