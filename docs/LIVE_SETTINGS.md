# Editing a running portfolio

Ask the connected agent to change targets or settings. The CLI saves them while the same wallet runner stays active, including while waiting for a receipt or a device prompt. The companion shows saved values in Settings; editing remains in the agent conversation.

| Change | CLI example |
| --- | --- |
| One target, proportionally redistribute others | `targets set AAPL 30` |
| All five targets | `targets replace USDG=5,AAPL=30,NVDA=25,MSFT=20,AMD=20` |
| Drift trigger | `configure --threshold 5` |
| Minimum interval between new cycles | `configure --rebalance-interval-seconds 3600` |
| Estimated remaining network-fee target | `fees target 0.05` or `fees clear` |
| Slippage | `configure --slippage 0.5` |
| Quote deadline | `configure --deadline 120` |
| Quiet-feed fallback interval | `configure --poll 30` |
| Allocation policy | `allocation set /absolute/path/to/policy.json` or `allocation manual` |

These are syntax examples, not portfolio recommendations or defaults for every wallet. Prefix with `npm run cli --`; add `--profile <public-address>` to target another wallet without reconnecting the chat.

Writers briefly serialize and calculate against the latest saved configuration. RPC preparation, signing prompts and submission-response waits do not hold that settings lock. The runner detects atomic config replacement and uses a fresh deterministic evaluation. If it already observes a newer config after an evaluation, it re-evaluates immediately even if the file event was missed. No duplicate executor or chat notification is created.

A superseded unbroadcast plan or signature is discarded. The final local preparation/send-invocation boundary serializes with edits so either the edit wins and prevents the stale send, or an already initiated send retains its original hash and receipt barrier. Changing settings cannot cancel a transaction already submitted. Ledger configuration changes also end the current explicit signing request; a subsequent Ledger rebalance requires its normal fresh request and physical confirmation.

Targets, allocation policy, trigger, slippage, deadline, fee target, RPC URL and polling changes affect subsequent work. New cycle intervals apply when the next cycle is created. Existing cycle deadlines and successful-swap cooldowns remain recorded; an edit does not erase them. Pending and recovery identities are retained and reconciled first.

Wallet identity is fixed per portfolio. Changing the signer mode requires a stopped runner and no pending transaction, because it changes who signs rather than a portfolio setting. Create/connect a separate portfolio to use another wallet.

A code upgrade still requires a process reload to execute newly implemented behavior. Once this version is loaded, routine settings/target edits do not require Stop/Start. Configuration changes themselves never start an inactive runner.
