# Ledger restart checks and recoverable control failures

Date: 2026-09-13.

The owner reported that a stopped Ledger portfolio displayed 7702 setup loading and then Unavailable when Start was clicked. They clarified that this wallet already had 7702 enabled and should not imply new setup.

The referenced task was read. Wallet-scoped public status showed the existing Simple7702 configuration, stopped execution and an uncertain Start record. A fresh read-only public-chain setup check returned already-enabled. No pending transaction or current run/launch lock was found; the old setup-stage record belonged to the earlier successful authorization. Those observations do not retroactively prove whether an uncertain old control dispatched.

Fix the controller to distinguish read-only delegation verification from real setup. Start initially reports starting/checking; only verified setup-needed or retained setup work reports setting-up. A failed predispatch verification becomes an actionable retryable block. A fresh already-enabled result skips the setup command only after matching configuration, pending and Stop checks under the existing locks. Preserve any uncertainty after a command may have dispatched, including old unknown records.

For an old uncertain Start with no active owner, expose an explicit Cancel start action through the existing Stop endpoint. A user click records a newer Stop generation; it does not replay Start or delete pending transactions/history. Ordinary unavailable/read-error states do not acquire this capability. No automatic cancellation or activation, signing, notification change or wallet mutation is part of validation. Test exact request/portfolio scope, Stop/config races, read-only failures, ready/needed paths and preservation of true unknown sends.

After isolated tests, update only the owned chart service so the UI and controller match; leave trading activation to the user's next explicit Start. Preserve meaningful history, update AI usage and push to main under the owner's standing authorization. Tenjin stays disabled.
