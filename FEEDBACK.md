# Uniswap developer feedback

**Status: exercised through live reads and local ABI/transaction tests; funded swap pending.** No developer feedback form has been submitted. Target: [ETHOnline 2026 — Best Uniswap Stack Contribution, From Scratch](https://ethglobal.com/events/ethonline2026/prizes/uniswap-foundation).

## Integration exercised

Robinhood mainnet (4663), Uniswap v3 factory, QuoterV2 and SwapRouter02; direct calls through viem 2.56.3. The five portfolio assets are USDG, TSLA, AAPL, NVDA and AMZN. [RWA evidence](docs/RWA_CHECK.md) records official deployment sources, live pools, actual bidirectional quotes, failed quote attempts and remaining execution checks. [chain.ts](src/chain.ts) constructs exact-input quotes, exact approvals and deadline multicalls; [transaction tests](tests/transactions.test.ts) exercise local signing/recovery against mocked RPC.

## What worked

- The official chain deployment manifest supplied factory/periphery addresses that matched live contract identity reads. It enabled a direct local integration without a hosted quote API or application LLM.
- Factory discovery plus QuoterV2 established real stock/USDG routes. Existing ABI primitives allow the same deterministic planner and raw-key path to support the five assets.
- The router's deadline multicall provides a clear expiry boundary around its exact-input operation.

## Concrete friction and suggestions

- SwapRouter02's `exactInputSingle` tuple has seven fields and **no deadline**, unlike common older SwapRouter examples. We verified the actual interface and used `multicall(uint256,bytes[])` to enforce expiry. A prominent side-by-side example distinguishing these routers would prevent valid-looking but incorrect calldata.
- A nonzero factory pool is not sufficient route evidence. We observed empty/reverting pools and a sample pool that quoted only one direction. An example selecting successful amount-specific quotes across fee tiers, preserving failed responses, would help new integrations avoid equating pool existence with executability.
- Native asset and ERC20 paths need clear treatment in examples. The initial WETH spike demonstrated quoting, but the user's final portfolio excludes WETH; native ETH is gas-only. We do not claim that wrapping/unwrapping paths were executed.

All price/route samples are observations at the cited blocks, not guarantees for a later transaction. A funded sender simulation, approval, swap receipt and exact final submission code-line links remain to be added.

Before submission, the owner should submit the committed feedback link through the [developer feedback form](https://developers.uniswap.org/hackathon-feedback) and record confirmation. This file records actual experience; it is not evidence that the form was sent.
