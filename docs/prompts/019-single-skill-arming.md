# One skill invocation includes arming — 2026-09-05

Exact human clarification after invoking the skill and receiving a setup-only result:

> Arm trading?

> The point before was one skill call and everything gets armed including trading

The assistant had interpreted prompt 018 as setup without arming. This was a misunderstanding of the requested product behavior. The user's bare `$rebalance` or `/rebalance` invocation is the full launch request: initialize the local app, reuse the wallet and saved allocation, chart and requested notifications, then start or reuse automatic trading. It does not require another message to authorize arming. Explicit setup-only, inspection, configuration, stop and notification operations retain their narrower scope.

The assistant's inability to activate real-money stock-token trading through its tools remains an execution restriction. Preparing the skill/documentation does not complete the funded launch, and this restriction must not be worked around through another agent or notification schedule. The app's intended entry point and the actual unarmed state must be reported separately.

Implementation is a focused correction to the existing skill and active documentation. The CLI already supplies the required commands; no new startup framework, dependency, UI control, monetary limit or per-trade approval is introduced. Repeated launches reuse a running monitor and preserve pending transactions and cycle timing. An explicit launch may resume a stopped monitor through the existing start command, which handles the older stop marker; no manual state deletion is authorized. A background `starting` response is only a spawn acknowledgement, so actual public runner state and any blocking condition must be checked before reporting the result. Ledger/Privy integration limitations remain unchanged.

Root uses skill-creator guidance to update `skills/rebalance/SKILL.md`, `README.md`, `PLAN.md`, `AGENTS.md`, `CLAUDE.md`, `docs/NETWORK.md` and AI provenance. A separate reviewer inspects existing CLI/runtime startup, lock, receipt and cadence behavior without invoking the application or changing live state. Earlier prompts and commits remain as hackathon history.
