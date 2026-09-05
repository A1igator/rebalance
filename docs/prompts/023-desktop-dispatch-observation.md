# Desktop dispatch observation — 2026-09-05

## Human input and observed result

The user submitted the canonical Rebalance skill suggestion again after the picker correction in [prompt 022](022-skill-picker-launch.md). It appeared in model-visible input as `[$rebalance](<repo>/skills/rebalance/SKILL.md)`. No deterministic hook result reached the conversation; public status still reported `armed=false` and the event queue was empty.

The installed standalone CLI is 0.148.0; the running Desktop app bundles 0.153.1. A fresh, short-lived process of the bundled engine reported hooks enabled and discovered the project hook as trusted/enabled, with the same definition hash and no warnings/errors. That read-only query does not establish the active conversation's loaded state or actual hook execution. Narrow current-day host-log checks found no hook execution metadata; absence of logging is inconclusive.

Official docs and the bundled engine's generated protocol expose live `hook/started` and `hook/completed` notifications, but no historical hook-run query. They do not establish that a restart is required or sufficient. Model-visible wrappers also do not establish the raw native `prompt` field. Do not broaden trading matches or assert a Desktop cause from those observations.

## Preparation plan

1. Add a best-effort, bounded local observation of hook entry before launch selection. Record only timestamp, an opaque session/turn identity, input format/length, workspace classification and whether the existing selector matched or blocked. Never store prompt text, raw paths, credentials, environment contents or exception text.
2. Write one replacement JSON record under the ignored application data directory. Diagnostic failures must not alter launch, stop-generation, deduplication or error behavior. Keep the exact selector, hook definition and native trust settings unchanged.
3. Test actual entry only with isolated unconfigured data and blocked network, plus scoped/no-match prompts and failed diagnostic writes. Do not replay the funded user request, trust a hook, start a runner or submit transactions.
4. Correct active documentation to distinguish trusted discovery from native dispatch, commit the prompt/evidence/provenance, and leave the next actual user submission as the host check. No fixture result proves Desktop dispatch or a live trade.

Delegated read-only review checked official docs and the exact Desktop 0.153.1 schema for hook run-history/reload APIs. It did not start/resume a conversation, execute a hook or change settings.
