# Persistent portfolio companion view

Keep the portfolio in a browser pane beside the conversation. The view uses the same local Rebalance server and session-scoped URL as the selector. Opening or navigating it does not launch, stop, or recover a runner.

## Opening the selector

A bare skill invocation opens the conversation-linked selector and restores saved running preferences independently of the selected wallet. A card click attaches this chat and opens that chart; another invocation is not needed to connect. Selector navigation and choosing preserve runner state, with Start available separately on inactive portfolios. The skill entry restores only previously running portfolios; deliberately stopped portfolios stay stopped. Return a short selection prompt rather than listing every wallet or declaring launch incomplete.

The selector can reuse any ready owned chart from the same portfolio registry, while preserving the conversation's view capability. The hosting chart's wallet is not selected by opening its grid. An obsolete or foreign default-port listener is never replaced or adopted; if no existing owned chart is ready, normal read-only root-chart preparation applies. No arbitrary localhost origin or visible browser URL supplies the conversation identity.

## Codex Desktop presentation

The linked selector is prepared deterministically by `view`/app entry. Codex Desktop currently opens that URL through its native `open_in_codex` tool with `placement: right`; this is a separate host UI operation. The native result explicitly makes that the next action before replying. Keep the complete fragment and the current conversation; never derive identity from ambient browser state. A successful command that returns a URL is not evidence that the pane opened. An already-opened native presentation should be reused, not duplicated.

The installed CLI's `codex app` accepts a workspace path, not a browser URL/pane request. The public app-server protocol did not provide a native browser-opening method in the September 12 check. Its generic `mcpServer/tool/call` only applies to tools on an actual connected MCP server; it does not itself expose Desktop's browser bridge to shell hooks. Do not invent a deep link, scrape an app credential, or create a relay to claim automatic Desktop pane support. Claude/OpenCode's verified cmux shell adapter below is a different supported host path.

A missing hook result says nothing by itself about trust. In the September 12 follow-up, read-only bundled `hooks/list` did establish `enabled: true` and `trustStatus: untrusted` for the current project path. The user can review the exact project handler with Codex CLI's `/hooks`; development must not silently trust or execute it. Earlier path-specific trust evidence in the launch history remains historical.

