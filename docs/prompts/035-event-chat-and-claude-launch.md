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

Record implementation and observed validation below when completed.
