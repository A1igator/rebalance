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

## Codex and offline operation

The CLI queue and project skill also work in Codex. Claude's `notifications/claude/channel` method and `/rc` are Claude-specific; this repository does not claim that Codex has consumed those push events. In Codex, inspect `events` during the existing conversation. A dedicated Codex push adapter is not implemented.

Closing either coding agent does not stop an already armed local raw-key monitor. Receipts, portfolio updates and notifications remain local until consumed. Privy will share the same completion path once its signer is implemented.

## Validation and official references

The automated tests launch the actual stdio MCP server with an MCP client, verify initialization, notification delivery, tool discovery, acknowledgement and replay, and reject an attempted signing-tool call. They use isolated local event files. No Claude account, mobile service, phone permission or Ledger device was used, and no real phone push has been verified.

- [Remote Control and mobile push setup](https://code.claude.com/docs/en/remote-control)
- [Channels availability and session behavior](https://code.claude.com/docs/en/channels)
- [Channel protocol, opt-in and acknowledgement limits](https://code.claude.com/docs/en/channels-reference)
