# Apply a pasted strategy to the attached portfolio

The user referenced a native pasted-strategy task and asked: “should auto apply to open portfolio?” That task already had a selected wallet and returned a comparison, but the model misleadingly invited selection again. This clarification supersedes prompt 087's preview-only interpretation for exact pasted codes.

An exact plain-text rebalance:v1 strategy submitted by the user now deterministically applies its targets and any included drift trigger/cycle interval to the portfolio attached to that native conversation. Preserve omitted settings and all unrelated configuration. Clear a previous computed allocation policy using the existing explicit share-import behavior. This is a configuration edit: it does not start or stop runners, bypass pending receipts/cadence/fees, or sign or submit transactions. An already running backend observes updated configuration through the existing live-settings path; Ledger confirmation remains required.

Use the trusted session attachment, never ambient browser metadata or an arbitrary lone/default wallet. With no attached portfolio, open the selector and leave the strategy unapplied. Selection alone remains non-trading and does not consume a stale import. Explicit preview requests remain read-only.

Record a native request identity and fixed wallet route before writing, commit through config.lock with fresh validated configuration, and suppress duplicate prompt delivery even after selection or settings change. An uncertain write outcome must not be called unapplied or blindly replayed. The model reports the returned result once and never applies it a second time. Existing native event/root/Plan/provenance gates remain intact, and no hook trust setting is changed.

Verify with isolated parser/routing/configuration/replay/concurrency/failure tests and all three native adapters. Never invoke this mutation against live portfolio data during development. Keep unrelated edits intact and commit/push to main under the owner's standing instruction.
