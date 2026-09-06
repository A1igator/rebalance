# Notification review and repository move — 2026-09-06

## Human requests

> also why is there still a scheduled task vs everything event based in the chat apps

> can you also move the rebalance folder to under documents/git

> you can stop running rebalancer and we can redo the installed skill it's fine

## Findings and operation

The notification review found that Codex uses the existing five-minute heartbeat as a delivery fallback. Claude supports incoming channel events, but the current project adapter still reads the durable queue every two seconds. This polling is outside trading. OpenAI's documented App Server can start a turn from an integration; attaching a new event bridge to this already-open Desktop conversation was not implemented or verified. The human's event-driven preference remains relevant; this review did not remove polling or retire notifications.

Following explicit stop authorization, the assistant ran the ordinary stop command and verified `armed=false`, no runner lock and no pending transaction. The read-only chart was stopped after checking its process identity. The repository was moved by same-volume rename from `/Users/aliabdoli/Documents/ChatGPT/rebalance` to `/Users/aliabdoli/Documents/git/rebalance`, retaining Git history and all ignored wallet/runtime files. The wallet file's identity, size and permissions were compared without reading its contents.

An initial old-path compatibility symlink was removed because Codex rejects a symlinked writable workspace root. The old location now contains only `MOVED.md` for this existing conversation. The actual repository and project skills are in the new location. Codex and Claude project skills already use relative links and resolve to `skills/rebalance/SKILL.md`; no duplicate global skill was installed. Pure selector checks accepted the new exact canonical skill link and the typed bare command while excluding a scoped status request. No funded hook or launcher was invoked.

The existing notification heartbeat's working directory and skill reference were updated through the native automation tool, preserving its identity, current conversation, active status, five-minute schedule and notification-only scope. Trading remains stopped. Only the read-only chart was restarted from the new location; its HTTP status endpoint returned the same wallet, chain 4663 and `armed=false`. The saved Codex conversation/project and path-scoped hook trust were not rewritten. Open the new repository folder for fresh project skill/hook discovery.

## Sources

- [OpenAI scheduled tasks and supported event triggers](https://learn.chatgpt.com/docs/automations)
- [OpenAI App Server](https://learn.chatgpt.com/docs/app-server)
- [Codex outgoing notifications](https://learn.chatgpt.com/docs/config-file/config-advanced#notifications)
- [Claude channels](https://code.claude.com/docs/en/channels)
- [Claude channel delivery](https://code.claude.com/docs/en/channels-reference#notification-format)
- [Claude mobile push](https://code.claude.com/docs/en/remote-control#mobile-push-notifications)
