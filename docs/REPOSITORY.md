# Repository governance

Repository: [A1igator/rebalance](https://github.com/A1igator/rebalance), a public repository owned by the personal GitHub account **A1igator** (account ID `20358261`). Default branch: `main`.

The owner explicitly requested direct pushes to `main` with protection applying to everyone else. The ruleset source is [`.github/main.ruleset.json`](../.github/main.ruleset.json); merely committing that file does not activate it. Apply and verify it through GitHub's rules API.

Desired active behavior:

- Only the named owner bypasses restrictions on updating `main`.
- Other actors cannot update or delete `main`, or force-push it.
- No pull request or CI requirement blocks the owner's ordinary pushes.
- There are no app, deploy-key, collaborator or broad-role bypass grants in the requested configuration.

GitHub authorizes credentials as their account principal. An assistant or CLI using A1igator's credentials has the same bypass as A1igator; branch rules cannot distinguish the human from automation using that identity.

Preserve hackathon history even though an owner bypass may technically allow rewriting it. Do not backdate, amend away, squash away or force-push event development history. Recheck governance if the repository moves to an organization or the bypass configuration changes.

Verified on **2026-09-04** by API creation and a separate readback: [ruleset `22303502`](https://github.com/A1igator/rebalance/rules/22303502) is **active**, targets `refs/heads/main`, and contains update, deletion and non-fast-forward restrictions. Its sole bypass actor is `User` ID `20358261` (A1igator), in `always` mode. The repository is public, personally owned, and uses `main` as its default branch. A second-user rejection was not tested; the active server configuration was verified.

References: [ruleset REST API](https://docs.github.com/en/rest/repos/rules#create-a-repository-ruleset), [available rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets).