Sources: [Codex hooks and review](https://learn.chatgpt.com/docs/hooks), [public app-server protocol](https://learn.chatgpt.com/docs/app-server), installed CLI help and read-only bundled hook discovery. See [prompt 086](prompts/086-deterministic-selector-presentation.md).

## View access failures

`local-access-denied` means this command process could not access the local listener (EPERM/EACCES). Retry only read-only `view` preparation through the host's approved permission mechanism; never reinterpret denial as a stopped server or rerun financial startup. `listener-incompatible`, `ownership-unverified`, `startup-unverified` and `unavailable` remain distinct, sanitized errors. The app preserves these codes and does not issue a view capability until identity and ownership are verified.

App-entry `restorationResults` reports startup attempts, not wallet inventory. Setup-only and replay can have no new restoration results while several wallets exist. The selector or `wallet list` supplies actual inventory. A failed view preparation is not a ready selector.

## Claude Code in cmux

The Claude slash-command wrapper supplies `openCompanionView` to the shared hook. After the shared handler has a view URL, the helper opens a cmux browser split beside the invoking terminal. It passes the inherited `CMUX_WORKSPACE_ID` and `CMUX_SURFACE_ID` explicitly and uses `--focus false`, so another focused workspace cannot redirect the opening and keyboard focus stays with the conversation.

The helper uses the installed `cmux` executable, including the macOS app's bundled command when it is absent from `PATH`. It does not start cmux, enable its browser, change socket permissions, inspect terminal contents, or change Claude hook trust. cmux must already be running with its browser available, and Claude must have been started inside that cmux terminal.

On subsequent openings, it checks the recorded browser UUID in the same workspace and verifies that the pane still displays its saved local origin before navigating. A pane that the user has navigated to another site is left alone. A moved or closed pane is not navigated through a guessed handle. The helper uses native UUIDs rather than short surface references that can change across app restarts.

Receipts live under the local root's `companion-views/` directory, keyed by a hash of the conversation and cmux workspace/source. They contain public pane IDs and the local origin, never the session URL's capability token. A prepared opening whose result was lost is retained as unverified, preventing repeated browser creation. If an opening remains busy after its owner has exited or is unverified, inspect that exact companion receipt and the existing pane before repairing it; do not delete trading, pending, or hook-request records.

The public result contains `view.presentation`: `host`, `opened`, and either `reused` or a fixed `reason`. An unavailable companion pane leaves the underlying command's trading result intact. A successful browser-open response is not proof that the application finished loading.

The implementation uses only documented CLI commands, with argument arrays, bounded output, and a five-second timeout per command. Fixture tests substitute every native call; they never open a real pane or read a live wallet.

Sources: [cmux browser automation](https://cmux.com/docs/browser-automation), [CLI contract and inherited identities](https://github.com/manaflow-ai/cmux/blob/main/docs/cli-contract.md), and the installed `cmux browser --help` / `cmux identify --help` output.

## Claude Code Desktop

The Code tab's native Browser pane supports local servers and can be arranged beside chat. Use Claude's available native Browser/Preview tools to open the returned session-specific view URL there. The user can keep that pane open while scrolling the conversation. Tool names depend on the host's exposed capabilities; a shell helper does not fabricate a Desktop tool or force an unsupported pane.

Claude Desktop also supports attaching its preview to a server that is already running through `.claude/launch.json`: an entry may contain a name, matching port, and local origin URL without a server command. This must not be a trading launch command. A localhost `url` in that file is restricted to the origin: no path or query, and its port must match the entry. Navigate to the returned complete Rebalance URL through the native Browser after attaching. Do not commit a session capability URL, store one in shared preview configuration, or infer a conversation from a shared server's environment.

An ordinary external-browser tab is not a persistent in-app companion pane. If the native pane cannot be opened, report that limitation and provide the local view URL without claiming that a side panel was opened.

Sources: [Claude Code Desktop preview](https://code.claude.com/docs/en/desktop#preview-your-app), [pane layout](https://code.claude.com/docs/en/desktop#arrange-your-workspace), and [preview server configuration](https://code.claude.com/docs/en/desktop#configure-preview-servers).

## Conversation identity

Claude's native hook supplies `session_id`, normalized by Rebalance to `claude:<session_id>`. Direct commands from Claude's Bash tool can use the current `CLAUDE_CODE_SESSION_ID` with the same prefix. The helper never reads a transcript to discover identity.

Current Claude documentation also supplies `CLAUDE_CODE_SESSION_ID` to stdio MCP servers, but that value remains the spawn-time identity. It can become stale after `/clear`, or start with the wrong identity under implicit `--continue`/`--resume`. The channel is bound to its known native session, or to the first valid Claude view when no native identity is available. `connect_companion_view` accepts rotated tokens for that same session only; another session’s token cannot retarget delivery or acknowledgement. After `/clear` or an implicit resume changes the conversation identity, reconnect the MCP channel through the host so its new process receives the current native identity. Old pending requests stay with their original session; do not use a token to redirect them into the new chat.

Source: [Claude environment variable reference](https://code.claude.com/docs/en/env-vars), `CLAUDE_CODE_SESSION_ID`.

## Portfolio controls

The chart places **Start / Stop** at the top right, the displayed wallet’s shortened public address beside it, and **Share** to their left. The address opens the wallet on the Robinhood explorer. Share copies the portfolio's share code: its targets, drift trigger and cycle interval, never the address or holdings. If the clipboard is unavailable, the code appears as selectable text. Share needs no agent link and sends no request. Importing a code stays an agent command (`share import`). These controls preserve the compact chart and existing Back navigation.

Start/Stop requires the existing agent-linked local view and must match both the chart wallet and this conversation’s current attachment. It calls deterministic local code, without queueing a model request. Current runner state arrives through the chart’s event stream, with the existing bounded read fallback on connection failure. Starting/stopping or unverifiable states are displayed truthfully; request acceptance is not running confirmation. Start uses the existing launcher and saved targets; Stop respects the dispatch boundary and does not undo submitted transactions. Ledger execution is currently deferred. Navigation and new-wallet setup still do not arm trading.

## OpenCode

The project plugin supplies the native `opencode:<sessionID>` identity to each shell command, and `view` issues a linked companion capability for that conversation. Card clicks, Back and deterministic wallet onboarding use the same public connection records as the CLI. OpenCode does not use Codex queueing or Claude's MCP channel for setup or events.

A bare native `/rebalance` reuses the cmux helper above when OpenCode was started inside an existing cmux terminal. Otherwise the returned complete local URL can be opened in an available browser; a built-in persistent OpenCode Browser pane is not established by this integration. Keep the fragment when opening the view. See [OpenCode setup](OPENCODE.md).
