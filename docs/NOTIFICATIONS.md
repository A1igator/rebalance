# Same-session notifications and Remote Control

The local monitor queues four kinds of operational events:

- `ledger-rebalance-needed`: drift needs attention. The current event hook is implemented; hardware readiness, connection/rejection handling and actual Ledger signing remain deferred. Its message explicitly says hardware setup is pending.
- `rebalance-completed`: the most recent swap has a successful observed receipt with two confirmations, and a subsequent fresh portfolio is within the configured drift threshold. An approval, a submitted swap, stale holdings or untradeable dust cannot produce a completion claim.

- `rebalance-recovered`: a cancelled or reverted nonce has a verified recovery receipt. This is distinct from a completed rebalance and does not request another recovery command.
- `rebalance-attention`: an unresolved/reverted transaction or runtime failure needs attention. Messages use fixed public classifications, never raw provider errors. The event does not authorize a retry or cancellation.

A separate explicit `notifications test` command can publish a `notification-test` for connection validation; the monitor never fabricates one as an operational outcome.

The queue is stored in ignored `.local/events.json`. Ledger alerts are deduplicated per continuing wallet/target condition; completed and recovery events are deduplicated by their receipt hash in separate event namespaces. Attention alerts journal each continuing wallet/failure/hash condition before publication, survive acknowledgement and restart without repeating, and allow a new event after recovery or a changed failure. They are emitted even when receipt reconciliation blocks observation/planning. Events survive the absence of an agent. `npm run cli -- events` reads pending events, and `events ack <id>` records handling in the conversation. It does not prove a phone notification was delivered.

## Claude Code

The optional project `.mcp.json` starts `src/channel.ts` over stdio. It uses the official MCP SDK and Claude's channel extension, with one `acknowledge_event` tool. It exposes no HTTP endpoint, trading tool, key, permission relay or alternative chat interface. Commands still use the project skill and CLI. A notification may cause Claude to respond; that inference is outside the deterministic trading graph. The shared `src/event-stream.ts` watches the parent directory because `events.json` is atomically replaced. It replays immediately after initialization, coalesces file hints and delivers serially. A healthy idle channel has no periodic queue sweep. Read, watcher or delivery failures alone create bounded retries (one second growing to thirty seconds). Watcher reconnection replays changes missed while disconnected. A stalled transport ends its notification subprocess after ten seconds with durable events retained; it never launches a concurrent resend.

Custom channels currently require Claude's research-preview development opt-in. From this repository, start the single interactive session with:

```sh
claude --dangerously-load-development-channels server:rebalance-events --remote-control
```

Claude presents its project/channel consent dialogs locally. The user must accept those in Claude; this project does not change their global agent settings or bypass organization policy. For an already configured running session, `/rc` enables Remote Control for that same conversation. Adding the channel to a session may require restarting/resuming it with the channel flag. The installed development machine has Claude Code 2.1.263; this is an observed version, not a minimum requirement.

For mobile pushes, install/open the Claude mobile app using the same account and organization, allow OS notifications, and enable **Push when Claude decides** in Claude Code's `/config`. Ask the session to notify you when a Ledger rebalance needs attention or a rebalance completes. Remote Control mirrors the local session; the phone does not replace Ledger physical confirmation. The local computer and Claude session must remain running for immediate event delivery.

Claude determines whether/when to push; its docs offer no per-event delivery guarantee. An MCP transport write also does not acknowledge processing. This implementation retains each event until the agent explicitly acknowledges it and replays unacknowledged events in a later channel session. It sends an event once per channel process, rather than repeatedly waking Claude while the event remains unacknowledged.

## Codex: file events into this conversation

The notification-only worker watches the same durable queue and uses installed Codex's native command:

```text
file replacement → serial event reader → codex queue --thread UUID
                 → native shared queue storage → existing Desktop conversation
                 → model reports and acknowledges the retained event
```

Configuration binds one existing thread UUID and a Codex executable. The worker passes fixed arguments directly to `codex queue --thread UUID --message ...`; it neither resumes/creates a thread nor starts a model itself. Native Codex reads existing metadata and persists a queued submission without acquiring that thread's active writer. Its short-lived local server can then exit without stopping Desktop's conversation. No daemon setup, public port, custom MCP relay, copied app credential or trust/approval change is needed. [Version-pinned native evidence](evidence/codex-event-endpoint.md)

Our worker has **no healthy queue-sweep timer**: startup replay and filesystem changes drive it, and bounded retries occur only after actual failures. Inside the installed Codex runtime, a **ten-second shared-queue revision check** discovers additions made by another process. This is deterministic native infrastructure, not a scheduled LLM prompt/check, but it means the complete Desktop path is not literally event-only. Normal idle conversations then wake; active turns finish first. An interrupted conversation deliberately retains a paused queue, and this worker never overrides that interruption. Busy turns, host availability, I/O and model reporting can add delay; ten seconds is not a delivery guarantee.

