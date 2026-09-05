# Same-session notifications and Remote Control

The local monitor queues two kinds of events:

- `ledger-rebalance-needed`: drift needs attention. The current event hook is implemented; hardware readiness, connection/rejection handling and actual Ledger signing remain deferred. Its message explicitly says hardware setup is pending.
- `rebalance-completed`: the most recent swap has a successful observed receipt with two confirmations, and a subsequent fresh portfolio is within the configured drift threshold. An approval, a submitted swap, stale holdings or untradeable dust cannot produce a completion claim.

The queue is stored in ignored `.local/events.json`. Ledger alerts are deduplicated per continuing wallet/target condition; completed events are deduplicated by transaction hash. Events survive the absence of an agent. `npm run cli -- events` reads pending events, and `events ack <id>` records handling in the conversation. It does not prove a phone notification was delivered.

## Claude Code

The optional project `.mcp.json` starts `src/channel.ts` over stdio. It uses the official MCP SDK and Claude's channel extension, with one `acknowledge_event` tool. It exposes no HTTP endpoint, trading tool, key, permission relay or alternative chat interface. Commands still use the project skill and CLI. A notification may cause Claude to respond; that inference is outside the deterministic trading graph.

Custom channels currently require Claude's research-preview development opt-in. From this repository, start the single interactive session with:

```sh
claude --dangerously-load-development-channels server:rebalance-events --remote-control
```

Claude presents its project/channel consent dialogs locally. The user must accept those in Claude; this project does not change their global agent settings or bypass organization policy. For an already configured running session, `/rc` enables Remote Control for that same conversation. Adding the channel to a session may require restarting/resuming it with the channel flag. The installed development machine has Claude Code 2.1.261; this is an observed version, not a minimum requirement.

For mobile pushes, install/open the Claude mobile app using the same account and organization, allow OS notifications, and enable **Push when Claude decides** in Claude Code's `/config`. Ask the session to notify you when a Ledger rebalance needs attention or a rebalance completes. Remote Control mirrors the local session; the phone does not replace Ledger physical confirmation. The local computer and Claude session must remain running for immediate event delivery.

Claude determines whether/when to push; its docs offer no per-event delivery guarantee. An MCP transport write also does not acknowledge processing. This implementation retains each event until the agent explicitly acknowledges it and replays unacknowledged events in a later channel session. It sends an event once per channel process, rather than repeatedly waking Claude while the event remains unacknowledged.

## Codex: native Remote and notifications in this conversation

The [deterministic launch hook](LAUNCH.md) is a separate user-command entry point. It recognizes only a literal bare `$rebalance`; scheduled notification prompts never match it. It does not create, pause or duplicate this heartbeat, and it does not turn scheduled reporting into a model-free phone push service.

Codex uses the desktop app's native **Remote** connection to continue this same conversation from ChatGPT mobile. It does not need a second chat, a public app server, a custom relay or Claude's `notifications/claude/channel` method. The installed Codex CLI was observed at **0.148.0**; its experimental remote-control commands are not the documented mobile pairing flow. [Official Remote setup](https://learn.chatgpt.com/docs/remote-connections)

On the desktop host, open **Settings → Connections → Control this Mac or PC → Set up/Add**, approve the app's setup and scan its QR code with your phone. Complete pairing in ChatGPT using the same account and workspace, then open **Remote** and select this existing conversation. Keep the host awake, online and running the desktop app. Availability and required account verification depend on the app/workspace. Pairing and phone delivery have not been verified on the user's device.

For incoming rebalancer events, use a native scheduled follow-up in this conversation. The configured **Rebalance notifications** heartbeat checks the retained local queue every **five minutes**:

1. Read `npm run cli -- events`. Stay quiet if there are no new events.
2. For pending events, read `npm run cli -- status` for context and report the confirmed completion or Ledger attention request. Distinguish a past completion from current drift. Ledger hardware support remains pending.
3. After reporting an event, acknowledge its exact ID with `npm run cli -- events ack <id>`. If processing fails, retain it. An acknowledgement records handling in the conversation, not verified phone delivery.

This is a supported **scheduled Codex check**, not an immediate event-triggered push API. Reporting uses a Codex model run and may lag the event by the schedule interval or host availability. Trading, drift checks, cycle timing and receipts remain deterministic local code with no model dependency. The heartbeat never starts/stops trading, changes allocation, signs, submits or reads credentials. It reports only new meaningful events or notification-check failures and stays quiet on unchanged state. An empty queue does not trigger a runner-status inspection; this schedule is not a general monitor-error detector. The native app can notify about completion/attention; mobile delivery still depends on pairing, account/app settings and the host being available. [Scheduled tasks in an existing chat](https://learn.chatgpt.com/docs/automations#schedule-a-task-inside-a-chat)

The installed heartbeat is local to the developer's app and is not installed by cloning this repository. In another Codex desktop conversation, ask the Rebalance skill to enable the same five-minute notification check. The agent should create or update a heartbeat attached to that existing conversation using the app's scheduled-task tool, preserving the workflow above. Do not create one new conversation per run or enable the trading runner as a side effect. Ask the agent to stop notifications to pause/delete that heartbeat; this does not stop the trading runner.

Codex's `notify` configuration runs a program after a Codex turn completes, so it is the opposite direction from ingesting our events. No global `notify` setting or undocumented app-server injection bridge is installed. [Notification direction](https://learn.chatgpt.com/docs/config-file/config-advanced#notifications)

## Offline operation

Closing either coding agent does not stop an already armed local raw-key monitor. Receipts, portfolio updates and notifications remain local until consumed. Privy will share the same completion path once its signer is implemented.

## Validation and official references

The automated tests launch the actual Claude stdio MCP server with an MCP client, verify initialization, notification delivery, tool discovery, acknowledgement and replay, and reject an attempted signing-tool call. Shared event retention/deduplication/acknowledgement tests cover the queue consumed by Codex as well. The Codex notification workflow's empty-queue read was exercised in the real conversation before creating its native heartbeat; creation/readback are app evidence, not a simulated mobile push. No actual phone push or Ledger device has been verified.

- [Remote Control and mobile push setup](https://code.claude.com/docs/en/remote-control)
- [Channels availability and session behavior](https://code.claude.com/docs/en/channels)
- [Channel protocol, opt-in and acknowledgement limits](https://code.claude.com/docs/en/channels-reference)
