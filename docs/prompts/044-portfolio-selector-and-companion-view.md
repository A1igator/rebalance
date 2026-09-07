# Portfolio selector and persistent companion view — 2026-09-07

## Human request

Show a grid of wallet portfolios when the UI opens, with a Back button from the chart and a new-wallet entry offering raw private key, Privy and Ledger. Selecting a wallet also selects the current agent conversation's portfolio. Direct agent selection remains available. The new-wallet entry opens setup with the agent. Keep independent deterministic background runners. After considering MCP Apps, the owner chose the persistent local companion view so the chart stays visible while scrolling, and requested that Claude open its supported companion view too.

## Implementation plan committed before code

- Keep the bundled local chart, and add a compact opening grid and navigation. Portfolio views remain wallet scoped; empty wallets retain explicit target-only labels. No browser allocation, signing or trading controls.
- Share the existing per-conversation connection record between UI and CLI. Bind browser interaction to the opening conversation through a narrow opaque local view handle; never infer a chat identity from a reused chart process, browser-global storage or the displayed wallet. Selecting a card changes only the attachment and opens/reuses that wallet's view.
- Add a view bootstrap that works before wallet selection and with an empty registry. Use public profile data only; one damaged wallet must not hide every card. Preserve signer, policy, runner, pending, recovery, cycle and stop state.
- Send an explicit new-wallet setup request to the opening agent through supported native delivery. Raw-key, Privy and Ledger choices are setup intent, not authority to silently overwrite an existing account. No key material enters the UI; provider login/device actions and unsupported Ledger execution remain accurately described. Avoid duplicate setup delivery on retries.
- Reuse persistent side views where the host supports them. Verify official Claude Desktop preview and terminal companion options; do not claim a docked native panel in unsupported hosts. Keep a usable local URL fallback, do not change user hook trust or permissions, and do not invoke a funded hook during development.
- Preserve the deterministic skill entry and request deduplication. Add view guidance/wiring without introducing a model loop or broadening trading authority.
- Test wallet/conversation isolation, view request validation, empty/corrupt entries, replay handling and navigation with disposable fixtures. Visually inspect desktop/narrow layouts. Reload only view processes when needed; publish exact validation and host limitations, then commit/push the authorized work.

No new dependency or MCP Apps renderer is planned. Host-specific delivery and view capabilities will be documented from official sources as implementation proceeds.
