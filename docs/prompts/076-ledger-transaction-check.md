# Ledger Transaction Check and Clear Signing setup

Date: 2026-09-12. Recorded before implementation.

## Human request and live evidence

The owner continued the Ledger device test and reported seeing the transaction with “transaction check unavailable.” They asked whether it is fixable and reiterated the need for readable transactions in the hackathon demo. The latest request reached the SDK signTransaction step and ended cancelled with no pending or last-transaction record. Device wording is human-reported; no completed signature, receipt or Clear Signing claim follows from it.

## Diagnosis and bounded change

The custom ContextModuleBuilder currently receives no originToken. Official Ledger documentation requires an application-issued token for its transaction-security services. Pinned ContextModule 2.5.0 substitutes an empty token and omits X-Ledger-Client-Origin when absent; setting a token only on SignerEthBuilder would not affect our custom context.

Wire an optional runtime LEDGER_ORIGIN_TOKEN directly into the custom context builder, validate it without reflecting its value, and retain disabled optional reports and the existing no-blind-fallback behavior. Do not borrow another application's token, manufacture a check result, suppress the device warning, or claim this proves Robinhood service coverage. No real token is available in this task.

Document the official partner-program/hackathon support path and the remaining separate requirements: provider coverage for chain 4663 and usable trusted contract/token metadata for readable display. Unit checks use injected context builders and synthetic token strings only, with no hosted request, live credentials or hardware. Record actual tests and device evidence, then commit/push under the owner's main-branch preference.
