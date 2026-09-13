# Strategy sharing

The chart Share button and `share export` generate the same canonical `rebalance:v1` strategy code. It contains only five target weights, drift trigger and cycle interval. USDG comes first; remaining tickers use ASCII alphabetical order. Previously shared codes retain their original meaning regardless of order, and omitted optional settings stay omitted. No address, holdings, signer, RPC, capability URL or allocation-model inputs are shared.

## Pasting a code

Paste the complete plain-text code into chat to apply it to that conversation's attached portfolio. The Codex UserPromptSubmit hook, dedicated Claude import-only UserPromptSubmit hook, or OpenCode native user-message plugin passes it as one argument to `share receive`, with the native session and stable request identity. The helper validates the version, manifest symbols, weights and optional settings before reading portfolio state. Quoted examples, code fences, notifications, other event types and unrelated surrounding prose do not trigger automatic import.

The helper captures the trusted conversation attachment once, validates the public wallet/chain/configuration, then applies targets and included drift/interval settings under `config.lock`. Omitted settings, fee target, slippage, signer and other unrelated configuration are preserved. A computed allocation policy is cleared, matching explicit manual strategy import. Removed symbols are no longer tracked; their holdings remain in the wallet and the result reports them. Browser metadata never supplies wallet selection, and even a lone wallet is not automatically chosen for this write.

With no attached portfolio, the result contains the decoded strategy and linked selector. Choose a portfolio and paste again. Card selection alone never applies an earlier code. A completed import returns the wallet and computed changes; the model reports that result briefly instead of asking to select or apply again. Application updates saved configuration and creates one explicit rebalance request, not a completed rebalance: it does not start/stop a runner or call a signer, provider or RPC. An already running backend handles the request without the automatic cooldown, after pending receipts reconcile and with ordinary fee, Stop and Ledger confirmation checks. Replaying the native request receipt never grants another bypass.

A public per-request journal fixes the wallet route and prevents duplicate native prompt delivery from overwriting later edits or another selected wallet. Its write-ahead barrier is saved before the configuration commit. An incomplete/uncertain commit returns `unknown`, never claims no changes, and is never automatically reapplied. A replayed receipt describes the earlier application rather than proving current settings. The model must not repeat any native import.

Explicit `share preview '<code>'` remains read-only. Natural-language preview requests use it; explicit natural-language import requests can use the established `share import '<code>' --apply --settings` after resolving the intended portfolio. `--settings` copies only supplied drift/interval fields. Without native output for an exact pasted code, inspect read-only state and receipts first; do not duplicate a possibly completed import. Native Plan/root/provenance restrictions remain in force. Installation never grants hook trust.

## Copying

Share copies the displayed saved snapshot directly, with no model or network round trip. If clipboard writes fail, the code is selectable in the page. Copy requests serialize. Strategy changes, disconnection and page hiding clear obsolete feedback; a delayed old clipboard completion cannot mark a different strategy as copied. The format is checked against CLI encoding in isolated tests.

See [prompt 087](prompts/087-deterministic-share.md) and the subsequent [automatic application clarification](prompts/088-apply-pasted-strategy.md). Isolated tests verify application and replay without live wallet mutation. Native end-to-end dispatch remains distinct from fixture tests.
