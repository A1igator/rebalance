# Deterministic launch

The user-facing command is a bare **`$rebalance`**. Once its project hook is loaded and trusted, Codex routes the submitted command to application code before the model chooses tools:

```text
UserPromptSubmit → exact bare-command check → locked dependency setup
                 → launch → saved config / receipt check / chart / runner
                 → structured public result → conversation
```

The handler does not call an LLM. It recognizes the literal text `$rebalance` with optional surrounding whitespace. It does not match `$rebalance status`, a quoted command, natural language, a notification prompt, an unrelated hook event or a Plan-mode request. No command is assembled from user text. The selected project must match the hook script's repository, and the event must supply session/turn identity. The launch request is recorded before side effects; replaying that request cannot resume a runner stopped afterward.

## Hook review

The project definition is [`.codex/hooks.json`](../.codex/hooks.json), with code in [`scripts/rebalance-hook.mjs`](../scripts/rebalance-hook.mjs). It can start automatic real-money trading under the saved configuration after the user trusts it and explicitly submits the bare command. It is not a display-only integration.

Codex requires the user to review/trust a new or changed non-managed hook. The documented CLI interface is `/hooks`; hook review is native setup, not an application CLI command. Project trust and any managed hook restrictions also apply. We do not change trust hashes, approval settings or global configuration. If the current host has not loaded or trusted the definition, editing the skill does not make it run. [Official hook review](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks)

This is a `UserPromptSubmit` hook, not a dedicated skill-invocation lifecycle event. Codex documents the `prompt` field and ignores configured `matcher` values for this event, so exact filtering is done in code. Tests cover the documented literal prompt payload. Desktop skill-picker payload serialization and actual hook dispatch still need user-side verification; do not infer those from fixture tests or from an ordinary model tool call. [Official event contract](https://learn.chatgpt.com/docs/hooks#userpromptsubmit)

## Launcher behavior

`npm run cli -- launch` performs startup through existing typed CLI operations. `launch --setup-only` performs preparation without starting an inactive runner. A fresh configuration requires explicit `--targets`; saved wallet/profile/weights are preserved. Missing input is reported as `needs-input`, not filled with a new example portfolio. The hook installs missing locked dependencies with `npm ci`; the ordinary CLI assumes dependencies are installed.

The launcher checks cached public state, performs normal read-only receipt reconciliation/observation when the runner is inactive, and checks GET `/api/status` against a live owned chart process and the configured chain/wallet/targets. It never replaces an unrelated listener. It starts each missing process once and verifies public readiness. A slow or busy process is reported without spawning a duplicate. Launch serialization and saved spawned PIDs cover the gap before background children acquire their service locks.

Pending transactions and cycle timing are preserved. A newer stop issued during setup wins over the older launch request; the final conditional start compares the saved stop identity under the same short control lock used by `stop`. A changed configuration after preflight blocks that launch. No spending cap, budget accounting, additional per-trade confirmation or LLM trading decision is introduced.

Possible results distinguish `armed`, setup-only `ready`, `starting`, `busy`, `needs-input`, `blocked` and an `already-handled` request. Inspect the accompanying public state and messages. An armed process can still be waiting for a receipt/cooldown or reporting an error. If a start may have occurred but status cannot be reread, the result explicitly says state is unknown; it does not claim trading is unarmed. No launch result proves a mined swap or phone delivery.

The hook does not create Codex notification schedules, pair Remote, open an authenticated phone session or implement a custom bridge. The existing five-minute notification heartbeat remains independent. The agent can display the verified chart and report public results after dispatch. Claude Code retains the shared skill/launcher; this project hook definition targets Codex, and no Claude hook is installed by this change.

The current assistant prepares/tests this integration but does not trust the hook, invoke the funded launcher or submit trades. Hardware/Privy execution remains deferred. Tests use isolated local fixtures and stubbed operations, not sponsor or mainnet execution evidence.
