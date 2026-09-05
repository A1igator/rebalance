# Robinhood mainnet and integration gates

Checked **2026-09-04** using official documentation and Ledger source. No RPC probe, wallet, network transaction or liquidity measurement has been performed.

## Decision

**Robinhood Chain mainnet, chain ID 4663, is the sole target** for all live integration, deployments and demo transactions. The [user's clarification](prompts/010-robinhood-only.md) supersedes earlier alternative-chain planning. Ledger's shared EVM configuration includes Robinhood; its CLI quote guard is not a blanket L2 restriction. [Ledger assessment](LEDGER_AGENT_STACK.md)

Verify Robinhood's existing integration path, canonical assets and live Uniswap route. If a required route is unavailable, evaluate another supported live pair on Robinhood or record the unresolved integration. Do not switch chains or testnets. Pin the Robinhood manifest before implementation depends on it.

## Stocks and Uniswap

Robinhood documents issuer-backed stock exposure, token transfer/access conditions, RFQ trading and AMM composability. Canonical assets, participant eligibility, acquisition and usable AMM routes remain separate gates. [Stock Tokens](https://docs.robinhood.com/chain/stock-tokens/), [integration](https://docs.robinhood.com/chain/building-with-stock-tokens/), [network reference](https://docs.robinhood.com/chain/connecting/)

Use Robinhood's documented stock-token metadata, transfer behavior and price-feed semantics. Its documented feeds incorporate corporate-action multipliers and operate 24/5; verify canonical feeds, freshness and pauses before valuation. Do not apply another chain's token/precompile assumptions. [Price-feed reference](https://docs.robinhood.com/chain/oracles-and-price-feeds/)

The official [Uniswap v4 deployment registry](https://developers.uniswap.org/docs/protocols/v4/deployments) lists Robinhood mainnet. Verify exact contract identities and available pools instead of inferring addresses across chains.

First demonstrate an actual Uniswap swap on Robinhood mainnet using supported live assets; ETH/USDC is a candidate, not a verified route. Canonical stock holdings can be displayed independently, but a claim of stock rebalancing requires executable stock routes and valid price/transfer behavior. If stocks lack a usable route, demonstrate another supported live pair on Robinhood and mark stock execution incomplete; do not substitute mock stocks or test pools. Local simulations/forks remain development tests, with actual Robinhood mainnet receipts required for the demo.

## Local verification

Robinhood's documented [Nitro full node](https://docs.robinhood.com/chain/run-a-full-node/) has substantial hardware requirements. The reviewed [Helios documentation](https://github.com/a16z/helios/blob/master/README.md) does not establish Robinhood/Nitro support. Use a labelled Robinhood RPC mode first; keep local-node/light-client claims conditional on an actual compatible verification path. Record L1 anchoring/finality/bootstrap assumptions. Issuer, oracle and chain governance assumptions remain even with locally verified state.

## Close before implementation claims

- Pin the Ledger package/source and verify network registry, quote/build coverage, final chain ID and later hardware display/signing.
- Verify chain ID 4663, Robinhood assets/decimals/semantics, Uniswap router/pool identities and actual route depth.
- Select and validate price sources, market-calendar behavior, pauses, sequencer status and independent slippage/price bounds.
- Complete an actual Robinhood mainnet transaction and receipt, clearly distinguished from a local test/simulation.
- Record the Robinhood manifest and verification mode. The current repository remains planning-only; no wallet setup or transaction has occurred.
