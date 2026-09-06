# Codex native queue and Desktop socket evidence

Observed **2026-09-06** through read-only CLI help/version, bundle inspection and version-pinned upstream source. Usernames, task IDs and runtime environment values are omitted. These checks did not send a message, run a model, start a daemon, restart/patch the app, change trust/approval settings or perform trading. Native acceptance and delivery require a separate integration observation.

## Installed versions and native interfaces

| Component | Observed value |
| --- | --- |
| Desktop application | `/Applications/ChatGPT.app`, bundle ID `com.openai.codex` |
| Desktop release/build | `26.901.31953` / `7868` |
| Desktop bundled CLI | `0.153.1` |
| Standalone managed CLI | `0.153.4` |
| Default local socket | `~/.codex/app-server-control/app-server-control.sock` |
| Read-only daemon version probe | Failed to connect: socket does not exist |

`codex queue --help` accepts an existing `--thread` and `--message`; `--remote` is optional and supports Unix sockets. Daemon help exposes `start`, `restart`, `stop`, `version` and `bootstrap`. `proxy --help` describes stdio forwarding to a running control socket. The initial investigation considered a shared Unix endpoint; the source review below establishes a simpler native shared-storage path that does not require one.

## Selected path: native queue across processes

The version-pinned [CLI implementation](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/tui/src/session_queue_commands.rs) submits only `thread/queue/add` for a supplied UUID. With no explicit endpoint or reusable daemon, its native session helper creates a temporary embedded app-server. It does not call `thread/resume`, `thread/start` or `thread/queue/start`. This supports the MVP command `codex queue --thread EXISTING_UUID --message TEXT`, using the same local Codex home as Desktop.

The [queue RPC processor](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/app-server/src/request_processors/thread_queue_processor.rs) looks up an already-loaded thread, or reads its stored metadata with history disabled. The latter does not load/resume it. It rejects invalid, archived or unsupported subagent targets, then persists the submission through the queue service. [LocalThreadStore](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/thread-store/src/local/mod.rs) delegates reads separately from create/resume writer operations; [metadata reads](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/thread-store/src/local/read_thread.rs) do not acquire the target writer lease. Thus queue insertion does not steal Desktop's active writer.

The [queue service in 0.153.1](https://github.com/openai/codex/blob/rust-v0.153.1/codex-rs/ext/queue/src/service.rs) was byte-for-byte identical to [0.153.4](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/ext/queue/src/service.rs). Both register an external SQLite revision watcher at a **ten-second cadence**, find changed queues for their own loaded threads, and dispatch ordinary idle conversations. The temporary CLI server has not loaded the target, so its immediate wake is a no-op; Desktop's existing server observes the persisted addition. An active turn waits for completion. Interruption intentionally leaves the queue paused, even after additions or cold resume. Notifications must not invoke the explicit queue-start API to override that pause. Ten seconds is a native check interval, not a maximum delivery latency: busy/interrupted threads and failures can delay handling. No model polls the application for this native storage check.

[Embedded-server cleanup](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/app-server/src/in_process.rs) operates on its own MessageProcessor. [Thread shutdown](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/app-server/src/request_processors/thread_processor.rs#L1260) shuts down only that processor's ThreadManager. Since queue-only input never loads the target, cleanup does not shut down the Desktop-owned conversation. The [idle and interruption integration tests](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/app-server/tests/suite/v2/thread_queue.rs#L369) support these dispatch semantics; upstream tests were inspected, not run here.

This finding supersedes the initial assumption that any embedded server would compete for the target writer. The notification adapter can use the native command directly, without a custom app-server bridge or socket prerequisite. Native queue acceptance still does not prove model completion, visible reporting or phone receipt. Keep the existing heartbeat until replacement delivery is observed; retain ambiguous attempts without blind resend.

## Unselected Unix attachment: blocked on the installed Desktop

The installed `app.asar` retains a local-daemon opt-in, but two conditions conflict:

- `.vite/build/main-C5K7o1Hr.js` supplies `getConfigOverrides:()=>tk(e)`. For a local host, `tk` always returns a one-element app-managed `codex_app` MCP override; missing resources use `nk`, which also returns a disabled override.
- `.vite/build/src-VqXTPopo.js`, `uU.connect`, requires `!e?.length` before selecting a daemon. It also requires a local non-Windows host, `CODEX_APP_SERVER_USE_LOCAL_DAEMON=1`, no force/custom CLI, no bundled Git and a successful `dU` version probe. `A_` accepts versions at least `0.141.0` or development sentinel `0.0.0`. Git was absent and versions qualify, but the overrides condition fails.

**Opt-in plus restart still selects private stdio in this build.** This matches the open [upstream regression report #41014](https://github.com/openai/codex/issues/41014). It blocks direct Unix attachment, not the native shared-storage queue above. No bundle modification or restart workaround is part of the MVP.

If a future Desktop fixes this gate, the alternative would require finishing active turns, fully quitting Desktop, starting/verifying the native daemon, relaunching with the process-local opt-in, and verifying actual attachment before queueing through that socket. It is conditional, not a working remedy for this build. [Native daemon documentation](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/app-server-daemon/README.md) calls its lifecycle experimental: `start` waits for readiness; `bootstrap` additionally starts an hourly updater and is not reboot-persistent. Neither is necessary for the selected native queue path.


## Local integration result — 2026-09-06

The application notification worker submitted one labelled nonfinancial connection test through native `codex queue`. Native queue acceptance was observed first. After the active response finished, that exact test arrived as the next message in the same existing Desktop conversation. The assistant reported it, verified the retained event/public status and acknowledged its exact ID. The native automation tool then confirmed deletion of the former five-minute notification heartbeat. This demonstrates the selected native cross-process path on the observed installed versions without a daemon or competing thread writer. Trading remained stopped. Phone delivery is not established by this test; the native ten-second queue check and interruption/availability limits still apply.
