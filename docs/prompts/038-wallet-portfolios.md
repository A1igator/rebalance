# Wallet-scoped portfolios and chat attachment — 2026-09-07

## Human request

> the portfolio itself should be per wallet too eh? and they all determinstically run underneat. the chat can just choose what it connects to

## Plan committed before implementation

Give each Robinhood wallet its own saved allocation, holdings, pending transactions, recovery history, cadence, stop state, process locks and event delivery state. A conversation attachment selects which wallet commands/display refer to; changing attachment does not change signer configuration, funds, targets or running services. Existing armed wallets continue independently without an agent or chart connection.

Preserve the existing legacy wallet's data directory and running process in place. Add an address-keyed public registry and isolated data directories for additional wallets; never copy or migrate keys, transaction records or live process locks. Keep one portfolio per chain/address even if signing modes differ. Explicit new portfolios require their own targets. Reject attempts to change an existing portfolio's wallet identity through ordinary configuration.

Use the existing deterministic runner per wallet, with subprocesses pinned to their wallet directory before runtime imports. Add wallet list/add/connect and explicit wallet scope for commands. Store conversation selection by stable session identity, never as a global active wallet. Preserve exact native hook identity and pre-launch stop checks for the selected wallet. Native hook dispatch still requires the user's direct invocation and existing permissions.

Give each wallet a stable local chart port/URL so simultaneous chats cannot change another chart's data. Keep charts view-only. Keep notification events and acknowledgements pinned to their originating wallet, regardless of the chat's later selection. No periodic LLM supervisor, session-key contracts, spending caps or budget accounting.

Implementation is tested in isolated fixtures with disposable/no keys, mocked RPC and local services. Verify two wallets can have different targets/pending/cadence/stop/notification states, simultaneous independent service locks, separate charts and independent conversation attachments; preserve legacy compatibility and existing launch/stop/recovery semantics. Do not activate additional funded trading or change the existing runner as part of implementation.

## Delegation

One reviewer assesses registry, native session and notification boundaries. Another implements separate chart-port handling and fixture coverage. Root implements registry, CLI routing, identity protection and agent instructions. All reviews/tests exclude live signing, transfers and credential inspection.
