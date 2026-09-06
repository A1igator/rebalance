# Robinhood networks and integration evidence

Initial documentation review: **2026-09-04**. Current-state correction: **2026-09-06**. Subsequent public mainnet RPC checks and local wallet setup are recorded below and in the linked evidence. The user-armed app has submitted approvals/swaps and recorded its first complete five-asset rebalance; earlier no-trade and partial-portfolio observations remain historical.

## Decision

**Robinhood mainnet (4663) is the selected network**. The [fee instruction](prompts/017-mainnet-cadence-codex.md) accepts the measured mainnet fees and cancels the conditional testnet migration in [prompt 016](prompts/016-fees-and-testnet.md). Preserve the [fee and testnet research](FEE_CHECK.md) as history. The funded wallet, asset basket and weights are unchanged; the user-started raw-key runner completed its first Apple swap before the next swap became unresolved. The [single-skill launch request](prompts/019-single-skill-arming.md) includes arming, which the current assistant cannot execute against the funded wallet. Ledger's shared EVM configuration includes Robinhood; its CLI quote guard is not a blanket L2 restriction. [Ledger assessment](LEDGER_AGENT_STACK.md)

Verify Robinhood's existing integration path, canonical assets and live Uniswap route. If a required route is unavailable, evaluate another supported live pair on Robinhood or record the unresolved integration. Do not switch chain families or infer token/router identities across networks. The active manifest remains mainnet-specific; the historical testnet candidate is not adopted.

## Stocks and Uniswap

Robinhood documents issuer-backed stock exposure, token transfer/access conditions, RFQ trading and AMM composability. Canonical assets, participant eligibility, acquisition and usable AMM routes remain separate gates. [Stock Tokens](https://docs.robinhood.com/chain/stock-tokens/), [integration](https://docs.robinhood.com/chain/building-with-stock-tokens/), [network reference](https://docs.robinhood.com/chain/connecting/)

Use Robinhood's documented stock-token metadata, transfer behavior and price-feed semantics. Its documented feeds incorporate corporate-action multipliers and operate 24/5. Current runtime values actual ERC20 units through fresh DEX quotes in USDG, without applying another multiplier or depending on those share-price feeds. Advisory `oraclePaused()` is a corporate-action signal, not proof of market hours. DEX quotes may differ from underlying stock prices, including outside stock-market hours. [Price-feed reference](https://docs.robinhood.com/chain/oracles-and-price-feeds/)

The official [Uniswap v4 deployment registry](https://developers.uniswap.org/docs/protocols/v4/deployments) lists Robinhood mainnet. Verify exact contract identities and available pools instead of inferring addresses across chains.

The current demo portfolio is USDG plus four canonical Robinhood stock tokens: AAPL, NVDA, MSFT and AMD. All four stock/USDG Uniswap v3 routes passed bidirectional live quote checks; see [the original RWA report](RWA_CHECK.md), [current demo report](DEMO_PORTFOLIO.md) and retained public evidence. Runtime uses DEX estimates of actual ERC20 units, checks advisory corporate-action pauses and keeps native ETH outside allocations for gas. WETH is excluded. Following user-issued recovery/relaunch, the app recorded completion at **2026-09-05T23:33:58.399Z** with fresh five-asset holdings within its drift threshold. The final swap receipt was checked through public RPC at block **55516741**; [receipt evidence](evidence/robinhood-app-gas-reference.json) retains that transaction. These observations supersede the earlier Apple-only stage without establishing light-client or L1-finality verification. No mock assets or alternative-chain fallback is used.

## Local verification

Robinhood's documented [Nitro full node](https://docs.robinhood.com/chain/run-a-full-node/) has substantial hardware requirements. The [September 6 light-client review](LIGHT_CLIENT_CHECK.md) covers Ethereum/EVM candidates and Union's actual Arbitrum/BoLD verifier. No ready Robinhood application RPC was established; Union's inspected assertion-existence check does not require confirmed settlement. The runtime still uses labelled RPC mode. Keep local-node/light-client claims conditional on an actual compatible verification path, recording L1 anchoring, freshness, finality and bootstrap assumptions. Issuer, oracle and chain governance assumptions remain even with locally verified state.

## Close before implementation claims

- Pin the Ledger package/source and verify network registry, quote/build coverage, final chain ID and later hardware display/signing.
- Preserve chain 4663 asset/router evidence; historical chain 46630 observations are not an active migration path or proof of testnet stock support.
- Validate fresh DEX quotes of actual token units, advisory corporate-action pauses and ordinary slippage/expiry handling. Do not claim independent share-price, market-calendar or sequencer verification.
- Validate the persisted one-hour cycle interval and ten-minute active window, then obtain a user-started mainnet receipt with explicit network and token provenance. Pending receipts must reconcile before the interval gate.
- The manifest and live read-only evidence are recorded in `RWA_CHECK.md`; verification remains RPC mode. The application and funded local wallet exist. The earlier partial result is superseded by the completion evidence above; [recovery details](RECOVERY.md) preserve the intervening recovery stages. Privy/Ledger execution and independent light-client verification remain incomplete.
