# Deterministic launch

The user-facing command is a bare **`$rebalance`**, typed or selected from the project's skill suggestion. Once its project hook is loaded and trusted, Codex routes the submitted command to application code before the model chooses tools:

```text
UserPromptSubmit → exact bare-command check → locked dependency setup
                 → launch → saved config / receipt check / chart / runner
                 → structured public result → conversation
```

The handler does not call an LLM. It recognizes the literal text `$rebalance` or the standalone Markdown form `[$rebalance](<absolute-repository-path>/skills/rebalance/SKILL.md)`, with optional surrounding whitespace. The placeholder denotes the actual repository path; arbitrary link destinations and alternative spellings are not accepted. This is the canonical linked form observed from the native suggestion in the conversation. The two forms share the same request identity for a given session/turn.

It also recognizes either complete request inside the [observed browser-context framing](prompts/024-browser-context-launch.md): one fixed `in-app-browser-context` block followed by `## My request:` and only the bare command/reference. The disclaimer, source attribute, section labels and closing tag must match exactly; tab count and URL are bounded single-line data and never supply command authority. Extra context lines, nested wrappers, multiple request headings and extra request text are rejected. This is exact text compatibility, not authentication of a wrapper's origin. It does not recursively unwrap context or search for a command substring. LF/CRLF line endings and surrounding whitespace are supported.

It does not match `$rebalance status`, quoted commands, natural language, notification prompts, unrelated links, multiple selections or unrelated hook events. Plan-mode launches return a blocked result. No command is assembled from user text. The selected project must match the hook script's repository, and the event must supply session/turn identity. The launch request is recorded before side effects; replaying that request cannot resume a runner stopped afterward.

## Hook review

The project definition is [`.codex/hooks.json`](../.codex/hooks.json), with code in [`scripts/rebalance-hook.mjs`](../scripts/rebalance-hook.mjs). It can start automatic real-money trading under the saved configuration after the user trusts it and explicitly submits the bare command. It is not a display-only integration.

Codex requires the user to review/trust a new or changed non-managed hook. The documented CLI interface is `/hooks`; hook review is native setup, not an application CLI command. Project trust and any managed hook restrictions also apply. We do not change trust hashes, approval settings or global configuration. If the current host has not loaded or trusted the definition, editing the skill does not make it run. [Official hook review](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks)

### One-time user step

Open Codex CLI in this repository (`codex -C /path/to/rebalance`). At **Hooks need review**, choose **Review hooks**, then review and trust the **UserPromptSubmit** command from **`<repo>/.codex/hooks.json`**, which runs **`scripts/rebalance-hook.mjs`**. If the startup screen is absent, use **`/hooks`** in the CLI. Review the Rebalance entry individually; other installed hooks are unrelated to this setup.

After that, type **`$rebalance`** or select its project skill suggestion in the existing conversation. That is the launch request, including automatic real-money trading under the saved configuration; no separate application CLI command or arming message is part of normal operation. Trusting a hook alone does not submit that launch request. Native hook review is the user action the assistant cannot complete on the user's behalf.

On September 5, the installed CLI **0.148.0** reported hooks enabled and project trust configured. Its documented read-only `hooks/list` method discovered the project hook with **`enabled=true`**, **`trustStatus=untrusted`**, and no load warnings/errors. The native CLI also displayed **Hooks need review**. This establishes individual hook trust as a concrete blocker. [Sanitized evidence](evidence/codex-launch-hook.json)

A later read-only check confirmed **`trustStatus=trusted`**, with the runner still unarmed. The subsequent user message appeared in model-visible input as a Markdown skill link. The original literal-only selector rejects that form in an isolated check; this does not establish the raw native hook input. The [picker correction](prompts/022-skill-picker-launch.md) adds that exact canonical form while keeping the hook definition and native trust settings unchanged. The earlier instruction to avoid selecting the suggestion is superseded.

After that correction, another user suggestion submission still produced no hook result in the conversation, and public status remained unarmed. A fresh read-only discovery query using the **Desktop app's bundled 0.153.1 engine** also reported the hook trusted/enabled with no load errors; the standalone CLI is 0.148.0. Trust is no longer the demonstrated blocker. This discovery query does not report execution or prove the active conversation loaded the hook. [Updated evidence](evidence/codex-desktop-dispatch.json)

A later submission after the requested reload check created a real diagnostic at **2026-09-05T16:29:47.059Z**: `UserPromptSubmit`, `promptLength=477`, `promptFormat=other-with-command`, `selection=ignored`, `workspace=inside`, `planMode=false`. Native hook entry is now established; launcher dispatch is not. The model-visible input includes the browser-context framing above, so support for that exact framing is the next candidate correction. Raw payload equality was not measured or captured. [Entry evidence](evidence/codex-browser-context-entry.json)

Attempting to open native review by resuming this same conversation in a separate CLI process was rejected because the Desktop app already had an active writer. The process exited without a trust change or launch. Use native review in a CLI opened for this one-time setup, then keep portfolio interaction in the existing conversation. No active-session lock, trust record or approval setting should be edited to work around the error.

