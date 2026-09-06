# Light-client compatibility review — 2026-09-06

## Human requests

Following questions about local execution and agent-independent background operation:

> why not lightnode over RPC

The human supplied <https://ethereum.org/developers/docs/nodes-and-clients/light-clients/>, then requested:

> also check if any arbitrum light client works

> or evm/ethereum ones

## Research scope and result

Review current primary documentation and existing client source for Robinhood mainnet, including Ethereum/EVM clients and Arbitrum/Nitro verification. Distinguish a compatible application RPC from reusable interoperability proofs, remote node proxies and future support. Preserve the existing network and live runtime.

[The assessment](../LIGHT_CLIENT_CHECK.md) records the result: no ready Robinhood application light client was established. Union supplies Arbitrum/BoLD proof machinery, but its inspected verifier's assertion-existence check must not be described as confirmed rollup settlement. Ethereum light clients can supply a parent-chain trust anchor; they do not by themselves authenticate Robinhood state. This is a source review, not a successful client integration or a claim that no compatible implementation could exist.

Only research/provenance documentation and stale current-state wording in the network report were changed. No software was installed or adopted, no client was run against Robinhood, and no trading or agent-hook state was changed.
