# Merge PR 20 and prepare Ledger testing — 2026-09-10

The human requested: “merge PR 20. is ledger work done? can I test it? what's next?” This supersedes the earlier preview-only instruction for this pull request. Continue using main and preserve both contributor history and the Ledger implementation already committed as `996e02d`.

## Plan before integration

Merge PR #20, `Rebuild the chart as a ring with a detail panel`, at verified head `6dc92a4fb12435db53347ca6030e3e4d5ce4b713`, using a merge commit. Retain the existing selector, conversation attachment, Start/Stop and copy-address controls, and Ledger monitoring/signing semantics. Resolve any integration conflicts by preserving both behaviors, then run TypeScript and relevant chart/runtime/control tests. Record actual validation, contributor/AI provenance and any remaining limitations. Push main and verify that GitHub records the PR as merged.

Refresh the existing read-only companion service as needed so the integrated UI is visible. Do not restart a funded runner, change allocation/configuration, or queue/sign/broadcast a Ledger transaction to validate the merge. Read the Ledger portfolio's public status/funding to give concrete test instructions. Physical transaction/display/rejection and receipt evidence remain distinct from completed software wiring.

## Provenance

PR #20's original commits attribute implementation to its contributor and Claude, including the contributor's session link in commit messages. Its nine-file change updates chart rendering/disclosure, public drift-threshold projection and related fixtures; it introduces no dependency. Preserve those commits and attribution. Root and a parallel read-only agent review integration with the existing Ledger and portfolio-control code. The already-running port-4770 preview uses a frozen public snapshot; it is not the live portfolio control surface.
