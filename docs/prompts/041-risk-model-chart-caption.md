# Show the risk model in the chart — 2026-09-07

## Human requests

> can I see it in the UI?

> and I thought sharpe was maximizing risk adjusted return such that risk can be manually inputted

The intended objective remains maximizing expected excess return against the user's manually supplied risk measure. Explain that standard Sharpe specifically uses standard deviation, while the implemented user-risk mode is the requested custom return/risk ratio. Do not replace the user's risk definition with volatility.

## Plan committed before implementation

Keep the existing view-only pie/target rings and gas labels. Add a compact read-only caption for the saved target allocation's risk model, selected user risk and return/risk score, or historical Sharpe with its actual observation period. Show an honest unset state for the current manual portfolio; do not invent risk inputs or enable a policy just to populate the display. Preserve distinction between target-model metrics and actual holdings, ratio units and percentages, user horizon and historical observation period.

Extend only the compact public status projection needed by the caption; do not fetch history, run optimization during rendering, expose full history, add controls or alter trading. Use focused renderer/projection tests and native browser inspection of the current manual state plus an isolated synthetic managed preview. Reload only the chart process if its server needs the new public projection, preserving the funded runner and its records. Record aggregate validation and push under existing authorization.

## Delegation

Root implements the visual caption and verifies the browser. Independent agents review layout, extend the read-only summary and add focused renderer regressions. No live policy or target mutation is part of this work.
