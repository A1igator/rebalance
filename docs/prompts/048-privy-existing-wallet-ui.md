# Privy wallet reuse should be explicit — 2026-09-07

Human report: “new privy wallet seems to just send me to my old wallet”.

The selector currently auto-connects every successful setup result, including a reused Privy address. The chosen pinned Agent Sandbox CLI exposes the first Ethereum wallet in its signed-in session and no separate create-wallet or wallet-selection command. A New portfolio label must not imply that another wallet was created.

Correct the interface within the current provider integration: explain in the Privy option that it connects the signed-in wallet, and keep a reused Privy result in the dialog with a clear existing-wallet message and an explicit Open existing portfolio button. Only that new explicit click may attach it. First-time registration may still open normally. Preserve provider authentication, existing portfolios/targets, trading, and all idempotent setup mechanics. Do not log out, replace sessions, create credentials or invent an API to force a second wallet.

Check current official provider docs and the pinned CLI independently. Document the supported alternative for genuinely separate wallets without adopting a new integration in this correction. Add focused UI regressions for both initial and streamed reuse, explicit opening, and unchanged automatic first-time setup. Verify the existing side panel without creating a new wallet or provider session. Record AI use and commit locally; remote push remains pending its prior approval.
