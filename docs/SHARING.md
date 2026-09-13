# Strategy sharing

The chart Share button and `share export` generate the same canonical `rebalance:v1` strategy code. It contains only five target weights, drift trigger and cycle interval. USDG comes first; remaining tickers use ASCII alphabetical order. Previously shared codes retain their original meaning regardless of order, and omitted optional settings stay omitted. No address, holdings, signer, RPC, capability URL or allocation-model inputs are shared.

## Pasting a code

Paste the complete plain-text code into chat. The Codex UserPromptSubmit hook, dedicated Claude import-only UserPromptSubmit hook, or OpenCode native user-message plugin passes it as one argument to `share preview`. The helper validates the version, manifest symbols, weights and optional settings before reading any local portfolio data. Quoted examples, code fences, notifications, other event types and unrelated surrounding prose do not automatically import. Normal prose requests can use the same CLI through the skill.

A selected portfolio is pinned once using the native conversation identity, then compared against fresh validated public configuration. The result supplies the decoded strategy, canonical code, target changes, optional setting changes and untracked assets. No selection means the result includes the decoded strategy and linked selector instead of invented empty comparisons. Browser presentation uses the existing host adapter/tool; creating view metadata does not activate a portfolio.

Only parsing and comparison are deterministic in the hook; the model still presents the result in natural language. It should preserve the returned values/code and not redo the allocation. Invalid input and unreadable selection return fixed safe errors. Preview never calls Start, restoration, recovery, signer/provider/RPC code or import --apply. Native Plan/root/provenance restrictions remain in force. No hook trust is granted by installation.

After an explicit apply request, `share import '<code>' --apply` adopts targets under the existing configuration lock. `--settings` additionally adopts the provided drift trigger and cycle interval when requested. Dropped symbols are no longer tracked; their holdings remain in the wallet. Pasting alone never changes targets, settings or trading state.

## Copying

Share copies the displayed saved snapshot directly, with no model or network round trip. If clipboard writes fail, the code is selectable in the page. Copy requests serialize. Strategy changes, disconnection and page hiding clear obsolete feedback; a delayed old clipboard completion cannot mark a different strategy as copied. The format is checked against CLI encoding in isolated tests.

See [prompt 087 and its clarification](prompts/087-deterministic-share.md). Live clipboard mutation or financial application is not needed to verify the parser and preview; native end-to-end dispatch remains distinct from fixture tests.
