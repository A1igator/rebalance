# Explicit rebalance requests and automatic cadence

Date: September 13, 2026. This is a new product decision, superseding the earlier rule that every target edit retains the current cooldown.

The owner reported another cooldown after changing targets in a separate conversation: “there should be no cooling down after a user/share initiated rebalance,” then asked to fix the current waiting state too.

## Intended behavior

- An explicit target-bearing command, allocation application, shared strategy application or Ledger rebalance request makes that request eligible immediately, even during an automatic cooldown. A settings-only edit does not create this request.
- Persist a unique request identity with the configuration commit. Consume it once when its cycle starts or a fresh observation establishes that no trade is needed. Restarts, repeated native share delivery and stale requests cannot repeatedly bypass the interval.
- Automatic rebalances keep the saved interval and bounded active window. Pending receipt reconciliation, current configuration, Stop, fees, exact prepared inputs and physical Ledger confirmation remain prerequisites.
- Saving a request never starts a stopped portfolio. Code upgrades still require a new process; routine later target edits do not.
- Correct the current wait only while the owner has stopped the old runner, using the previously reviewed one-time helper and fresh public-state guards. Keep operational details in the ignored local audit.

## Material task prompts and work split

Codex delegated core configuration/cadence/runtime/Ledger journal behavior and isolated tests to one collaborator. A second collaborator owns CLI and native share application integration, retaining request deduplication and write-ahead barriers. The coordinator reviews their integration, updates product/skill guidance, verifies the stopped live correction and records actual test results. Tests must use the disposable application-data launcher, never live wallet fixtures. No agent starts the funded runner, signs or submits a transaction as part of implementation.

The team-shelf lookup failed with NETWORK_ERROR. Tenjin publishing remains paused at the owner's request. Validation and the final implementation are recorded in AI_USAGE.md after checks complete.
