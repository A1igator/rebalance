# Wallet setup

In the agent-linked portfolio grid, **New portfolio** starts setup directly in local code. The model is not called. The dialog receives public progress through local file events and opens the resulting portfolio if the dialog is still active and the conversation has not selected a different wallet. Closing the dialog lets setup finish without changing another selection.

New portfolios begin with the saved demo defaults: USDG 5%, AAPL/NVDA/MSFT/AMD 23.75% each. An existing address opens its existing portfolio and retains its targets, including a saved allocation policy. Setup creates no trading process, signature, transaction, recovery request or notification binding. Use the normal agent flow to edit targets or launch the selected portfolio.

## Local key

New accounts from this selector share one app-local 24-word BIP-39 seed. They use conventional browser-wallet paths `m/44'/60'/0'/0/0`, `m/44'/60'/0'/0/1`, and so on. This does not import a browser wallet's seed.

The seed is stored locally in ignored `.local/hd/seed.json` with owner-only permissions. `.local/hd/accounts.json` records public account indexes and request reservations. The derived signing key is provisioned into that wallet's own ignored directory for the existing deterministic signer. Neither seed nor key is returned to the browser, model or logs. Back up the seed using a trusted local method; this UI does not export it.

The original funded standalone wallet stays intact. Its old randomly generated private key cannot be reconstructed from the new seed. The legacy `wallet create` command remains a create-or-reuse bootstrap for that standalone wallet; additional accounts through New portfolio use the shared seed. Missing or inconsistent seed/reservation files block creation instead of silently creating a replacement seed.

## Privy

The pinned official Privy CLI reuses its cached first Ethereum wallet. If sign-in is needed, it opens the official approval page in the system browser. The dialog displays the same approval URL and user code as a fallback. Complete provider authentication there; the app finishes registration after the CLI succeeds. Nothing asks for a private key in chat.

The CLI provides one signed-in Ethereum wallet, not a new wallet selector on every click. Choosing Privy again opens that wallet's portfolio. It does not log out or replace credentials automatically. A cached address is not proof of current service authorization. See [Privy implementation and validation](PRIVY.md).

## Ledger

Connect and unlock the device and open Ethereum. The official Ledger Device Management Kit, Node HID transport and Ethereum signer derive an indexed account address on its existing seed and request physical address verification. This does not initialize or reset the Ledger, modify its recovery phrase or submit a transaction. A new account means an address new to this application's reservations; it is not proof that no other app or chain has used it.

The first new index is 1, using `44'/60'/1'/0/0`; later requests advance that account index. A public account-zero fingerprint binds retries to the same device seed. Address verification omits chain-specific metadata, and registration explicitly targets Robinhood chain 4663. Hardware transaction signing remains a later integration. See [Ledger dependencies and hardware limits](LEDGER_AGENT_STACK.md).

## Retry and scope

Each click has a conversation-scoped request ID. Double delivery and the dialog's Retry reuse it; a saved reservation retains the same account index. The job records public verified identity before registration, so retry after interrupted registration does not prompt the provider again. Privy approval has a bounded timeout; Ledger discovery/verification has a two-minute deadline. Failed or interrupted requests preserve their records. A page reload may require reopening setup; completed wallets remain in the grid.

Requests require the existing local view capability and same-origin JSON. Read-only status and event streams never begin or retry setup. New setup progress bypasses both model transports. Older model-directed setup records remain available only for compatibility; new clicks do not populate that queue.

Tests use temporary roots, disposable mnemonic vectors and fake provider/device processes. They do not demonstrate a real Privy login, hardware verification or live swap.
