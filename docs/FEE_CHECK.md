# Robinhood fee check and pending testnet migration

Observed **September 4, 2026, 22:26–22:39 EDT** (September 5, 02:26–02:39 UTC). This is a point-in-time measurement, not a fixed fee quote.

The [latest human instruction](prompts/016-fees-and-testnet.md) requests Robinhood testnet before the full demo if mainnet fees are not near one US cent. The measured costs exceed that target. Mainnet funding is confirmed, but **execution remains unarmed and no app approval or swap was submitted**. Current runtime and manifests still use mainnet 4663; a completed testnet migration is not claimed.

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
