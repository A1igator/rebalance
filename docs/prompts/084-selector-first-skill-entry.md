# Selector-first skill entry

Date: 2026-09-12. Human request: make the bare Rebalance invocation smoother for the demo by automatically opening the portfolio selector when no portfolio is provided or attached. The reported response narrated hook/permission diagnostics, treated missing selection as an incomplete launch, and asked for a second skill invocation after card selection.

## Intended behavior

- A bare launch with no explicit wallet and no saved conversation attachment returns an ordinary `select-portfolio` result and prepares the linked selector. This applies to zero, one or several registered portfolios; it does not pick a wallet based on registry count or the visible browser.
- A selected or explicitly addressed wallet retains the existing launch behavior. Named operations, pinned workers, native hook provenance, immutable request routing and newer Stop protection remain intact.
- Card selection already attaches the existing chat and opens that wallet chart. No additional skill call is needed to connect. Selection and setup remain non-trading; the existing explicit Start control remains available for an inactive portfolio.
- The skill opens the complete returned view URL in the existing host side pane and uses a short selector message. Routine entry should not narrate internal hook checks, list unrelated wallets, or conduct architecture research. Genuine failures and host permission rejections remain truthful.
- A selector may reuse a ready owned chart belonging to the same registry/root without attaching that chart's wallet. This avoids depending solely on an obsolete default-port listener. Unrelated or unowned listeners are never adopted, replaced or terminated.

## Work and validation

Update the CLI/shared native hook entry, routing helper if needed, public view selection, canonical skill and focused documentation. Follow skill-creator guidance for a narrow correction. Add isolated tests for empty/single/multiple registries, existing explicit/attached behavior, immutable selection replay and chart ownership/fallback. Reuse existing real card-connect and per-chat isolation tests. Test fixtures must use temporary storage through `npm test`, never real wallet data. Validate types and the skill. Commit and push main under the standing instruction; preserve unrelated stock-link edits. No live launch, trading controls, signing, recovery, target change, wallet creation, secrets or trust/permission changes are part of this task.
