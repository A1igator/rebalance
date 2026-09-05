# Deterministic launch

The user-facing command is a bare **`$rebalance`**, typed or selected from the project's skill suggestion. Once its project hook is loaded and trusted, Codex routes the submitted command to application code before the model chooses tools:

```text
UserPromptSubmit → exact bare-command check → locked dependency setup
                 → launch → saved config / receipt check / chart / runner
                 → structured public result → conversation
```

The handler does not call an LLM. It recognizes the literal text `$rebalance` or the standalone Markdown form `[$rebalance](<absolute-repository-path>/skills/rebalance/SKILL.md)`, with optional surrounding whitespace. The placeholder denotes the actual repository path; arbitrary link destinations and alternative spellings are not accepted. This is the canonical linked form observed from the native suggestion in the conversation. The two forms share the same request identity for a given session/turn.

It does not match `$rebalance status`, quoted commands, natural language, notification prompts, unrelated links, multiple selections or unrelated hook events. Plan-mode launches return a blocked result. No command is assembled from user text. The selected project must match the hook script's repository, and the event must supply session/turn identity. The launch request is recorded before side effects; replaying that request cannot resume a runner stopped afterward.

## Hook review

The project definition is [`.codex/hooks.json`](../.codex/hooks.json), with code in [`scripts/rebalance-hook.mjs`](../scripts/rebalance-hook.mjs). It can start automatic real-money trading under the saved configuration after the user trusts it and explicitly submits the bare command. It is not a display-only integration.

Codex requires the user to review/trust a new or changed non-managed hook. The documented CLI interface is `/hooks`; hook review is native setup, not an application CLI command. Project trust and any managed hook restrictions also apply. We do not change trust hashes, approval settings or global configuration. If the current host has not loaded or trusted the definition, editing the skill does not make it run. [Official hook review](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks)

### One-time user step

Open Codex CLI in this repository (`codex -C /path/to/rebalance`). At **Hooks need review**, choose **Review hooks**, then review and trust the **UserPromptSubmit** command from **`<repo>/.codex/hooks.json`**, which runs **`scripts/rebalance-hook.mjs`**. If the startup screen is absent, use **`/hooks`** in the CLI. Review the Rebalance entry individually; other installed hooks are unrelated to this setup.

After that, type **`$rebalance`** or select its project skill suggestion in the existing conversation. That is the launch request, including automatic real-money trading under the saved configuration; no separate application CLI command or arming message is part of normal operation. Trusting a hook alone does not submit that launch request. Native hook review is the user action the assistant cannot complete on the user's behalf.

On September 5, the installed CLI **0.148.0** reported hooks enabled and project trust configured. Its documented read-only `hooks/list` method discovered the project hook with **`enabled=true`**, **`trustStatus=untrusted`**, and no load warnings/errors. The native CLI also displayed **Hooks need review**. This establishes individual hook trust as a concrete blocker. [Sanitized evidence](evidence/codex-launch-hook.json)

A later read-only check confirmed **`trustStatus=trusted`**, with the runner still unarmed. The subsequent user message arrived in the conversation as a Markdown skill link, which the original literal-only matcher rejected. The [picker correction](prompts/022-skill-picker-launch.md) adds that exact canonical form while keeping the hook definition and native trust settings unchanged. The earlier instruction to avoid selecting the suggestion is superseded.

Attempting to open native review by resuming this same conversation in a separate CLI process was rejected because the Desktop app already had an active writer. The process exited without a trust change or launch. Use native review in a CLI opened for this one-time setup, then keep portfolio interaction in the existing conversation. No active-session lock, trust record or approval setting should be edited to work around the error.

This is a `UserPromptSubmit` hook, not a dedicated skill-invocation lifecycle event. Codex documents the `prompt` field and ignores configured `matcher` values for this event, so exact filtering is done in code. Tests cover literal and canonical linked `prompt` values through isolated dispatch. The link was observed in model-visible input; no raw native hook payload was captured. Actual Desktop dispatch still needs the user's next invocation to verify it; do not infer it from fixture tests or from an ordinary model tool call. [Official event contract](https://learn.chatgpt.com/docs/hooks#userpromptsubmit)

## Launcher behavior

`npm run cli -- launch` performs startup through existing typed CLI operations. `launch --setup-only` performs preparation without starting an inactive runner. A fresh configuration requires explicit `--targets`; saved wallet/profile/weights are preserved. Missing input is reported as `needs-input`, not filled with a new example portfolio. The hook installs missing locked dependencies with `npm ci`; the ordinary CLI assumes dependencies are installed.

The launcher checks cached public state, performs normal read-only receipt reconciliation/observation when the runner is inactive, and checks GET `/api/status` against a live owned chart process and the configured chain/wallet/targets. It never replaces an unrelated listener. It starts each missing process once and verifies public readiness. A slow or busy process is reported without spawning a duplicate. Launch serialization and saved spawned PIDs cover the gap before background children acquire their service locks.

Pending transactions and cycle timing are preserved. A newer stop issued during setup wins over the older launch request; the final conditional start compares the saved stop identity under the same short control lock used by `stop`. A changed configuration after preflight blocks that launch. No spending cap, budget accounting, additional per-trade confirmation or LLM trading decision is introduced.

Possible results distinguish `armed`, setup-only `ready`, `starting`, `busy`, `needs-input`, `blocked` and an `already-handled` request. Inspect the accompanying public state and messages. An armed process can still be waiting for a receipt/cooldown or reporting an error. If a start may have occurred but status cannot be reread, the result explicitly says state is unknown; it does not claim trading is unarmed. No launch result proves a mined swap or phone delivery.

Handled hook failures return structured public context with hook-process exit code zero so the host can deliver the result. Failures before launcher dispatch report `blocked` and the failed phase; failures after dispatch report `starting` with `status=null`, explicitly preserving unknown trading state. Caught exceptions, event text and child stderr are never copied into those messages. Hook discovery/trust failures and a missing executable happen before this handler can report anything; inspect native hook review for those.

The hook does not create Codex notification schedules, pair Remote, open an authenticated phone session or implement a custom bridge. The existing five-minute notification heartbeat remains independent. The agent can display the verified chart and report public results after dispatch. Claude Code retains the shared skill/launcher; this project hook definition targets Codex, and no Claude hook is installed by this change.

The current assistant prepares/tests this integration but does not trust the hook, invoke the funded launcher or submit trades. Hardware/Privy execution remains deferred. Tests use isolated local fixtures and stubbed operations, not sponsor or mainnet execution evidence.
