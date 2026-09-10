# macOS Keychain wallet storage — September 10, 2026

## Human requests

“is the website working?”

“also can we use the macos keyring for wallet creation this time it should be safer”

The exact current selector URL was checked in the live browser after successful localhost HTTP checks. It loads Privy and Ledger, with Ledger connected and both stopped. The old browser tab retained an earlier connection-error document.

## Implementation plan, before code

Use macOS login Keychain through a small compiled Swift Security.framework helper for new local-wallet signing material. Preserve the existing shared-seed browser-wallet account model and the private-key signer mode. Both selector and CLI creation must use Keychain on macOS; existing file-based wallets remain explicit legacy identities and are not silently migrated or replaced. Established Keychain wallets never fall back to an environment or file key.

Pass bounded private data only through subprocess stdin/captured stdout, never command arguments, environment variables, logs or public API results. Use exact app-specific service/account queries, insertion-only creation and no automatic overwrite/delete operation. Store only public references, fingerprints, indexes and reservations in the project; derive signing accounts in memory. A missing or mismatched established seed blocks creation/signing. Keep Ledger, Privy, incident archives, current allocations and execution state intact. Setup does not start trading.

Use Apple’s ordinary login Keychain for this CLI MVP. Do not claim Secure Enclave signing, Touch ID gating, iCloud recovery or provisioned app entitlements. Document packaging/access prompts and backup limits. Record Apple API provenance; avoid adding a credential npm dependency when the native helper suffices.

Validate creation/reuse, shared account derivation, interruption, missing/corrupt metadata or secret, absence of new plaintext seed/key files, environment-override rejection, concurrent creation and sanitized failures with isolated fake stores. Ordinary tests must be unable to invoke the user’s real Keychain. Compile the native helper, and where available verify create/read with a uniquely scoped disposable non-wallet Keychain item and clean up only that diagnostic item. No real wallet secret may be inspected or exposed. Recheck the companion, record actual evidence, and commit/push main under standing authorization.
