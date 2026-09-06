# Execution timing and events

The [human request](prompts/028-event-driven-execution.md) replaces unconditional background sweeps with event-driven scheduling. Deterministic means no LLM decides the trade; it does not make RPCs, receipts or delivery instantaneous.

## Wakeups

| Situation | Trigger and fallback |
| --- | --- |
| Configuration, stop or cycle change | Directory events observe atomic file replacement; a five-second local-file watchdog catches missed/unavailable watches |
| Pending approval, swap or cancellation | Sequencer activity prompts a receipt traversal, coalesced to at most once per second after the preceding traversal; a three-second watchdog covers missing feed events |
| Stale raw-key send | Exact 30-second deadline from saved creation; reconcile first, then at most one same-nonce cancellation |
| Eligible, idle portfolio | Coalesced chain activity, at most one refresh per five seconds after the preceding traversal; saved `pollSeconds` (default 30) is the quiet-feed fallback |
| Cycle cooldown | Exact saved eligibility deadline or changed local controls; no repeated full portfolio/quote sweeps while waiting |
| RPC error | Backoff grows from two to 30 seconds after a traversal; chain events do not bypass it, while changed controls remain responsive |
| Chart | Initial state and public-file changes over local server-sent events; five-second polling only while the stream is unavailable |

The scheduler retains one execution lock and runs one graph traversal at a time. Incoming activity is coalesced, not queued as thousands of future trades. After a receipt confirms, that same traversal refreshes holdings and can dispatch the next required approval/swap if the active window still allows it. Stops and pending barriers remain enforced before sending. No timer or event extends the ten-minute active window or changes successful-swap hourly cadence.

The official [public sequencer feed](https://docs.robinhood.com/chain/connecting/) supplies activity hints only; the app does not decode them into portfolio decisions, trust their transaction outcome, or claim light-client verification. RPC remains the source of balances, quotes and canonical receipt evidence. Feed connections reconnect with bounded backoff; unavailable local watches and feed outages retain watchdog behavior. This is event-driven with explicit fallbacks, not guaranteed push availability on every host.

## RPC and fee work

The monitor reuses a chain client only while the full configuration is unchanged. Verified contract identity/pool discovery is cached for ten minutes, invalidated on clock rollback, and published only after the entire discovery succeeds. Independent discovery calls run concurrently. Balances, quotes, allowances and stock oracle/multiplier state remain dynamic reads. Failed discovery is retried without retaining partial results.

HTTP reads use an eight-second timeout per attempt with one retry, down from 20 seconds with three retries. A provider's `Retry-After` can still extend wall time, so this is not a hard 16-second total guarantee. Pinned Viem's raw-transaction submission disables transport retries.

New legacy sends use integer-ceiling 20% headroom over a fresh RPC gas-price suggestion, separately from the existing gas-limit margin. Balance checks use that actual buffered fee. This reduces exposure to a fee moving before submission; it cannot guarantee acceptance. An uncertain send keeps its original hash and is never re-signed or blindly retried. Automatic cancellation retains both identities and reconciles a canonical winner.

## Notifications and loading the update

Local chart streaming does not create an event-to-phone API. Claude's channel and the Codex notification worker watch atomic queue-file replacements, drain serially and replay retained entries at startup. Healthy delivery has no queue-sweep timer; bounded retry timers run only after errors. Codex uses native shared queue storage for the existing conversation. Its internal ten-second revision check handles cross-process additions; the application watcher has no healthy sweep. A native test reached this conversation on September 6 and was acknowledged, after which the old five-minute model check was deleted. No notification schedule is needed. Chat reporting and phone delivery stay outside trading and can lag the event; neither queue acceptance nor acknowledgement proves a phone push. See [notification setup and limits](NOTIFICATIONS.md).

The chart's separate `/api/gas` display endpoint caches/coalesces public Robinhood gas-rate and Coinbase ETH-USD reads for 30 seconds, with four-second source deadlines and no retries. The browser requests it at most once per 30 seconds while open, independently of status events; source timestamps over 90 seconds old are labeled last known. This refresh only changes gas labels. It never wakes the trading graph or changes portfolio valuation, cadence or transaction fees.

The same response includes historical application gas references and a bounded fixed-price projection of remaining swaps from copied public holdings/configuration. The pure planner is reused for arithmetic only, with a 16-leg bound and fresh wallet/target/balance identity checks. Projected approval costs span zero to one per swap. Neither projection nor quote refresh triggers observation, recovery, scheduling, signing or changes to saved execution state.

Already running Node processes retain their loaded code. A later permitted start loads the current runner code; a completed recovery journal does not reload it. Pending state carried into a full raw-key launch is handled by automatic recovery without a separate user command. The read-only chart server can be reloaded separately to serve SSE; until then the new browser script can use its polling fallback. Neither process reload clears saved cadence, pending transactions or recovery history.
