# Network candidates and integration gates

Checked **2026-09-04** using official documentation and Ledger source. No RPC probe, wallet, network transaction or liquidity measurement has been performed.

## Decision

All live integration, deployments and demo transactions are **mainnet-only**, per the [user's decision](prompts/009-mainnet-only.md). **Robinhood Chain mainnet is the first target**, with **Base mainnet as the alternative** under the any-L2 preference. Base also has a documented light-client candidate. Ledger's shared EVM configuration includes both; its CLI quote guard is not a blanket L2 restriction. [Ledger assessment](LEDGER_AGENT_STACK.md)

| Candidate | Mainnet ID | Evidence and open work |
| --- | --- | --- |
| Robinhood | 4663 | Original stock-token target; EVM/Nitro chain, existing Ledger EVM config and official mainnet Uniswap deployments. Verify the live route, token metadata and stock liquidity. |
| Base | 8453 | Live Coinbase tokenized stocks, official Uniswap mainnet deployments and documented Helios support. Verify stock-pair liquidity and B20 verification behavior. |

Verify the existing Robinhood mainnet integration path first. If its required route is unavailable, evaluate Base mainnet. Record the selected manifest before implementation depends on it; never silently switch configured networks or fall back to a testnet.

## Stocks and Uniswap

Base announced live Coinbase tokenized stocks on September 1, including AAPLc and NVDAc. Its launch materials identify Aerodrome liquidity. That does not verify a Uniswap pool for those stocks. [Builder announcement](https://blog.base.org/request-for-builders-tokenized-stocks), [launch](https://blog.base.org/tokenized-stocks)

Base's stocks use native B20 precompiles rather than ordinary per-token deployed bytecode. Validate identity with the canonical registry and documented native semantics. Account for transfer restrictions and paused operations, stock-feed trading hours/freshness, and corporate-action handling. The documented total-return price already incorporates the multiplier; applying it again would misvalue holdings. These details require implementation tests before automated stock valuation. [Technical reference](https://docs.base.org/specifications/b20/tokenized-stocks-on-base)

Robinhood documents issuer-backed stock exposure, token transfer/access conditions, RFQ trading and AMM composability. Canonical assets, participant eligibility, acquisition and usable AMM routes remain separate gates. [Stock Tokens](https://docs.robinhood.com/chain/stock-tokens/), [integration](https://docs.robinhood.com/chain/building-with-stock-tokens/), [network reference](https://docs.robinhood.com/chain/connecting/)

The official [Uniswap v4 deployment registry](https://developers.uniswap.org/docs/protocols/v4/deployments) lists Base and Robinhood mainnet. Verify exact contract identities and available pools instead of inferring addresses across chains.

First demonstrate an actual Uniswap mainnet swap using supported live assets; ETH/USDC is a candidate, not a verified route. Canonical stock holdings can be displayed independently, but a claim of stock rebalancing requires actual executable stock routes and valid price/transfer behavior. If stocks lack a usable route, demonstrate the supported live pair and mark stock execution incomplete; do not substitute mock stocks or test pools. Using Aerodrome alone would not demonstrate our Uniswap integration. Local simulations/forks remain development tests, with actual mainnet receipts required for the demo.

## Local verification

[Helios documents Base/OP Stack support](https://github.com/a16z/helios/blob/master/README.md#op-stack), making it a promising candidate. Compatibility with new native B20 behavior and the exact state calls used by the rebalancer has not been verified. Do not equate a generic Base README entry with a proved stock-balance/price verification path.

Robinhood's documented [Nitro full node](https://docs.robinhood.com/chain/run-a-full-node/) has substantial hardware requirements. The reviewed Helios documentation does not establish Robinhood/Nitro support. Keep remote RPC, local node and light-client modes distinct, and record L1 anchoring/finality/bootstrap assumptions for any verified mode. Issuer, oracle and chain governance assumptions remain even with locally verified state.

## Close before implementation claims

- Pin the Ledger package/source and verify network registry, quote/build coverage, final chain ID and later hardware display/signing.
- Verify network IDs, canonical assets/decimals/semantics, Uniswap router/pool identities and actual route depth.
- Select and validate price sources, market-calendar behavior, pauses, sequencer status and independent slippage/price bounds.
- Complete an actual mainnet transaction and receipt, clearly distinguished from a local test/simulation.
- Record the selected mainnet and verification mode. The current repository remains planning-only; no wallet setup or transaction has occurred.
