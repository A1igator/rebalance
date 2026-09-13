# Deterministic portfolio selector presentation

User request: “also what ‘no trusted hook result’” and “it should open the browser with portfolios deterministically tbh”. This continues the remembered-running startup work in prompt 085.

Observed failure: the referenced Open Rebalance selector task received a generic view-unavailable result and interpreted the empty restoration-results array as an empty wallet registry. A read-only check found three registered wallets. Localhost identity requests returned EPERM in the restricted command environment and HTTP 200 for all four chart services outside it. Missing hook output alone does not establish hook trust or dispatch state.

Implementation plan:

- Preserve specific, sanitized view failures through app entry and the CLI. Local access denial must never be treated as listener absence or trigger a duplicate service.
- Separate restoration results from wallet inventory and avoid declaring the selector ready when preparation failed.
- Make browser presentation an explicit launch-result handoff, preserving the complete conversation-linked URL and right-side host pane. Use a supported deterministic native host adapter where one exists; otherwise accurately identify the host-tool handoff rather than inventing a shell/IPC/deep-link API.
- Update the skill to open the returned selector immediately and quietly. On proven local permission denial, retry only read-only view preparation through the host approval mechanism. Do not repeat launch, restoration, Start or recovery.
- Keep saved running/Stop preferences, request deduplication, portfolio selection, and trading behavior unchanged. Inspect native hook state only through a read-only API; do not change trust or execute a funded hook while developing.
- Test error propagation, nonempty registries in setup-only entry, presentation handoff and no duplicate/spurious financial actions using isolated fixtures. Verify the live linked selector using read-only preparation and the native Browser tool, then commit and push to main.
