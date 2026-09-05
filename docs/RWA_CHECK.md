# Five-asset Robinhood RWA route check

The initial portfolio is **USDG, TSLA, AAPL, NVDA and AMZN**. All four canonical stock tokens have real, bidirectionally quotable Uniswap v3 pools against USDG. Native ETH pays gas and is outside the portfolio.

Read-only snapshot: block **54714275** (`0x342dfa3`), hash `0x87fecbfc44c340757e5e959bfc57d1eb30d929cf0bfcb8fffe953e19b5339e93`, timestamp **2026-09-05T01:05:05+00:00**. Public requests, responses, failures and decoded results are retained in [robinhood-rwa.json](evidence/robinhood-rwa.json). No wallet was connected, funds moved or transaction submitted.

## Canonical assets

| Asset | Robinhood mainnet contract | Decimals |
| --- | --- | ---: |
| USDG | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` | 6 |
| TSLA | `0x322F0929c4625eD5bAd873c95208D54E1c003b2d` | 18 |
| AAPL | `0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9` | 18 |
| NVDA | `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC` | 18 |
| AMZN | `0x12f190a9F9d7D37a250758b26824B97CE941bF54` | 18 |

Stock addresses came from Robinhood's [documented asset API](https://docs.robinhood.com/chain/stock-token-apis/) and its [public metadata response](https://api.robinhood.com/rhj/assets); USDG comes from the [canonical contract page](https://docs.robinhood.com/chain/contracts/). All four stocks were marked active. Live contract reads confirmed code, exact symbols, 18 decimals, and `oraclePaused() = false`. AAPL's `uiMultiplier()` was `1000566080061092436`; the other three were `1000000000000000000`. No future multiplier changes were observed.

## Direct Uniswap routes

The [official Uniswap manifest](https://developers.uniswap.org/deployments.json) identifies factory `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA`, QuoterV2 `0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7` and SwapRouter02 `0xCaf681a66D020601342297493863E78C959E5cb2`. Their earlier code/identity evidence is in [the initial route check](ROUTE_CHECK.md).

The factory returned 14 nonzero pools across four standard fee tiers per stock. Pool code, token order, factory, fee, active liquidity and slot0 were read at the snapshot. The samples were **0.01 stock token** (`10000000000000000` raw) and **10 USDG** (`10000000` raw). Best outputs at these exact sizes:

| Stock | Fee (millionths) | Pool | USDG out for 0.01 token | Tokens out for 10 USDG |
| --- | ---: | --- | ---: | ---: |
| TSLA | 500 | `0xc4f0172d6ac8dd294dd1137d047d5e1893760236` | 3.537885 | 0.028237089981093013 |
| AAPL | 500 | `0xaae0d815ee56e4092a5e5c2911e676fea50b2d6d` | 3.205897 | 0.03116129791049855 |
| NVDA | 500 | `0xd4eb21209c4d6093f80b5b84f5c45cc093ea14a3` | 2.300196 | 0.043431080807934925 |
| AMZN | 3000 | `0x8ac92da74ab5f3b1d024dc1943ad7e15dc4179ef` | 2.577711 | 0.038561677278180803 |

Fee 500 means 0.05%; 3000 means 0.3%. AAPL has no fee-100 pool and AMZN has no fee-500 pool. Some other existing pools had zero active liquidity or reverted; NVDA's fee-100 pool quoted only one direction at the sample amounts. Pool existence is therefore insufficient. Runtime discovers available fee pools through the official factory and chooses the best successful quote for the actual direction and amount.

## Runtime valuation and corporate actions

The UI values actual ERC20 token balances using small stock-to-USDG onchain quotes, with USDG as the unit reference. These are **DEX estimates in USDG**, not independently verified USD share prices. Values can diverge from the underlying stock market, including while it is closed. Fresh exact-amount quotes, integer minimum outputs, a router-enforced deadline and sender simulation remain required for execution.

Robinhood's [integration guide](https://docs.robinhood.com/chain/building-with-stock-tokens/) defines raw balances and the share-equivalent multiplier separately. Raw `balanceOf()` units do not rebase. Since the DEX already quotes those actual token units, runtime does **not** multiply their quoted value again. It reads `uiMultiplier()` for disclosure and refuses new trades when a relevant token reports `oraclePaused()`. Robinhood describes that flag as advisory during corporate actions; it does not prove that markets are open. [Oracle semantics](https://docs.robinhood.com/chain/oracles-and-price-feeds/).

## Feed research retained for a later independent valuation path

The following official Chainlink proxies also returned nonempty code, 8 decimals, positive round answers and nonzero update times. They are **not used by the current runtime**.

| Feed | Proxy | Last answer in USD | Age at snapshot (seconds) |
| --- | --- | ---: | ---: |
| TSLA | `0x4A1166a659A55625345e9515b32adECea5547C38` | 353.98495 | 24629 |
| AAPL | `0x6B22A786bAa607d76728168703a39Ea9C99f2cD0` | 320.51633525 | 18819 |
| NVDA | `0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15` | 230.23665 | 26321 |
| AMZN | `0xD5a1508ceD74c084eBf3cBe853e2C968fB2a651C` | 258.725 | 19137 |
| USDG | `0x61B7e5650328764B076A108EFF5fa7282a1B9aD2` | 1.00007 | 34497 |

The [official Robinhood Chainlink page](https://docs.chain.link/data-feeds/tokenized-equity-feeds/robinhood) loads the [reference directory](https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json); its source trace and the five selected records are retained in the evidence. The directory specified 86,400-second heartbeat and 0.5% deviation threshold for these feeds; stock market-hours metadata is 24/5. Chainlink explains that stock feeds can hold the last known price during closed markets, holidays or thin overnight trading. Heartbeat age is not a reliable market-open flag.

Robinhood's Chainlink token prices already incorporate corporate-action multipliers. A future independent valuation must use the proxy, validate answer/decimals/round completeness, handle market closures and pauses, and avoid applying the multiplier twice. No documented Robinhood-specific sequencer uptime proxy was established; the [official uptime list](https://docs.chain.link/data-feeds/l2-sequencer-feeds) does not supply one. Do not reuse another L2's address or claim sequencer-verified prices.

## Access and remaining execution checks

Robinhood documents standard ERC20 holding/transfers and AMM compatibility; direct issuer mint/burn requires Authorized Participant onboarding. Its [stock-token overview](https://docs.robinhood.com/chain/stock-tokens/) also describes issuer debt securities and jurisdiction/eligibility restrictions, including restrictions relevant to Canada. Technical wallet compatibility and successful quotes do not establish legal eligibility or direct share ownership. No prohibition specific to secondary AMM trading outside underlying-market hours was found in the cited integration docs; this is not a claim that trading is unrestricted.

A successful funded sender simulation, exact approval, signed swap and confirmed receipt remain unverified. Ledger hardware/backend compatibility remains a separate integration check. Public RPC data and the issuer remain trust dependencies.
