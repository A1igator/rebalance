# Robinhood mainnet route check

A real WETH/USDG Uniswap v3 route passed read-only checks on **chain 4663**. Prefer the existing **0.01% fee pool** for the first implementation; it gave the best output in both sampled directions. This establishes a quotable route at one block, not a completed wallet swap.

Checked on **2026-09-04 America/Toronto / 2026-09-05 UTC**. Snapshot block **54700617** (`0x342aa49`), hash `0x17d87939f4ec86f955be5cc7d9e5c0085156140a39c97ffaa4ba67eab3c5717d`, timestamp **2026-09-05T00:42:11+00:00**. Exact requests and responses are in [robinhood-mainnet.json](evidence/robinhood-mainnet.json).

## Proposed chain manifest

| Field | Value |
| --- | --- |
| Chain ID | `4663` (`0x1237`) |
| Public RPC | `https://rpc.mainnet.chain.robinhood.com` |
| Explorer | `https://robinhoodchain.blockscout.com` |
| Native gas asset | ETH, 18 decimals |
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`, 18 decimals |
| USDG | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`, 6 decimals |
| Uniswap v3 factory | `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA` |
| QuoterV2 | `0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7` |
| SwapRouter02 | `0xCaf681a66D020601342297493863E78C959E5cb2` |
| Initial pool | `0x52e65b17fb6e5ba00ed806f37afcd2daa50271ca` |
| Initial fee | `100` (0.01%) |

Chain/RPC details come from [Robinhood connecting docs](https://docs.robinhood.com/chain/connecting/); token addresses from [Robinhood's canonical contract list](https://docs.robinhood.com/chain/contracts/); Uniswap addresses from its [official deployment manifest](https://developers.uniswap.org/deployments.json), generated 2026-07-15 with source commit `37936185dee7decf681360ec799c124e0e034672`. The JSON evidence retains the chain-4663 deployment records. Pool addresses were discovered by calling the official factory's `getPool`.

## Measured results

The official public RPC and Ledger's [configured Robinhood RPC](https://github.com/LedgerHQ/ledger-live/blob/6f9b570de882356b1660e75b7c747ef2887fde13/libs/ledger-live-common/src/families/evm/config.ts#L1101) each returned chain ID `0x1237`. The public RPC supplied all subsequent reads, pinned to the snapshot block.

The two token contracts, factory, QuoterV2 and SwapRouter02 all have nonempty bytecode. WETH/USDG report the expected symbols and 18/6 decimals. QuoterV2 and SwapRouter02 each report the expected factory and WETH9. All four pools have code, the expected factory, token0=WETH, token1=USDG, the stated fee, nonzero active liquidity, and `unlocked=true`.

Each quote calls `QuoterV2.quoteExactInputSingle((address,address,uint256,uint24,uint160))` through `eth_call`, with `sqrtPriceLimitX96=0`. The amounts are **0.001 WETH** (`1000000000000000`) and **10 USDG** (`10000000`). These are snapshot quotes, not guaranteed future prices or total transaction gas estimates.

| Fee | Pool | Active liquidity (raw) | USDG out for 0.001 WETH | WETH out for 10 USDG |
| --- | --- | ---: | ---: | ---: |
| 100 (0.01%) | `0x52e65b17fb6e5ba00ed806f37afcd2daa50271ca` | 10701353456897000605 | 2.455075 | 0.004072379493568423 |
| 500 (0.05%) | `0x69bfaf19c9f377bb306a89aed9f6b07e2c1a8d9a` | 952152779518087486 | 2.453322 | 0.004072028447072053 |
| 3000 (0.3%) | `0xa9188730fe85be88ad499d7d52b099e800fb0334` | 166984887763458208 | 2.441140 | 0.004071897426144107 |
| 10000 (1%) | `0x5f009e071f07e92b6c624e83f52f17bbda34680d` | 216115033431308 | 2.409599 | 0.004062790184508452 |

An initial sandbox request failed DNS resolution, and the first unsandboxed JSON-RPC batch received HTTP 403. Subsequent individual requests with an explicit task User-Agent succeeded; the cause of the batch failure was not established. The retained evidence includes the unsandboxed failure and successful calls. Prefer individual calls until batching is separately checked.

## Implementation boundary

- Use WETH/USDG as the first real pair. A canonical USDC contract and stock-token routes were not established in this check.
- Obtain fresh block-pinned quotes for the real amount before execution; select by actual output, not permanently by the sample winner. Exact integer amounts and the 18/6 decimal difference matter.
- Native ETH needs the router's payable wrapping path; receiving native ETH needs its unwrap path. Validate the exact SwapRouter02 ABI, approval spender, minimum output, expiry, recipient and chain ID when building transactions. These transaction paths were not exercised here.
- Simulate and estimate gas for the actual sender, then require a successful receipt before treating a rebalance as complete. No wallet was connected, no funds moved, and no approval or swap was submitted during this check.
- Public RPC responses are trusted observations. Matching chain IDs and contract metadata do not constitute local consensus verification, and this check does not establish a Robinhood light-client path.
- Ledger device compatibility and its hosted swap backend's pair support remain separate checks. This route can be quoted directly through the official onchain QuoterV2 without an LLM or a hosted quote API.