The ignored local binding stores enabled/paused preference and a stop generation. Separate worker/launch locks, a process record and durable delivery journal prevent duplicate workers and blind resends. Explicit notification stop persists the paused preference; an ordinary full/setup-only launcher restores only a previously configured, enabled listener. Notification setup is reported separately and never alters the trading outcome, account, targets, cadence or financial control records.

A delivery attempt is journaled before dispatch. Strict native acceptance is recorded and suppresses repeat submissions across worker restarts until the conversation acknowledges the event. Known-unsent preparation/executable failures can retry. A lost/ambiguous response or persistence failure after dispatch remains **uncertain**; status exposes it, and the worker does not blindly resend. The application event remains available for ordinary reading/acknowledgement. Receipt in the native queue is distinct from conversation processing and phone delivery.

The conversation reads `events` and local `status`, reports only meaningful new completion/recovery/Ledger/runtime-attention information, then acknowledges the exact retained ID. A `notification-test` is explicitly a nonfinancial connection check, not a rebalance outcome. Notification text never requests launch/recovery/start/stop, target changes, signing, submission or credential access; exact bare-command launch hooks do not match it.

### Agent command interface

Run these through the existing conversation from the project:

```sh
npm run cli -- notifications configure --thread <existing-thread-UUID>
npm run cli -- notifications start --background
npm run cli -- notifications test
npm run cli -- notifications status
npm run cli -- notifications stop
```

An optional `--codex /absolute/path/to/codex` chooses the native executable. Configure never arms trading. After initial setup, ordinary launch restores the enabled listener automatically; it does not require another schedule or targeting decision. `notifications start --background --enabled-only` is the launcher's internal path and preserves paused preference. A running worker alone is not delivery evidence: inspect error, accepted and uncertain IDs. `notifications test` publishes a clearly labelled retained test event; only its later appearance in the conversation establishes delivery.

### Desktop compatibility and migration

Observed versions are Codex CLI **0.153.4** and Desktop engine **0.153.1**. Their native queue service implementations are identical. The initially investigated explicit Unix-socket route is blocked by this Desktop build's app-tools override/transport condition; changing workspace or restarting with a daemon flag does not fix that route. The selected shared-queue path avoids that condition and needs no Desktop patch or daemon. [Sanitized source findings and limits](evidence/codex-event-endpoint.md)

Keep the existing **Rebalance notifications** five-minute heartbeat only until an actual native test reaches this same conversation. Once that event is observed and acknowledged, remove the matching fallback through the native automation tool, preserving notification intent. Do not install another periodic model check. Queue acceptance alone does not establish this handoff. A scheduled check must leave `notification-test` entries for their native prompt to handle; reading one from local storage is not transport delivery. The [implementation record](prompts/035-event-chat-and-claude-launch.md) records current validation/migration status.

### Remote access and phone pushes

Use native **Remote** to continue this existing conversation on ChatGPT mobile. On the desktop host, open **Settings → Connections → Control this Mac or PC → Set up/Add**, approve the app's setup and scan its QR code. Complete pairing using the same account/workspace, then select this conversation under Remote. Keep the host awake, online and running the app. Pairing and phone delivery have not been verified on the user's device. [Official Remote setup](https://learn.chatgpt.com/docs/remote-connections)

The local watcher and queue submission are deterministic. Conversation reporting uses a model, and phone pushes depend on native account/app/OS settings. Queue acceptance and event acknowledgement never prove a phone push. Codex's outgoing `notify` hook is the opposite direction; background-hook output also waits for a later user turn and cannot itself wake this idle conversation. No such global hook is installed. [Notification direction](https://learn.chatgpt.com/docs/config-file/config-advanced#notifications), [background hooks](https://learn.chatgpt.com/docs/hooks#how-background-hooks-run).

## Offline operation

Closing either coding agent does not stop an already armed local raw-key monitor. Receipts, portfolio updates and notifications remain local until consumed. Privy will share the same completion path once its signer is implemented.

## Validation and official references

The automated tests launch the actual Claude stdio MCP server with an MCP client, verify initialization, notification delivery, tool discovery, acknowledgement and replay, and reject an attempted signing-tool call. Shared event retention/deduplication/acknowledgement tests cover the queue consumed by Codex as well. Isolated Codex worker tests cover event retention, fixed typed arguments, accepted/uncertain journals, paused preference, writer isolation, native command arguments and failure behavior. The native heartbeat creation/readback remains earlier app evidence. Actual native-queue-to-Desktop delivery is a separate integration check, not established by mocked queue acceptance. No actual phone push or Ledger device has been verified.

- [Remote Control and mobile push setup](https://code.claude.com/docs/en/remote-control)
- [Channels availability and session behavior](https://code.claude.com/docs/en/channels)
- [Channel protocol, opt-in and acknowledgement limits](https://code.claude.com/docs/en/channels-reference)
