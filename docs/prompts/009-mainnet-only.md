# Mainnet-only live integration and demo — 2026-09-04

## User request (verbatim)

> do everything on mainnet. testnets are dead now that gas is so cheap

## Applied decisions

All live integration, project deployments and demo transactions use mainnet. Robinhood mainnet (4663) is the first target, with Base mainnet (8453) as the alternative under the earlier any-L2 preference. Remove testnet/Sepolia milestones and mock-stock/test-pool demo fallbacks. First demonstrate an actual automatic raw-key Uniswap mainnet swap, its receipt and the view-only chart update, then add the Privy and Ledger mainnet flows.

Use supported live assets and verify canonical tokens, router/pool identities, usable prices and executable routes. If stock routes are unavailable, demonstrate another supported live pair and mark stock execution incomplete. Local unit tests, fixtures and forks remain development checks; they do not replace the mainnet demo.

Preserve automatic raw-key/Privy signing, Ledger drift tracking plus a fresh connection-triggered prompt and physical confirmation, no sessions/spending caps/budget accounting, and the retained Ledger/Privy prize features. Device work still waits for arrival. Existing source observations about testnet configurations remain factual research history, not a target environment.

This change records the user's environment choice, not a measured gas-price claim. The repository remains planning-only: no wallet, private key, mainnet RPC probe, deployment or transaction was created in this update.

## Independent review prompt (verbatim)

> User: 'do everything on mainnet. testnets are dead now that gas is so cheap'. Root updating active plan/docs to mainnet-only onchain integration/demo, Robinhood4663 first/Base8453 alternative; remove Sepolia/testnet milestones and fallback/demo mock-stock plan. Local unit/fork tests remain development checks, canonical liveassets/routes and actual mainnetreceipt desired. Keep rawkey/Privy auto, Ledgeronconnectphysical, no sessions/spendingcaps/budgets. Read current docs for material stale testnet assumptions or mainnet wording needing correction, without browsing/newrequirements/edits/code/wallets. Return concise points. Do not introduce approval flows or security features.

The reviewer identified testnet milestones and fallback language, the mainnet scope exclusion, and Privy testnet gas sponsorship as evidence that cannot establish mainnet compatibility. The active documents were updated accordingly. No new implementation or network compatibility claim was made.
