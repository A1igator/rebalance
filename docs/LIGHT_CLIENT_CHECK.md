# Robinhood light-client assessment

Reviewed **2026-09-06** from primary documentation and public source. [Human requests](prompts/033-light-client-review.md). Union source was inspected at revision `031785bb6dc6b957c624e62bc64c184409c97d7b`. This review does not establish a running compatible client.

## Finding

Local verification remains a product goal. The current app trusts Robinhood RPC for chain reads; receipt/block consistency checks do not independently establish canonical consensus or L1 finality. RPC was the initial integration path, not proof that a light client is impossible.

A light client can itself expose a local RPC and fetch proofs from remote providers. The missing property is authenticating those answers locally. Ethereum's [light-client explanation](https://ethereum.org/developers/docs/nodes-and-clients/light-clients/) describes header authentication and proofs. Robinhood uses Nitro, so Ethereum header verification alone does not establish its L2 state; EVM execution compatibility is not consensus compatibility.

## Candidates

| Candidate | Verified scope | Robinhood application fit |
| --- | --- | --- |
| [Helios](https://github.com/a16z/helios/blob/master/README.md) | Documents Ethereum, OP Stack (Optimism/Base) and Linea. Exposes application RPC methods. | No documented Nitro/Robinhood backend found. Changing its chain ID or upstream URL is insufficient. |
| [Nimbus verified proxy](https://nimbus.team/about/clients/), [Lodestar](https://ethereum.org/developers/docs/nodes-and-clients/light-clients/), [Nethereum](https://docs.nethereum.com/docs/consensus-light-client/overview/) | Ethereum beacon light-client verification, with execution/proxy functionality varying by client. | Potential Ethereum parent-chain component; no Robinhood verification path established. |
| [Colibri Stateless](https://github.com/corpus-core/colibri-stateless) | Repository describes Ethereum verification and upcoming L2 support such as OP Stack. | Its broader EVM description does not establish an available Nitro backend. |
| [Union Arbitrum verifier](https://github.com/unionlabs/union/blob/main/lib/arbitrum-verifier/src/lib.rs) | Contains legacy and post-BoLD Arbitrum proof verification. Its [CosmWasm client](https://github.com/unionlabs/union/blob/main/cosmwasm/lightclient/arbitrum/src/client.rs) obtains the parent root from an Ethereum light-client consensus state. | Reusable interoperability machinery, not a ready local balance/Uniswap-quote RPC. Robinhood contracts, layout and ArbOS compatibility remain untested. |
| [Espresso rollup-node proxy](https://github.com/EspressoSystems/espresso-rollup-node-proxy) | Supports Nitro and selects Espresso-finalized heights while forwarding application requests to a full node. | Not balance/storage/quote proof verification; requires Espresso integration, which was not established for Robinhood. |
| [Robinhood Nitro full node](https://docs.robinhood.com/chain/run-a-full-node/) | Officially documented Robinhood node with chain-specific configuration and genesis. | Available full-node path, not light: documented minimum 64 GB RAM and several TB of NVMe storage, plus Ethereum execution/beacon access. |

## Union's important verification boundary

The inspected post-BoLD verifier authenticates the rollup account against an L1 root, binds the L2 header to an assertion and verifies assertion storage. Its assertion status check accepts an existing assertion; it does not require the confirmed status. Therefore this component alone proves inclusion of an asserted state, not that disputes have completed or the assertion is correct. Other system components may select stronger inputs, but that was not established for Robinhood. See the pinned [status check](https://github.com/unionlabs/union/blob/031785bb6dc6b957c624e62bc64c184409c97d7b/lib/arbitrum-verifier/src/lib.rs#L135) and [status enum](https://github.com/unionlabs/union/blob/031785bb6dc6b957c624e62bc64c184409c97d7b/lib/arbitrum-types/src/lib.rs#L312): the check also accepts pending assertions.

Union's [Voyager architecture](https://docs.union.build/architecture/voyager/concepts/) concerns client/consensus states and IBC proofs. Supporting that protocol does not automatically provide locally verified arbitrary `eth_call`, transaction receipts or Nitro-specific execution semantics for this app.

## What an integration would need to demonstrate

1. Authenticate Ethereum headers from an explicit checkpoint and prove the correct Robinhood rollup contract/state against that root.
2. Authenticate the chosen Robinhood block, with explicit distinctions between a sequencer view, an assertion and settled state. Quantify freshness before using the result for trading.
3. Verify account/storage/code and receipt data against that block. Execute balance and Uniswap quote calls locally with compatible semantics, or use an independently checked execution proof.
4. Demonstrate rejection of a tampered answer and a stale or wrong-network root. Identify any application method still forwarded without verification.

These are acceptance criteria for a future integration, not implemented features. Arbitrum's [finality documentation](https://docs.arbitrum.io/how-arbitrum-works/deep-dives/finality) distinguishes provisional sequencer ordering, finalized batch data and assertion settlement, with the last ordinarily taking days under BoLD. Its indicative timings are not a measurement of Robinhood's configuration. Settled-state verification and fresh trade inputs are separate requirements; accepting an unconfirmed assertion trades away some assurance. A full node has its own bootstrap, L1 access and chain-governance assumptions. Local verification also does not conceal public transactions or necessarily hide queries from proof providers.

No new client dependency, custom verifier, chain switch or live execution change is adopted by this review. The strongest lead for a future Nitro light-client feasibility check is existing Union verification code plus an Ethereum light client, with its incomplete application coverage and assertion-status boundary made explicit.
