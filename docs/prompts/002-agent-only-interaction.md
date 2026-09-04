# View-only chart and agent interaction — 2026-09-04

## User clarification (verbatim)

> the pie chart is view only. all human interaction should be through the agent

This supersedes the initial plan's chart editor, manual controls and optional-agent interaction design. Historical prompts and the original commit remain intact.

## Applied design

All application requests and reviews, including setup, allocation changes, authorization initiation, pause/resume, revocation and withdrawal, go through Claude Code/Codex. The chart displays snapshots, previews and status only. Typed local operations validate the request and return canonical results. The agent initiates a Ledger flow for protected owner operations; physical confirmation remains on the device. Scheduled rebalances continue with no model input.

The chart receives only read access. It has no editor, action buttons, wallet transport, signing bridge access or mutation credentials. Separate agent control IPC supports immutable proposals, exact reviewed operation references, persistent pause and constrained resume.

## Independent review prompt (verbatim)

> Read-only planning review for new user requirement: 'the pie chart is view only. all human interaction should be through the agent'. Inspect current README.md, PLAN.md, AGENTS.md, CLAUDE.md and docs for material implications. Root is updating them in parallel. Recommend the smallest coherent agent control surface for requests/reviews/pause/resume/revoke/withdraw while Ledger still confirms owner-authorized transactions, daemon remains deterministic, and view UI has no mutations or signing access. Do not edit files. Return any easily missed contradictions or acceptance checks.

The review informed the typed control surface, native Ledger bridge gate, stale-proposal rejection, persistent pause, constrained resume, truthful revocation status and view-only acceptance checks in `PLAN.md`.
