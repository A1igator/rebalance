# Technology demo portfolio

Selection date: **2026-09-04, America/Toronto**. Public route observations occurred on September 5 UTC. The [latest human decisions](prompts/014-positive-impact-demo.md) prioritize recognizable technology companies for the judges, retain five assets and keep USDG at 5%.

| Asset | Target | Demo role |
| --- | ---: | --- |
| USDG | 5% | Quote/settlement asset, following the user's cash preference |
| AAPL — Apple | 23.75% | Consumer technology; explicitly selected by the user |
| NVDA — Nvidia | 23.75% | Computing; explicitly selected by the user |
| MSFT — Microsoft | 23.75% | Software and cloud |
| AMD | 23.75% | Computing and semiconductors |

The assistant selected Microsoft and AMD for the remaining technology slots under the user's earlier allocation delegation. Equal stock weights make the rebalance easy to explain; they are not optimized for returns or investment risk. The latest technology focus replaces the briefly configured Sunrun/Moderna slots. Rivian was researched but never configured or purchased.

The user also expressed a preference for positive impact, less rent seeking and monopolistic behavior, and avoiding weapons, fossil fuels, tobacco and gambling. This demonstration does not establish that these technology companies pass an audited ethical, revenue-exclusion or anti-monopoly screen. Their selection emphasizes the user's later technology/name-recognition direction. No automatic ethical scoring or LLM stock selection runs in the monitor.

## Robinhood availability and route evidence

The [official asset API](https://api.robinhood.com/rhj/assets), documented in [Stock Token APIs](https://docs.robinhood.com/chain/stock-token-apis/), returned **194 active stock/ETF token records with chain 4663 deployments** in the captured response. The [catalog CSV](evidence/robinhood-assets-2026-09-04.csv) preserves symbols, names, addresses and status. A listing does not establish usable AMM liquidity or investor eligibility.

Apple and Nvidia have canonical metadata and bidirectional USDG quotes in the [original RWA report](RWA_CHECK.md). New MSFT and AMD checks at block **54,749,167**, timestamp **2026-09-05T02:03:45Z**, used `eth_call` with 0.01 stock-token units and 10 USDG, across fee tiers 100/500/3000/10000. Both tokens have 18 decimals, matching symbols, deployed code, `oraclePaused=false` and `uiMultiplier=1e18` at that block. [Public requests/results](evidence/robinhood-tech-candidates.json).

| Token | Canonical address | Best sample pool fee | USDG for 0.01 token | Tokens for 10 USDG |
| --- | --- | ---: | ---: | ---: |
| MSFT | `0xe93237C50D904957Cf27E7B1133b510C669c2e74` | 0.3% | 4.983925 | 0.019944263287483918 |
| AMD | `0x86923f96303D656E4aa86D9d42D1e57ad2023fdC` | 0.3% | 4.750838 | 0.020922692835618424 |

The best MSFT sample pool was `0xeb60bcd1d920ad6e102690ccfc6fb488899e1510`; AMD's was `0x48d284a2a4d3dc1b3da08231fe44317e7e7aa51f`. These are historical samples, not guaranteed execution prices or liquidity depth at larger sizes. Pool fees are separate from the configured 0.5% slippage tolerance. The runtime selects the best successful direct quote for the actual trade amount and refreshes it before a swap.

The [manifest](../src/assets.ts) retains previously verified TSLA, AMZN, RUN and MRNA entries so existing configurations remain valid. Every profile selects exactly USDG and four known stocks; only that selection is observed and traded. Changing symbols clears cached portfolio/proposal data until a fresh observation. Removing a symbol does not sell an existing holding outside the new tracked set. The actual demo wallet was empty at each selection change.

## Retained earlier research

[Initial impact candidates](evidence/robinhood-impact-candidates.json) were measured at block 54,738,104. RUN and MRNA quoted both ways, as did Rivian. FLNC, NVTS and ELF had zero active liquidity in their discovered direct pools and both sample calls reverted. [Additional checks](evidence/robinhood-impact-additional.json) found the same zero-liquidity/sample-failure result for ABCL and IBRX at block 54,741,122. These findings only cover direct Uniswap v3 pools and the tested sizes, not RFQ, v4 or multihop availability. TE, HIMS and SMR were considered but not probed after the user changed the selection.

The earlier product-impact rationale used [Sunrun's solar/storage business](https://investors.sunrun.com/) and [Moderna's medicine pipeline](https://www.modernatx.com/research/product-pipeline); [Moderna's patent portfolio](https://www.modernatx.com/patents) was recorded as relevant to the user's rent-seeking preference. These sources are company descriptions, not independent ethical certification. Those companies are outside the current demo allocation.

No funded sender simulation, approval, swap or transaction receipt is established by these read-only checks. The local configuration remains unarmed. The [minimal UI](prompts/015-pie-only-ui.md) displays current holdings when funded and explicitly labeled targets when empty. Native ETH remains gas-only.
