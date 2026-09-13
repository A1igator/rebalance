# Deterministic strategy sharing

User request: “can you also make share as deterministic as possible if it’s not already”; clarification: “Both, especially chat”.

The chart already copies a locally generated strategy-only code, and CLI share export/import use deterministic parsing and config reads. Keep those paths local. A read-only audit found insertion-order differences and stale asynchronous clipboard feedback after strategy invalidation.

Implement an exact native `$rebalance share` (including canonical skill link plus share), Claude `/rebalance share` and OpenCode `/rebalance share` as read-only export. Resolve only the conversation-selected/unambiguous wallet, use saved configuration and the existing exporter, and return the exact generated code. A missing selection opens the linked selector without guessing, launching, restoring or signing. Natural-language share requests use the same CLI exporter through the skill and never reconstruct the code from prose. Native provenance gates remain in place; no native hook trust changes or live funded-hook invocation occurs during development.

Canonicalize target ordering in chart and CLI codes. Invalidate clipboard feedback when the displayed strategy changes or the view disconnects/hides, and avoid competing copy requests. Preserve clipboard fallback. Share only targets, drift trigger and cycle interval; no addresses, holdings, RPCs, signer details, view capabilities, allocation-model internals or credentials. Import stays preview-first; sharing never applies settings or sends messages to another person.

Use isolated tests for exact/scoped/quoted native command matching, selected-wallet export, no-selection handling, safe failures, no launch/recovery/bootstrap of financial state, cross-harness forwarding, canonical UI/CLI parity and clipboard races. Verify read-only live export against the displayed strategy without changing configuration or clipboard. Commit and push main under standing authorization; preserve unrelated stock-link edits.

## Clarification before native implementation

The user corrected the chat scope: “I meant for inserting a shared piece specially. maybe via userprompt hook?” The primary native operation is therefore an exact pasted `rebalance:v1 ...` code, decoded into an import preview before the model responds. The native-export proposal above is superseded and its adapter draft was discarded. Export remains the existing Share button/CLI; the canonicalization and clipboard corrections still apply.

Add a small read-only `share preview` entry that validates the pasted strategy, pins the selected portfolio and computes the same existing import comparison. Without an attached/unambiguous portfolio it returns the decoded strategy and linked selector, without fabricating comparison results. Exact native prompt handlers pass the code as one argument; no shell interpolation and no --apply. Explicit subsequent application retains existing share import --apply behavior. Claude may require its dedicated project UserPromptSubmit definition; do not change any host trust setting.
