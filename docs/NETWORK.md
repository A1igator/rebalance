# Network candidates and integration gates

Checked **2026-09-04** using official documentation and Ledger source. No RPC probe, wallet, network transaction or liquidity measurement has been performed.

## Decision

The original target, **Robinhood Chain**, remains viable. The user accepts any L2 and asked about Base, so **Base is a recommended alternative**, especially for an initial testnet route and a documented light-client candidate. Do not force a switch based on the incorrect claim that Ledger only supports Ethereum mainnet: its shared EVM configuration includes both candidates. [Ledger assessment](LEDGER_AGENT_STACK.md)

| Candidate | Network IDs | Evidence and open work |
| --- | --- | --- |
| Robinhood | Mainnet 4663; testnet 46630 | Original stock-token target; EVM/Nitro chain, existing Ledger EVM configs and official mainnet Uniswap deployments. Verify testnet route, token metadata and actual stock liquidity. |
| Base | Mainnet 8453; Base Sepolia 84532 | Live Coinbase tokenized stocks, official Uniswap mainnet/testnet deployments and documented Helios support. Verify stock-pair liquidity and B20 verification behavior. |

Prefer testing the existing Robinhood integration path before building a new chain adapter. Base Sepolia is a documented fallback/first-network candidate if Robinhood testnet routing is unavailable. Record the selected manifest before implementation depends on it; never silently switch configured networks.

## Stocks and Uniswap

Base announced live Coinbase tokenized stocks on September 1, including AAPLc and NVDAc. Its launch materials identify Aerodrome liquidity. That does not verify a Uniswap pool for those stocks. [Builder announcement](https://blog.base.org/request-for-builders-tokenized-stocks), [launch](https://blog.base.org/tokenized-stocks)

Base's stocks use native B20 precompiles rather than ordinary per-token deployed bytecode. Validate identity with the canonical registry and documented native semantics. Account for transfer restrictions and paused operations, stock-feed trading hours/freshness, and corporate-action handling. The documented total-return price already incorporates the multiplier; applying it again would misvalue holdings. These details require implementation tests before automated stock valuation. [Technical reference](https://docs.base.org/specifications/b20/tokenized-stocks-on-base)

Robinhood documents issuer-backed stock exposure, token transfer/access conditions, RFQ trading and AMM composability. Canonical assets, participant eligibility, acquisition and usable AMM routes remain separate gates. [Stock Tokens](https://docs.robinhood.com/chain/stock-tokens/), [integration](https://docs.robinhood.com/chain/building-with-stock-tokens/), [network reference](https://docs.robinhood.com/chain/connecting/)

The official [Uniswap v4 deployment registry](https://developers.uniswap.org/docs/protocols/v4/deployments) lists Base and Base Sepolia, as well as Robinhood mainnet. The reviewed testnet table did not establish Robinhood testnet deployments. Verify exact contract identities and available pools instead of inferring addresses across chains.

First demonstrate an actual Uniswap testnet swap using supported liquid test assets; ETH/USDC is a candidate, not a verified route. Canonical stock holdings can be displayed independently, but a claim of stock rebalancing requires actual executable stock routes and valid price/transfer behavior. Label test stock tokens plainly. Using Aerodrome alone would not demonstrate our Uniswap integration. Local simulations/forks are tests, not network receipts.

## Local verification

[Helios documents Base/OP Stack support](https://github.com/a16z/helios/blob/master/README.md#op-stack), making it a promising candidate. Compatibility with new native B20 behavior and the exact state calls used by the rebalancer has not been verified. Do not equate a generic Base README entry with a proved stock-balance/price verification path.

Robinhood's documented [Nitro full node](https://docs.robinhood.com/chain/run-a-full-node/) has substantial hardware requirements. The reviewed Helios documentation does not establish Robinhood/Nitro support. Keep remote RPC, local node and light-client modes distinct, and record L1 anchoring/finality/bootstrap assumptions for any verified mode. Issuer, oracle and chain governance assumptions remain even with locally verified state.

## Close before implementation claims

- Pin the Ledger package/source and verify network registry, quote/build coverage, final chain ID and later hardware display/signing.
- Verify network IDs, canonical assets/decimals/semantics, Uniswap router/pool identities and actual route depth.
- Select and validate price sources, market-calendar behavior, pauses, sequencer status and independent slippage/price bounds.
- Complete an actual testnet transaction and receipt, clearly distinguished from a simulation.
- Record the selected chain and verification mode; mainnet trading is outside this planning task.
