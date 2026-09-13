# Wallet setup

In the agent-linked portfolio grid, **New portfolio** starts setup directly in local code. The model is not called. The dialog receives public progress through local file events and opens the resulting portfolio if the dialog is still active and the conversation has not selected a different wallet. Closing the dialog lets setup finish without changing another selection.

New portfolios begin with the saved demo defaults: USDG 5%, AAPL/NVDA/MSFT/AMD 23.75% each. An existing address opens its existing portfolio and retains its targets, including a saved allocation policy. Setup creates no trading process, signature, transaction, recovery request or notification binding. Use the normal agent flow to edit targets or launch the selected portfolio.

## Local key

New accounts on macOS share one 24-word BIP-39 seed stored in macOS Keychain. They use conventional browser-wallet paths `m/44'/60'/0'/0/0`, `m/44'/60'/0'/0/1`, and so on. This does not import a browser wallet's seed. The first CLI `wallet create` also uses this seed; additional selector accounts continue its indexes.

The project keeps only public seed references/fingerprints in `.local/hd/keychain.json`, reservations in `.local/hd/accounts.json`, and matching public identity records in each wallet's `wallet.json` and `keychain-wallet.json`. The signer derives its account in process memory. New macOS wallets write neither `hd/seed.json` nor a `private-key` file. Missing, denied or inconsistent Keychain data blocks setup/signing instead of generating a replacement or trying an environment/file key. macOS may ask permission to access the Keychain; allow it only for the expected Rebalance helper. Setup remains unarmed.

Existing legacy standalone file wallets remain readable and reusable. An existing file-based HD seed requires a separate migration before creating another macOS local account; migration is not performed automatically. Linux retains the previous file-backed local setup. The original standalone demo wallet was explicitly retired after the documented incident; Keychain does not recover its lost key. Keychain storage is not a verified backup or recovery flow. See [macOS storage and validation](MACOS_KEYCHAIN.md).

## Privy

The pinned official Privy CLI reuses its cached first Ethereum wallet. If sign-in is needed, it opens the official approval page in the system browser. The dialog displays the same approval URL and user code as a fallback. Complete provider authentication there; the app finishes registration after the CLI succeeds. Nothing asks for a private key in chat.

The CLI provides one signed-in Ethereum wallet, not a new wallet selector on every click. Once a Privy portfolio exists, the option is disabled and its hover tooltip explains the limit. An older in-flight setup returning the same wallet still offers **Open existing portfolio** instead of redirecting automatically. It does not log out or replace credentials automatically. A cached address is not proof of current service authorization. See [Privy implementation and validation](PRIVY.md).

The human explicitly requires **agents.privy.io exclusively**, with no developer dashboard, app secret or alternate app integration. A fresh inspection of the Sandbox website and official skill on September 7 also found no supported additional-Ethereum-wallet control: its wallet page selects the first linked Ethereum/Solana wallet, creates on login only for users without wallets, and My agents manages device sessions. Generic additional-wallet functions inside the bundled SDK are not exposed Sandbox features and must not be invoked as a workaround. Logout/relogin is not a documented additional-wallet creation method. Keep the existing portfolio/session and report this limitation; do not pretend that opening it creates another wallet. [Agent Sandbox](https://agents.privy.io), [official skill](https://agents.privy.io/skill.md), [My agents](https://agents.privy.io/manage).

## Ledger

Connect and unlock the device and open Ethereum. The official Ledger Device Management Kit, Node HID transport and Ethereum signer derive an indexed account address on its existing seed and request physical address verification. This does not initialize or reset the Ledger, modify its recovery phrase or submit a transaction. A new account means an address new to this application's reservations; it is not proof that no other app or chain has used it.

The first new index is 1, using `44'/60'/1'/0/0`; later requests advance that account index. A public account-zero fingerprint binds retries to the same device seed. Address verification omits chain-specific metadata, and registration explicitly targets Robinhood chain 4663. The signing adapter reuses this verified indexed identity and checks the selected account when signing. Start or bare launch enables public drift/receipt monitoring while disconnected. When a running monitor has a ready device and execution conditions permit, the backend creates a bounded request directly, with fresh preparation and physical confirmation for every approval/swap. The explicit `ledger rebalance --request-id <UUID>` command is an optional retry. Setup never starts trading; rejected/expired/consumed requests cannot replay after restart. Use `ledger status` for public request state. See [Ledger execution](LEDGER_EXECUTION.md) and [dependencies and hardware limits](LEDGER_AGENT_STACK.md). The sequential Ledger rebalance is verified; live batching, readable display and explicit rejection remain separate evidence checks.

## Retry and scope

Each click has a conversation-scoped request ID. Double delivery and the dialog's Retry reuse it; a saved reservation retains the same account index. The job records public verified identity before registration, so retry after interrupted registration does not prompt the provider again. Privy approval has a bounded timeout; Ledger discovery/verification has a two-minute deadline. Failed or interrupted requests preserve their records. A page reload may require reopening setup; completed wallets remain in the grid.

Requests require the existing local view capability and same-origin JSON. Read-only status and event streams never begin or retry setup. New setup progress bypasses both model transports. Older model-directed setup records remain available only for compatibility; new clicks do not populate that queue.

Tests use temporary roots, disposable mnemonic vectors and fake provider/device processes. They do not demonstrate a real Privy login, hardware verification or live swap.


The New portfolio dialog disables Privy once a Privy portfolio is registered. Hovering the disabled choice (or focusing its wrapper with the keyboard) explains the current Sandbox one-Ethereum-wallet limit. The existing Privy portfolio card stays available. Live portfolio snapshots refresh this state, while the click handler also refuses a duplicate setup request. The explanation stays in the tooltip rather than adding persistent text outside the choices.
