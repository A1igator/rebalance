# Event-based chat delivery and deterministic Claude launch — 2026-09-06

## Human requests

> so finish fully event based chat delivery?

The human reported that Claude interpreted the skill, inspected state, then chose setup-only because it would not start a funded runner, and requested deterministic invocation like Codex. They also confirmed updating this ChatGPT workspace to the repository's new folder.

## Implementation plan

- Replace Claude's two-second queue sweep with filesystem events, immediate startup/reconnect replay, serial delivery and error-only retry. Retain queue entries until explicit agent acknowledgement and distinguish transport acceptance from conversation/phone delivery.
- Add a notification-only Codex event consumer using the native existing-session queue interface over an explicit local app-server socket. Never create a second session/writer as an implicit fallback, relay signing/approval, edit trust or restart trading. Replace the five-minute heartbeat only when the native delivery connection has been demonstrated.
- Wire a user-issued Claude `/rebalance` to deterministic launch through the current native `UserPromptExpansion` event and its `prompt_id`, with exact matching, stop precedence, deduplication, public structured results and no repeated model-selected launch. Keep ordinary scoped requests out of arming. Prepare the native hook definition; do not grant trust or invoke the funded hook on the user's behalf.
- Keep one existing conversation. The rebalancer remains stopped during development. Use isolated tests for financial-path dispatch and an explicitly labelled nonfinancial probe for any actual chat-delivery verification.

The current Desktop instance was observed using a private stdio app server without the shared control socket. Installed Codex CLI queue support alone does not establish connection to this conversation. Resolve and report that host boundary accurately; do not claim local fixture tests establish native delivery or funded activation.

## Official references

- [OpenAI App Server](https://learn.chatgpt.com/docs/app-server)
- [OpenAI background-hook behavior](https://learn.chatgpt.com/docs/hooks#how-background-hooks-run)
- [Claude common hook fields](https://code.claude.com/docs/en/hooks#common-input-fields)
- [Claude user prompt expansion](https://code.claude.com/docs/en/hooks#userpromptexpansion)
- [Claude channel protocol](https://code.claude.com/docs/en/channels-reference)

## Implementation and host findings

The shared file watcher, Claude channel, exact native Claude launch adapter and notification-only Codex consumer are implemented. The CLI exposes notification configure/start/status/stop plus a labelled connection test, and persists enabled/paused preference. The launcher restores only configured enabled notifications and reports them independently of trading. Durable attempts distinguish accepted and uncertain results; known-unsent preparation failures retry, while lost responses after dispatch cannot duplicate a queue submission.

The initially implemented explicit Unix-socket route is blocked by this Desktop build's app-tools override/transport condition. A subsequent version-pinned source check established a simpler supported native path: `codex queue --thread UUID --message ...` appends shared queue storage without resuming/loading the target or acquiring its writer. The temporary native server's cleanup affects only its own loaded threads. Desktop's queue service discovers external revisions on its own ten-second timer; this is native deterministic infrastructure, not a repeated model check. The unused socket/proxy plumbing was removed. [Sanitized evidence](../evidence/codex-event-endpoint.md) records both findings and preserves paused/interrupted native queue behavior.

Claude's hook is prepared for native loading and user review. Fixtures establish the documented event contract, actual script entry against unconfigured temporary storage and deduplication after a newer stop. They do not establish a user-issued native Claude launch. An already running channel loads the new watcher on its next session/reconnect; source edits are not hot-reload evidence. The financial runner remains stopped.

## Native integration probe

After verifying this task's actual UUID with the app tool and an empty retained event queue, root configured and started only the Codex notification listener. `notifications test` published one explicitly nonfinancial retained event. An initially absent executable path produced a known-unsent failure; after resolving the installed CLI path and restarting only notifications, the same retained event was accepted by native Codex with no uncertain delivery. The running listener reports one accepted event and no error. No financial runner, signing hook or wallet secret was accessed.

The test is queued behind the active conversation turn. Its later native arrival, acknowledgement and fallback removal remain separate verification steps; native acceptance alone does not prove processing or phone delivery. The five-minute heartbeat remains active until that arrival. A heartbeat reading the test from local storage must not acknowledge it as delivery evidence. The shared skill documents the required handoff without another user application command.

Final code validation: **359/359 tests**, zero skipped, plus TypeScript and Git whitespace checks. The earlier sandboxed run could not open required local test sockets/watchers; the authorized isolated rerun with those capabilities passed. Tests use temporary storage/fake providers/disposable identities and do not submit live trades. Implementation/source disclosures and subsequent native delivery evidence are kept in `docs/AI_USAGE.md`.
