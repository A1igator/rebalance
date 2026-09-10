# Remove the unrecoverable raw wallet — 2026-09-10

The human authorized deleting the unrecoverable raw wallet from the UI and application backend, while retaining the incident folder and evidence, and using the existing Ledger portfolio instead.

## Plan before the local operation

Verify the raw-wallet runner is stopped, stop its notification-only worker, remove its registry entry, and archive its active wallet-specific public configuration/history/control state under the retained local incident directory. Do not remove the shared portfolio registry, view/session infrastructure, other wallets, Ledger onboarding or Privy provider setup. Preserve incident evidence and the original public address for historical reference. Remove stale chat attachments to the retired wallet and explicitly connect this conversation to the existing Ledger wallet. Reuse its read-only companion; do not create a new wallet, change Ledger targets, start trading or request transaction signing. Verify the registry/UI no longer lists the raw wallet and the selected Ledger state is correct.
