# Square portfolio previews — 2026-09-07

## Human request

> the grid should use same thing as pie chart to show so a lot more square so they can fit more into rows

## Plan before implementation

Replace the selector's wide text-heavy cards and allocation bars with compact square tiles containing a miniature allocation donut. Share the full chart's ring geometry and asset colors instead of introducing a chart dependency. The existing selector supplies saved targets, so label previews as targets and never imply they are observed holdings. Retain concise signer, public wallet identity, connection/running state and target-model labels; detailed percentages remain accessible.

Use a smaller responsive grid minimum so two tiles fit the current narrow companion pane and wider panes gain more columns. Give New portfolio the same square footprint. Preserve all selection, Back, setup-request and session synchronization behavior. No trading, configuration, secret access or new market-data reads are part of this presentation change.

Verify the existing renderer and selector regressions, type checking and actual narrow side-panel layout. Record the actual result in AI_USAGE.md. Keep the changes local while the prior publication approval remains pending; this visual request does not supply the explicit push destination approval requested by automatic review.
