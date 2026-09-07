# Distinct additional Privy wallets — September 7, 2026

Human request: “it says already added but I want it to create another privy wallet?” Earlier requirements specify separate per-wallet portfolios and deterministic background signing. Merely labeling/reopening the cached Sandbox wallet did not fulfill this.

## Verified provider boundary

The pinned Agent Sandbox CLI 0.3.6 selects its first Ethereum session wallet and exposes no create-additional/explicit-wallet-ID RPC option. Preserve that existing adapter and portfolio. Privy's standard app API supports distinct app-controlled Ethereum wallets with stable external IDs, explicit wallet-ID signing and app credentials. This route requires a separate Privy developer app ID and app secret; it does not use Sandbox end-user login. The user has been told this distinction and asked whether they have an app. Secrets must be entered locally, never shared in chat.

Sources (official documentation, checked September 7):
- https://docs.privy.io/api-reference/wallets/create
- https://docs.privy.io/wallets/wallets/external-ids
- https://docs.privy.io/api-reference/idempotency-keys
- https://docs.privy.io/api-reference/wallets/ethereum/eth-sign-transaction
- https://docs.privy.io/basics/nodeJS/quickstart

## Implementation plan, committed before code

1. Add an optional explicit app/wallet binding to Privy profile config; absence retains Sandbox behavior. Preserve bindings through target edits, setup retries and registration. Reject conflicting reuse, app changes and signer fallback.
2. Implement a small fixed-origin Privy REST adapter using built-in fetch, owner-only local credential storage, sanitized errors and request timeouts. Bind each new setup to a persisted app identity and stable external ID before creation. Use provider idempotency plus external-ID reconciliation so duplicate requests do not create duplicate wallets, including ambiguous responses and later retries.
3. New Privy in the grid creates an additional app wallet. If app configuration is missing, expose a focused local setup form with public app ID, hidden secret input and the official dashboard link. Credentials never enter URLs, storage in the browser, progress records, model queues or logs. Existing Sandbox connection remains available through its explicit agent command.
4. App-backed signing selects the exact saved wallet ID and address, verifies every returned transaction field/sender, and returns a signature to the existing local broadcast/receipt flow. Setup itself never signs, submits, starts/stops runners or edits another portfolio.
5. Add focused API, retry, binding and UI regressions, then run TypeScript and the full suite. Update provenance and setup instructions. Reload only verified read-only chart processes if needed; preserve running trading state. Commit locally; no push pending destination authorization.

No new dependency is planned. Real app creation/login/credentials and live provider integration are not inferred from fixture tests. If app credentials are unavailable, complete the wiring and clearly identify that remaining setup step; do not claim a new remote wallet exists.

## Validation follow-up, before the corrective edit

The full suite exposed an existing setup-channel race: a request is atomically published before its producer releases the request lock. A watcher can observe that valid pending record and interpret ordinary live-lock contention as a delivery failure. A deterministic isolated reproduction retained the request and delivered once after release, but emitted an unnecessary diagnostic. Correct only this expected-busy classification in the existing delivery path, preserving pending state, file-event wakeup and all actual I/O/corruption errors. Add the reproduction as a regression. No live notification worker or trading process is restarted for this correction. Separate CLI notification fixture timing failures are being investigated rather than assumed to be financial/runtime regressions.

## Human correction — Agent Sandbox exclusively

The human corrected the provider scope: “we should be using agents.privy.io exclusively not dashboard”. This supersedes the app-controlled API implementation above. Remove its uncommitted code, forms, tests and operational documentation; preserve this planning history as an abandoned approach. Existing Agent Sandbox sessions and wallets remain intact. Verify the Sandbox web UI/official skill separately before concluding whether additional wallet creation is supported; a CLI limitation alone does not establish the web UI's behavior. Do not request developer app credentials or use the dashboard.

Before reverting, a complete local snapshot, exact patch and SHA-256 manifest of only this turn's 19 changed files and five new app-API files were saved outside the repository. Rollback must verify every file still matches that manifest and preserve the independent notification/channel corrections. No user credentials or runtime files are included in this snapshot.

The same full-suite investigation independently reproduced a notification startup reader seeing an empty lock file before its initial JSON write. Add only a bounded notifier lock-read retry for an in-progress initial write, preserving persistent-corruption failures and avoiding duplicate workers. Adjust notification fixtures to await actual running state after a legitimate starting result and clean up children even if an assertion fails. Keep the separately verified quiet live-request-lock retry correction; these fixes do not change wallet/trading state or restart real notification workers.
