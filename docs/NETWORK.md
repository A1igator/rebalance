# Robinhood mainnet and integration gates

Checked **2026-09-04** using official documentation and Ledger source. No RPC probe, wallet, network transaction or liquidity measurement has been performed.

## Decision

**Robinhood Chain mainnet, chain ID 4663, is the sole target** for all live integration, deployments and demo transactions. The [user's clarification](prompts/010-robinhood-only.md) supersedes earlier alternative-chain planning. Ledger's shared EVM configuration includes Robinhood; its CLI quote guard is not a blanket L2 restriction. [Ledger assessment](LEDGER_AGENT_STACK.md)

Verify Robinhood's existing integration path, canonical assets and live Uniswap route. If a required route is unavailable, evaluate another supported live pair on Robinhood or record the unresolved integration. Do not switch chains or testnets. Pin the Robinhood manifest before implementation depends on it.

## Stocks and Uniswap

Robinhood documents issuer-backed stock exposure, token transfer/access conditions, RFQ trading and AMM composability. Canonical assets, participant eligibility, acquisition and usable AMM routes remain separate gates. [Stock Tokens](https://docs.robinhood.com/chain/stock-tokens/), [integration](https://docs.robinhood.com/chain/building-with-stock-tokens/), [network reference](https://docs.robinhood.com/chain/connecting/)

Use Robinhood's documented stock-token metadata, transfer behavior and price-feed semantics. Its documented feeds incorporate corporate-action multipliers and operate 24/5; verify canonical feeds, freshness and pauses before valuation. Do not apply another chain's token/precompile assumptions. [Price-feed reference](https://docs.robinhood.com/chain/oracles-and-price-feeds/)

The official [Uniswap v4 deployment registry](https://developers.uniswap.org/docs/protocols/v4/deployments) lists Robinhood mainnet. Verify exact contract identities and available pools instead of inferring addresses across chains.

The live portfolio is USDG plus four canonical Robinhood stock tokens: TSLA, AAPL, NVDA and AMZN. All four stock/USDG Uniswap v3 routes passed bidirectional live quote checks; see [the RWA report](RWA_CHECK.md) and retained public evidence. Runtime uses DEX estimates of actual ERC20 units, checks advisory corporate-action pauses and keeps native ETH outside allocations for gas. WETH is excluded. A funded sender simulation and actual receipts are still required before claiming completed stock rebalancing. No mock assets or alternative-chain fallback is used.

## Local verification

Robinhood's documented [Nitro full node](https://docs.robinhood.com/chain/run-a-full-node/) has substantial hardware requirements. The reviewed [Helios documentation](https://github.com/a16z/helios/blob/master/README.md) does not establish Robinhood/Nitro support. Use a labelled Robinhood RPC mode first; keep local-node/light-client claims conditional on an actual compatible verification path. Record L1 anchoring/finality/bootstrap assumptions. Issuer, oracle and chain governance assumptions remain even with locally verified state.

## Close before implementation claims

- Pin the Ledger package/source and verify network registry, quote/build coverage, final chain ID and later hardware display/signing.
- Verify chain ID 4663, Robinhood assets/decimals/semantics, Uniswap router/pool identities and actual route depth.
- Select and validate price sources, market-calendar behavior, pauses, sequencer status and independent slippage/price bounds.
- Complete an actual Robinhood mainnet transaction and receipt, clearly distinguished from a local test/simulation.
- The manifest and live read-only evidence are recorded in `RWA_CHECK.md`; verification remains RPC mode. The application and local wallet now exist. No funded swap or receipt has occurred.
