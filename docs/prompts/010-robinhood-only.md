# Robinhood mainnet is the sole target — 2026-09-04

## User requests (verbatim, in order)

> no base mainnet it's fine

After the assistant interpreted that as selecting Base, the user corrected it:

> the opposite. robhinhood chain is sole target

## Applied decision

**Robinhood Chain mainnet, chain ID 4663, is the sole target** for live integration, deployments and demo transactions. Remove the Base fallback and alternative-chain selection work. The interrupted turn before the correction only read repository state; no Base-only edit or commit was made.

Remove Base-specific B20/precompile, stock and Helios compatibility assumptions from active requirements. Use Robinhood's canonical assets, routes, price semantics and network verification evidence. If a route is unavailable, evaluate another live pair on Robinhood or record the gap; do not switch chains or use a testnet substitute.

Keep mainnet-only execution, automatic raw-key/Privy signing, Ledger drift tracking and connection-triggered prompts with physical confirmation, no sessions/spending caps/budget accounting, the view-only chart and retained sponsor features. Historical prompts and factual source comparisons remain preserved; they do not define additional project targets.

## Independent review prompt (verbatim)

> User corrected ambiguous prior message: 'the opposite. robhinhood chain is sole target'. Previous interrupted turn only read files; no edits. Root updating active docs to Robinhood mainnet4663 only, removing Base fallback and Base-specific B20/Helios assumptions from active plan/networkrequirements. Keep mainnetonly/no sessions/nocaps/budget, rawkeyPrivyauto, Ledgeronconnectphysical. Read current docs and identify material Base-specific assumptions to remove or mark historical. No new research/requirements/edits/code/wallets. Return concise points.

The reviewer identified the alternative-chain instructions, Base token/verification assumptions, route-failure fallbacks and network-selection milestones. These were corrected. No implementation, runtime probe, wallet or transaction was created.
