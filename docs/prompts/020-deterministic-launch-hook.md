# Deterministic launch and prompt hook — 2026-09-05

Exact human requests:

> It should all be maximally deterministic btw right. Like if hooks can be used to arm everything on skill call they should

> The skill needs to ensure you do activate real money trading without manual CLI needed from the user hence why

> Can we do skill invocation -> deterministic handler without LLM decision?

> Yeah make that wiring. I can just run the skill myself after it's done

The intended product command remains one explicit user invocation that initializes and arms the app. The implementation moves repeatable startup decisions from skill prose into application code. A Codex `UserPromptSubmit` command hook recognizes only the bare command and invokes the deterministic launcher directly, then returns public results to the conversation. This is prompt routing, not a documented dedicated skill-invoked event. Scoped status, configuration and notification prompts must not launch anything.

Preparation scope: a small launcher built on existing CLI operations, exact hook dispatch, dependency bootstrap, and fixture tests. The launcher preserves saved wallet/profile/targets, pending transactions, cadence and existing processes. It checks the local chart's public status and actual runner state, and never interprets spawn acknowledgement as a completed trade. Missing allocation is reported for the user/agent to supply; no new default weights are invented. Native Codex/Claude notification setup and phone pairing remain host features outside the trading graph.

Root prepares the hook definition for user review. Codex's official hook trust requirement remains in force; root does not trust the hook, alter trust/approval settings, invoke the funded launcher or submit a trade. No fallback through another agent or notification schedule is used. The user must review/trust the new definition before it can run. Actual desktop skill-picker payload handling and funded execution must not be claimed from fabricated hook input tests.

An implementation agent owns `src/launch.ts` and its isolated tests; root owns CLI integration, hook/bootstrap code, routing tests, skill and active documentation, combined validation and provenance. Tests use temporary directories and stubbed network/child operations. Prior plans and prompts remain in history.

Primary source: [Codex hooks](https://learn.chatgpt.com/docs/hooks), fetched September 5, 2026. It documents `UserPromptSubmit.prompt`, command handlers, hook trust and the fact that event matchers are ignored for prompt submission, so filtering belongs inside the handler.
