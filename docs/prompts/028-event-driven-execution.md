# Event-driven execution latency — 2026-09-05

## Human requests

> why all these waits? if it's determinstic in the bg it should be a lot shorter

> and as events based as possible rather than sweep based

## Diagnosis and plan

The current monitor sleeps after every individual approval/swap traversal, recreates its chain client's verification/discovery cache, and waits five minutes before recovering a rejected/uncertain send. Public state recorded repeated `underpriced` send failures. Normal legacy sends use the RPC gas-price suggestion without fee headroom. RPC reads inherit three retries with a 20-second timeout. These are application and network delays, not LLM trading decisions.

1. Replace unconditional traversal sleeps with coalesced wakeups from local configuration/stop changes, public Robinhood sequencer activity, exact recovery/cycle deadlines and a bounded fallback watchdog. Keep one serial graph and its existing execution lock. Feed events are activity hints only: all balances, prices and transaction resolution still require authoritative RPC reads and the existing receipt checks.
2. Process active receipts promptly, then continue the next required leg immediately after confirmation. Coalesce high-frequency feed messages and back off RPC errors; no overlapping graph runs or unbounded request queue. During cooldown, wake for relevant local changes and its actual deadline rather than repeatedly rebuilding trade plans. Preserve target edits, stops, pending barriers and saved cycle timing.
3. Retain verified contract/pool discovery across unchanged configuration with bounded expiry, parallelize independent discovery, and keep dynamic balances, quotes, allowances and corporate-action pause reads fresh. Bound transport retries/timeouts. Add modest deterministic fee headroom before the first send; never re-sign or resend an uncertain transaction.
4. Reduce raw-key stale-send grace to 30 seconds, scheduled by a deadline rather than a five-minute sweep. Same-nonce cancellation remains once only, with both transaction identities preserved until a canonical winner. Successful-swap cadence and pending reconciliation before the interval gate remain intact.
5. Test wakeup coalescing, fallback/reconnect, stop/config changes, no concurrent execution, prompt receipt progression, cache invalidation, transport bounds, fee arithmetic and retained recovery barriers with isolated storage/mock providers. Preserve meaningful prompts/provenance and commit on main.

## Source and read-only event evidence

Robinhood's [connection reference](https://docs.robinhood.com/chain/connecting/) documents public HTTP RPC and a public sequencer WebSocket feed, plus provider JSON-RPC WebSockets. Its public RPC is rate-limited. [Finality documentation](https://docs.robinhood.com/chain/transaction-finality/) distinguishes fast sequencer confirmation from later Ethereum finality; this app's existing receipt checks do not constitute L1 finality or a light client. [Fee documentation](https://docs.robinhood.com/chain/gas-and-fees/) says normal gas estimation includes execution and L1-data components.

A read-only connection to the documented public mainnet feed opened and received three frames (78,856 bytes) in 839 milliseconds. No message contents, wallet credentials or transaction submissions were involved. This establishes feed availability at the probe time, not correctness/finality or live execution of the new scheduler.

Codex's existing five-minute notification heartbeat is separate from trading and remains a scheduled host capability; this change does not invent an unsupported event-to-phone bridge. Existing processes need to load changed runtime code before its new behavior is active; file edits are not a hot update.

## Result and validation

Implemented the serial event scheduler, bounded wake source/reconnects, cached and parallel discovery, bounded RPC retries, initial fee headroom, 30-second recovery deadline and read-only chart SSE with disconnect polling fallback. Existing cadence, pending identities, stop handling and native hook trust/dispatch are preserved. Independent reviews found and corrected eager feed startup before stopped/config checks, stale cycle output weakening RPC-error backoff, missing pre-traversal failure alerts, and graceful shutdown with an open chart stream.

Final validation: **228/228 tests**, with **zero skipped**, plus TypeScript, browser-script syntax and Git whitespace checks. This includes 11 scheduler tests, eight wake-source tests, 33 recovery tests and six chart-stream tests. Actual isolated loopback/SSE and atomic filesystem-watch tests passed under test-only escalation; the restricted run's native-watch `EMFILE` limitation was not represented as success. Financial tests use disposable fixtures and mocked providers.

Read-only mainnet benchmarking using the same new chain client measured a cold five-position snapshot at **1,671 ms / 80 HTTP requests**, then a warm snapshot at **337 ms / 29 requests**. This measures two observations, not full swap latency or guaranteed future performance. No transaction was submitted by the benchmark and no private key was inspected.

The assistant verified and reloaded only the existing read-only chart server, confirmed its actual SSE endpoint delivered a public status event, and verified the trading process retained the same PID/token. The existing browser tab was reloaded through browser controls and displayed only the pie/labels, now labeled last-known holdings during cooldown. The funded runner still has its prior code loaded; a user-driven recovery/resume remains the update step. No live scheduler, fee-buffer or shortened-recovery trading result is claimed.

The shared skill and current operational docs were updated. Basic frontmatter, shared skill symlinks and changed-document links were checked. The standard Python skill validator remains unavailable because PyYAML is missing; it is not represented as passing. No new dependency, native trust setting, funding, allocation, runtime cycle or notification-schedule change was introduced by this implementation turn.
