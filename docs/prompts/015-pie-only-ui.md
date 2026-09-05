# Pie-only local UI — 2026-09-04

Exact human request:

> also can we keep the UI super simple. As simple as just the pie chart and no header, footer, other sections

The assistant stated that the UI would become one pie chart with ticker/percentage labels and no header, footer or other sections. While the wallet is empty, the chart displays the saved allocation explicitly labeled as targets, never simulated holdings. Once funded, it displays current holdings. All commands, wallet details, graph inspection and operation status remain in the agent conversation.

Material delegated task: replace only `ui/index.html`, `ui/app.js` and `ui/style.css` with one centered accessible SVG pie/donut. Remove dashboard cards, tables, wallet/graph blocks, navigation and controls. Derive tickers/weights from GET `/api/status`, refresh every five seconds and keep all assets local. Distinguish targets, current holdings and last-known/unavailable data; retain the last successful view on a fetch failure with a visible in-chart stale indication. Validate JavaScript syntax and leave final browser inspection to root. No portfolio configuration, other application code, signing or commit work was delegated to the UI agent.

The simplification preserves the view-only boundary and deterministic monitoring. The allocation remains in [the current demo record](../DEMO_PORTFOLIO.md); no branding graphics, remote fonts, external UI library or application telemetry is added.

Execution record: the delegated UI task made no file changes before interruption. Root implemented the three UI files and checked JavaScript syntax plus the live browser accessibility state. The final browser showed only the chart, with the current technology targets and explicit empty-wallet labeling.
