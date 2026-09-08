# Portfolio controls and funding address — 2026-09-07

## Human requests

> also start/stop running the portfolio should be a button on the top right

> and an easy way to copy the address for funding in the UI

These requests explicitly allow deterministic execution controls in the companion, expanding the earlier navigation/setup exceptions to agent-only interaction. Allocation editing remains through the agent.

## Plan before implementation

- Place a compact Start/Stop control at the chart’s top right, opposite Back, plus a copy-funding-address button showing the displayed wallet’s shortened public address. Confirm clipboard success only after it succeeds; retain selectable full-address fallback if unavailable. Identify Robinhood chain 4663 for funding.
- Bind controls to the chart’s exact wallet/profile, independent of later conversation selection. Reuse existing local same-origin JSON and view-capability checks. Start/Stop requests go to deterministic application code without a model turn, use existing launcher/stop machinery and preserve locks, stop generation, pending transactions, recovery and cadence.
- Show actual runner state, including starting/stopping/unavailable/deferred outcomes. Prevent duplicate clicks and do not interpret request acceptance or stale chart snapshots as a successful launch. Preserve physical Ledger confirmation and accurately expose currently deferred execution support.
- Copying uses only the public wallet address. No keys, credentials, targets or portfolio choices are changed by the copy action.
- Add focused fixture tests for wallet isolation, authorization, duplicate/concurrent controls, state and clipboard failures. Inspect the live UI without activating Start/Stop. If needed, reload only verified chart processes; do not start/stop a live runner for QA.
- Update product/skill guidance, AI provenance and actual validation evidence. No new dependency, hosted service or scheduled model task is planned. Work directly on main and preserve a planning commit before code.
