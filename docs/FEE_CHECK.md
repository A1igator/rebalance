# Robinhood fee check and testnet research

**Current decision:** the user accepted mainnet fees in [prompt 017](prompts/017-mainnet-cadence-codex.md) and canceled the conditional testnet migration. The original measurements and then-pending choice below are preserved as history; the decision update at the end supersedes that choice.

Observed **September 4, 2026, 22:26–22:39 EDT** (September 5, 02:26–02:39 UTC). This is a point-in-time measurement, not a fixed fee quote.

The [then-current human instruction](prompts/016-fees-and-testnet.md) requested Robinhood testnet before the full demo if mainnet fees were not near one US cent. The measured costs exceeded that target. Mainnet funding was confirmed, but **execution remained unarmed and no app approval or swap was submitted**. Runtime and manifests still used mainnet 4663; a completed testnet migration was not claimed.

## Measured network fees

| Operation | Evidence | Gas price | Network fee in ETH | Approximate USD |
| --- | --- | --- | --- | --- |
| USDG approval for 10 USDG to the configured router | Read-only estimate: 58,789 gas | 0.405042 gwei | 0.000023812014138 | **$0.0584 / 5.84¢** |
| Recent third-party single-pool Uniswap v3 swap | Successful receipt: 131,451 gas | 0.409366 gwei | 0.000053811570066 | **$0.1320 / 13.20¢** |

USD conversion uses the [Coinbase ETH/USD spot API](https://api.coinbase.com/v2/prices/ETH-USD/spot), observed at **$2,453.44 per ETH**, 02:27:53 UTC. [Retained public measurements](evidence/robinhood-mainnet-fees.json) contain timestamps, gas values, sampled blocks, the estimate and receipt calculation. The approval was estimated, not sent.

The [sampled swap receipt](https://robinhoodchain.blockscout.com/tx/0xdabb985445d7443c220e186a1b439f7438c81da981863ad321c727fae0777119) belongs to an unrelated trader and swaps WETH into another token. It establishes an observed single-pool swap fee, **not the exact cost of our stock/USDG swap or full five-asset rebalance**. WETH remains excluded from our portfolio. LP fees, price impact and bridging costs are separate from this comparison.

For Nitro, `eth_estimateGas × gas price` includes parent-chain data posting costs; adding another L1 fee would double-count them. The app's gas-limit padding is an upper allowance, not necessarily gas consumed. [Arbitrum estimation reference](https://docs.arbitrum.io/arbitrum-essentials/how-to-estimate-gas)

The sampled chain was producing blocks and the [chain status page](https://status.robinhoodchain.offchain.io/) reported operational. These fee observations do not establish congestion or an outage.

## Testnet findings and remaining choice

Robinhood documents testnet **46630**, RPC `https://rpc.testnet.chain.robinhood.com`. Live chain identity and block reads succeeded. [Official network reference](https://docs.robinhood.com/chain/connecting/)

- Paxos lists test USDG at `0x7E955252E15c84f5768B83c41a71F9eba181802F`; live code, `symbol() = USDG` and six decimals were observed. [Paxos reference](https://docs.paxos.com/guides/stablecoin/usdg/testnet)
- An independently [published DEX deployment](https://docs.hood.mainnet.games/contracts.html) has deployed factory, quoter and router code. At block **113193572**, quoter/router `factory()` and `WETH9()` matched the published configuration. This is a candidate integration: official Uniswap provenance and equivalence to upstream bytecode were not established.
- The [Robinhood asset catalog](https://api.robinhood.com/rhj/assets) returned no testnet deployments for our AAPL/NVDA/MSFT/AMD selection. Their testnet addresses, corporate-action behavior, pools and usable bidirectional USDG quotes remain **unverified**. An absent catalog entry does not prove that a deployment cannot exist.
- The [testnet faucet](https://faucet.testnet.chain.robinhood.com) was inaccessible to the automated request; no claim or access-control bypass was attempted.

[Retained testnet observations](evidence/robinhood-testnet-check.json) include RPC requests, block identity, metadata, sources and unresolved checks. Large bytecode responses are summarized with byte counts and SHA-256 hashes; this does not constitute an upstream bytecode comparison.

Changing only the chain ID/RPC would leave the app using invalid asset and router assumptions. The user has been asked to choose between clearly labeled demo-issued stock tokens with new testnet pools, or retaining the existing issuer-backed mainnet basket at the measured fees. No answer, mock-token substitution, pool deployment or mainnet fee exception is assumed. Until resolved, preserve the funded wallet and keep execution stopped. This is a demo-network decision, not a new spending-cap or budget-accounting feature.

## Decision update — 2026-09-05

The user subsequently said: “It's fine just do it with those fees for now.” The full [instruction and implementation response](prompts/017-mainnet-cadence-codex.md) retain **Robinhood mainnet 4663**, cancel the conditional testnet migration and request less frequent rebalancing. The measured approval estimate was about **5.84¢**, and the unrelated sample swap cost about **13.20¢** at the recorded ETH/USD price. These remain point-in-time observations, not a fixed price or a cost bound for this portfolio.

A [later comparison retained separately](evidence/robinhood-mainnet-fees-overnight.json), observed at **05:57:15.981 UTC on September 5**, estimated the same 10-USDG approval at **5.90¢** and a [different third-party single-pool swap](https://robinhoodchain.blockscout.com/tx/0xec6eee207be1b936047f3068442bb04c0d2a6c20e2e0fbf916fd81baa2a9f637) at **13.24¢**, using **$2,451.69 per ETH**. The estimate was unsigned; the sample again traded WETH into another token, not this app's stock basket. This is another timestamped comparison, not an overnight price series or completed portfolio rebalance.

The implementation response sets default cycle starts one hour apart, with a fixed ten-minute active window for sequential approval/swap legs and the existing five-percentage-point drift trigger. Timing persists across restarts and target changes; receipt reconciliation runs before the interval gate. This reduces cycle frequency without adding a gas budget, spending cap or one-transaction-per-hour guarantee.

The mainnet wallet, assets, weights and dependencies are unchanged. Testnet stock support remains unverified research rather than a required next step. The funded raw-key monitor remains unarmed pending the user's local start. No app approval, stock swap or live receipt is claimed by this update.

## Application-specific display references — September 6 UTC

Later user-issued launches/recovery completed the first five-asset rebalance, as recorded in the current plan. The [transaction-display request](prompts/031-transaction-fee-display.md) replaces an unhelpful USD-per-gas-unit label with approximate transaction costs. Public RPC independently verified the app's final successful stock/USDG swap at block **55,516,741** using **168,785 gas**, and its preceding USDG approval at block **55,516,707** using **57,976 gas**. [Retained application receipt evidence](evidence/robinhood-app-gas-reference.json) includes identities, canonical block checks, timestamps and actual paid wei.

At the sampled **0.418498 gwei** and **$2,502.05/ETH**, repricing those measured gas units gives approximately **17.67¢ for a swap**, **6.07¢ for approval**, or **23.74¢ combined**. This explains the earlier five-to-six-cent figure: it described an approval. A gas rate such as 0.41786 gwei is a price per unit, not a complete transaction price.

The display uses these historical gas references with live rates; it does not claim a fresh `eth_estimateGas` simulation or guaranteed future cost. Its rebalance range projects remaining legs at fixed observed prices and includes zero through one reference approval per swap. Actual route/token behavior, allowance state, calldata, parent posting fees and market prices can differ; LP fees, price impact and bridging remain separate. The final receipt alone does not establish the complete cycle's aggregate gas spend. This change reloads only the read-only chart service and leaves the funded runner untouched.