This is a `UserPromptSubmit` hook, not a dedicated skill-invocation lifecycle event. Codex documents the `prompt` field and ignores configured `matcher` values for this event, so exact filtering is done in code. Tests cover direct and browser-context-framed `prompt` values through isolated dispatch. The framing was observed in model-visible input; no raw native hook payload was captured. Actual Desktop-to-launcher dispatch remains unresolved despite verified hook entry; do not infer it from fixture tests or from an ordinary model tool call. [Official event contract](https://learn.chatgpt.com/docs/hooks#userpromptsubmit)

### Local entry diagnostic

The [dispatch observation change](prompts/023-desktop-dispatch-observation.md) writes one best-effort `last-hook-observation.json` under the ignored application data directory (`.local/` by default) when the hook receives parseable JSON. It replaces the prior record atomically with mode 0600. It records timestamp, opaque session/turn hash, prompt format/length, event/workspace classification and the existing selector's decision. It contains no prompt text, raw identities, paths, credentials, environment dump or exception text. No telemetry is sent.

Read this local file when a user invocation has no hook result. `selection=ignored` with `promptFormat=other-with-command` is evidence of unmatched input reaching the script, not authorization to strip arbitrary text or launch it. Supported framing is classified as `ambient-typed` or `ambient-canonical-skill-link`. `selection=selected` with `workspace=inside` establishes matching entry only, not successful startup. Use actual public status and structured launch results for arming/receipt claims. Another prompt may replace the record; compare its timestamp and opaque request identity before attributing it to an invocation. Missing/stale data is inconclusive if entry or diagnostic writing failed. Never replay a funded event to populate this file.

The diagnostic runs alongside the existing handler and cannot change its decision when writing fails. Malformed JSON still follows the existing structured input-error path. The hook definition, accepted launch forms, stop-generation handling, deduplication and native trust settings are unchanged. Only the user's next native submission can supply fresh host evidence; an isolated test cannot.

The official app-server API exposes live `hook/started` and `hook/completed` notifications. Its bundled 0.153.1 schema has no historical hook-run query or hook reload method. Persisted `hookPrompt` items can establish emitted context, but their absence cannot distinguish a missing run from a silent no-match. Official documentation does not establish that restarting the app is required or sufficient, so a restart is not a verified fix. [App-server events](https://learn.chatgpt.com/docs/app-server)

## Launcher behavior

`npm run cli -- launch` performs startup through existing typed CLI operations. `launch --setup-only` performs preparation without starting an inactive runner. A fresh configuration requires explicit `--targets`; saved wallet/profile/weights are preserved. Missing input is reported as `needs-input`, not filled with a new example portfolio. The hook installs missing locked dependencies with `npm ci`; the ordinary CLI assumes dependencies are installed.

The launcher checks cached public state, performs normal read-only receipt reconciliation/observation when the runner is inactive, and checks GET `/api/status` against a live owned chart process and the configured chain/wallet/targets. It never replaces an unrelated listener. It starts each missing process once and verifies public readiness. A slow or busy process is reported without spawning a duplicate. Launch serialization and saved spawned PIDs cover the gap before background children acquire their service locks.

Pending transactions and cycle timing are preserved. A newer stop issued during setup wins over the older launch request; the final conditional start compares the saved stop identity under the same short control lock used by `stop`. A changed configuration after preflight blocks that launch. No spending cap, budget accounting, additional per-trade confirmation or LLM trading decision is introduced.

Possible results distinguish `armed`, setup-only `ready`, `starting`, `busy`, `needs-input`, `blocked` and an `already-handled` request. Inspect the accompanying public state and messages. An armed process can still be waiting for a receipt/cooldown or reporting an error. If a start may have occurred but status cannot be reread, the result explicitly says state is unknown; it does not claim trading is unarmed. No launch result proves a mined swap or phone delivery.

Handled hook failures return structured public context with hook-process exit code zero so the host can deliver the result. Failures before launcher dispatch report `blocked` and the failed phase; failures after dispatch report `starting` with `status=null`, explicitly preserving unknown trading state. Caught exceptions, event text and child stderr are never copied into those messages. Hook discovery/trust failures and a missing executable happen before this handler can report anything; inspect native hook review for those.

The hook does not create Codex notification schedules, pair Remote, open an authenticated phone session or implement a custom bridge. The existing five-minute notification heartbeat remains independent. The agent can display the verified chart and report public results after dispatch. Claude Code retains the shared skill/launcher; this project hook definition targets Codex, and no Claude hook is installed by this change.

The current assistant prepares/tests this integration but does not trust the hook, invoke the funded launcher or submit trades. Hardware/Privy execution remains deferred. Tests use isolated local fixtures and stubbed operations, not sponsor or mainnet execution evidence.

## User-issued launch and explicit recovery

On September 5, a later user-issued literal `$rebalance` produced the native structured launch result with `outcome=armed`. Read-only local status confirmed the active runner; a subsequent RPC check verified a successful Apple swap receipt. The next transaction is unresolved and prevents further stock purchases. This establishes the actual literal command path, not every native picker/framing path or a completed rebalance. Earlier discovery and failed-entry checks above remain historical evidence.

The exact **`$rebalance recover`**, or the canonical project skill reference followed by ` recover`, now has a separate deterministic route to `recover --cancel`. The same exact ambient framing, project/identity checks, Plan barrier and pre-bootstrap stop capture apply. Bare launch never cancels. Other scoped/natural-language/notification prompts remain ignored. Diagnostic prompt formats for this route start with `recovery-`; observations still contain no prompt text or secrets.

Read [the recovery action and limits](RECOVERY.md) before using it. This explicit user operation can pay gas to cancel an uncertain send at its original nonce, and resumes only a previously active runner after verified resolution with no newer stop. It journals request identities and both transaction hashes; an uncertain send or resume is never blindly retried. A lost subprocess result reports `unknown`. The conversation reports the structured result and does not invoke recovery again. Read-only CLI `recover` assesses without these effects.

The native hook definition and trust settings are unchanged. Preparation and isolated tests do not establish that a funded cancellation was submitted or that trading resumed; only a subsequent user-issued command can produce that evidence. See [prompt 025](prompts/025-stalled-rebalance-recovery.md).
