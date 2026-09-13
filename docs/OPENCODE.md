# OpenCode integration

OpenCode uses the same local portfolio registry, deterministic runner, CLI and companion as Codex and Claude Code. Each conversation selects its own wallet; every portfolio keeps independent execution state. The integration is checked against **OpenCode 1.18.30** and requires the project's **Node.js 24+** runtime on `PATH`.

## Use it

Open this repository in OpenCode:

```sh
cd /path/to/rebalance
opencode
```

Use the root **Build** agent and submit **`/rebalance`**. If OpenCode was already running when these files were added, reopen it in this repository so it loads the local plugin and command. Review any native project/plugin consent in the host; this repository does not edit global permissions or trust. The existing model/provider setup belongs to OpenCode.

A bare invocation opens the linked selector and restores only portfolios whose saved running preference is enabled. Explicitly stopped, never-started and unknown portfolios remain stopped. Selecting a card connects this conversation immediately without another skill invocation; Start is available for a portfolio that the user wants to enable. Ledger transactions retain physical confirmation. Setup buttons create unarmed portfolios, and settings, transactions, recovery and cadence are preserved. See [remembered startup](LAUNCH.md#remembered-background-startup).

`/rebalance status` and other scoped requests use the canonical skill for the named operation. Loading the skill as reference does not trigger the native launcher. A missing native result is an incomplete integration, not permission for the model to reconstruct startup. Do not repeat a launch already reported by the plugin.

The project's existing `.agents/skills/rebalance` and `.claude/skills/rebalance` links expose the canonical `skills/rebalance/SKILL.md` through OpenCode's documented discovery paths. There is no separate copied skill or required MCP server.

## Native command path

- `.opencode/commands/rebalance.md` declares the shell-free command template. It does not force a Plan session into Build.
- `.opencode/plugins/rebalance.ts` is the auto-loaded entry; OpenCode does not discover a `.mjs` plugin file in that folder.
- `src/opencode-plugin.ts` correlates `command.execute.before` with `chat.message` using a short-lived, one-use opaque marker. It checks the resolved user message ID, same native session, root session directory and Build agent. Plain text, replayed/forged markers, attachments, child sessions, Plan/custom agents and scoped arguments cannot become a bare launch.
- `scripts/rebalance-opencode-hook.mjs` passes the verified internal envelope into the shared handler, which persists the native request's wallet route before bootstrap. Duplicate requests retain their original wallet and cannot reinterpret a later selection or bypass a newer stop.
- The plugin starts that adapter through **Node** with fixed argv and bounded JSON stdin. OpenCode runs plugins in Bun; its `process.execPath` points at the OpenCode executable and must not launch our Node CLI.

Native `command.execute.before` has no resolved message ID. `chat.message` may also lack `input.messageID`; `output.message.id` is the actual native ID. Neither prompt text nor a model's skill-tool call independently grants native command provenance. This protects the Rebalance entry contract, not OpenCode's general shell permissions or command-template engine.

The launcher returns public structured state before the model chooses tools. The model explains that result; it does not decide rebalance timing, prices, transaction order or recovery. An armed result is not a trade receipt. Hardware/provider confirmation requirements are unchanged.

## Wallet selection and companion

The plugin supplies `REBALANCE_SESSION_ID=opencode:<native-session-id>` and the portfolio root to each native shell invocation, clearing inherited foreign profile and Codex/Claude selectors. Ordinary CLI calls resolve that conversation's current connection on every invocation; no global selected wallet is introduced. Explicit `--profile` still scopes a single operation.

Linked view records carry an OpenCode delivery kind bound to that namespace. Selector clicks and deterministic new-wallet setup update the same connection record. The plugin refreshes public selection context before model work and watches local connection changes to attach relevant event streams. It also retains the immutable launch route, covering a sole-profile default and a wallet change during startup. Earlier event streams remain tied to their originating wallet even when the chart selects another one.

In an existing cmux terminal, the launch wrapper opens/reuses the same [companion browser helper](COMPANION_VIEW.md). Otherwise it returns the complete local URL, including its conversation fragment, for the available browser. This implementation does not establish a built-in OpenCode side pane or a phone connection.

## Retained events

The plugin owns event delivery inside the running OpenCode process. `src/opencode-notifications.ts` watches the existing local queues and calls SDK v1 `session.promptAsync` only for retained actionable events. Automatic read/quote retries and successful recovery are filtered locally. There is no scheduled model sweep and no Codex queue, Claude MCP relay or standalone chat backend.

These native commands are handled without a model tool decision:

| Command | Effect |
| --- | --- |
| `/rebalance notifications pause` | Close this conversation's event streams and persist the paused preference. Trading is unchanged. |
| `/rebalance notifications resume` | Reopen streams for this conversation's bound/selected portfolios. Trading is unchanged. |
| `/rebalance notifications status` | Report the enabled/paused preference. This is not proof of transport or phone delivery. |

A bare `/rebalance` first connects events, but preserves an existing paused preference. On host restart, enabled bindings reconnect on the next native message or command in that conversation. OpenCode must be running for chat delivery; local runners are independent and events remain retained while it is closed. The plugin does not discover or resume unrelated sessions.

Each send freezes the native session, native instance directory, repository root and originating wallet. A durable journal records an ordered native message ID before dispatch. The retained event is checked again immediately before sending, so acknowledgement or local filtering can veto it. Native acceptance does not acknowledge the application event. The notification supplies exact wallet-scoped `events`, `status` and acknowledgement commands for the reporting turn.

An uncertain send keeps a durable no-resend barrier. A bounded native message read can reconcile only the exact message ID and owned notification marker; absence from that history does not establish rejection. Requests have bounded deadlines. A timed-out stream closes and retains its journal/events; a later pause/resume or reopened host can reconnect without blindly repeating an uncertain message. Acceptance, a running plugin and acknowledgement do not prove a phone push.

## Validation and limits

The tagged native API/source and installed OpenCode 1.18.30 were checked. A disposable native project loaded the actual plugin entry and unchanged command template, with injected launch/notification effects. A Build/root bare command invoked the launch stub exactly once; metadata survived the native command-to-message boundary, and the public result replaced the marker. Status, Plan, child-session and unmarked-text cases did not launch. A real native shell subprocess received the namespaced identity and isolated paths. The harness stopped before any model loop and used no live account credentials.

Separate adapter tests exercise the real shared launcher only against empty temporary storage, where it returns `needs-input`, and verify deduplication after a newer stop. Unit tests cover command provenance, wallet selection races, view setup, delivery filtering, uncertain sends, exact acknowledgement scope and disposal. See [AI usage](AI_USAGE.md) for final check results. No real wallet launch, signature, swap, model notification or phone delivery is claimed from these fixtures.

No production package or lockfile dependency was added. The integration uses the host's injected SDK client and Node built-ins; OpenCode's tagged source is used as API reference, not vendored code.

Sources: [OpenCode skills](https://opencode.ai/docs/skills/), [commands](https://opencode.ai/docs/commands/), [plugins](https://opencode.ai/docs/plugins/), [SDK](https://opencode.ai/docs/sdk/), and the official 1.18.30 [plugin interfaces](https://github.com/anomalyco/opencode/blob/v1.18.30/packages/plugin/src/index.ts), [native prompt path](https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/src/session/prompt.ts) and [message IDs](https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/src/id/id.ts).
