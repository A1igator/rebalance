# Skill-picker launch — 2026-09-05

## Human request

> I can't make it work with the skill suggestion?

The preceding user invocation arrived in the conversation as `[$rebalance](<repo>/skills/rebalance/SKILL.md)`, with the repository's absolute path in the link destination. The user wants the native suggestion to perform the same full launch as typed `$rebalance`.

## Evidence and plan

The latest read-only CLI discovery reports the project hook **trusted**, enabled and free of load errors. Public app status still reported **unarmed**; the chart and existing notification heartbeat were available. A pure selector check confirmed that the received Markdown link form does not match the original literal-only selector. No raw native hook payload was captured, so this is an unsupported input form observed in the conversation, not proof of every Desktop serialization detail.

1. Accept either the typed bare command or one exact Markdown skill reference pointing to this repository's canonical `skills/rebalance/SKILL.md`.
2. Preserve exact matching: no arbitrary destinations, extra prose, scoped operations, multiple references, quoted forms or natural-language launch inference. Keep workspace checks, Plan-mode handling, stable request identity and launch recovery unchanged.
3. Test matching and real hook-to-CLI dispatch only with isolated unconfigured state, blocked network and stubbed execution. Never replay the actual funded invocation.
4. Update active skill/docs to support suggestion selection, record validation and commit/push on main. Keep the native hook definition and its trust/approval settings unchanged. The user's next invocation is the native end-to-end check.

The accepted linked form supersedes the earlier instructions requiring the user to avoid the skill suggestion. Both forms remain a single explicit application launch request; loading a skill for reference or handling notification text remains separate.
