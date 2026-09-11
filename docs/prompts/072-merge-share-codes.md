# Merge share codes and refresh local setup

Date: 2026-09-11

## Human request

“merge 22 in and update local setup to it”

## Integration plan

Review PR #22 at 7faadf0070304153679f1767a28e7af38c9e24ff and validate it in an isolated checkout before merging. Preserve its meaningful history with a merge commit on main, including existing Settings/Back fixes. Fast-forward the owner's checkout to the merged result. There are no dependency changes. Refresh only the owned portfolio chart servers to load the new share-code asset route; existing Codex/Claude project skill links should resolve to the updated skill automatically. Verify the user's current companion, share export, and original portfolio/configuration/trading records. No share import, wallet creation, trading activation or signing is authorized by this update.

The required Tenjin search was unavailable with NETWORK_ERROR. PR #22 includes its own implementation plan and AI provenance in prompt 071.
