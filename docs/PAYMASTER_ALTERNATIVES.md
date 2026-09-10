# API-key-free USDG gas options — 2026-09-10

The owner requires no developer API-key setup, accepts a relayer instead of Alchemy, and prioritizes trust minimization and direct Uniswap/Ledger/Privy integrations. Provider choice is not permission to add custody, sessions or remote portfolio decisions. See [prompt 067](prompts/067-settings-header-and-gas-alternatives.md).

## Alchemy authentication is not gas provisioning

[Wallet authentication](https://www.alchemy.com/docs/alchemy-for-agents) uses SIWE and x402 USDC payments for RPC/data API access. The current [ERC-20 gas-payment guide](https://www.alchemy.com/docs/wallets/transactions/pay-gas-with-any-token) separately requires an app API key and ERC-20 policy, with gas billed to the policy owner. No wallet-only provisioning path for that service was established. The existing optional adapter remains unconfigured on both registered portfolios; a read of their public config and pending metadata found no enabled gasPayment transport and no pending operation at this check.

## Flashbots and relayers

Robinhood uses ETH gas and its own sequencer. Ethereum builder inclusion does not control Robinhood transaction ordering. Flashbots documents Ethereum mainnet/Sepolia relay endpoints; its sponsored example first funds an executor with ETH. No Robinhood USDG bundle endpoint was identified. [Robinhood network](https://docs.robinhood.com/chain/connecting/), [Flashbots endpoints](https://docs.flashbots.net/guide-send-tx-bundle), [sponsorship example](https://github.com/flashbots/searcher-sponsored-tx/).

A separate EIP-7702 relayer could pay ETH while executing a user-signed swap and exact USDG fee transfer atomically. This is an architectural alternative, not an implemented or verified provider route. It needs verified account execution code and an ETH-funded operator. A local relayer moves the ETH requirement to a separate gas wallet rather than eliminating it from the application. [EIP-7702 motivation](https://eips.ethereum.org/EIPS/eip-7702#motivation).

## Biconomy MEE: no personal key, additional execution trust

[AbstractJS development access](https://docs.biconomy.io/new/preparing-for-production/set-production-api-key) needs no personal API key; higher limits require one. The published SDK includes a default shared key. A plain unauthenticated GET to `https://network.biconomy.io/v1/info` succeeded during this check and listed chain **4663**, canonical **USDG 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168**, six decimals, and permitEnabled=false among supported fee tokens. This is service metadata, not a signed quote, a guarantee of availability or a completed USDG-paid swap.

Current AbstractJS **2.0.2** and [contracts guidance](https://docs.biconomy.io/contracts-and-audits) select MEE **2.2.3 / Nexus 1.3.3** for new accounts. Robinhood's chain/version table lagged this guidance at inspection. Any integration must verify the selected deployment and may not choose an older version merely to simplify signing.

The direct API shape is GET `/info`, POST `/quote`, POST `/exec`, and GET `/explorer/{hash}` under `https://network.biconomy.io/v1`. A minimal adapter would keep the same EOA through chain-specific EIP-7702, exact Uniswap calls, existing owner signing, and no session modules. It must independently validate all operation calldata, fee amount/recipient/token, nonce, chain, account and paymaster; reconstruct each ERC-4337 hash and the Nexus EIP-712 SuperTx before signing; and check every expected operation's canonical receipt. Calling SDK signQuote on an unverified remote hash does not satisfy that requirement. [Quote source](https://github.com/bcnmy/abstractjs/blob/develop/src/sdk/clients/decorators/mee/getQuote.ts), [signing source](https://github.com/bcnmy/abstractjs/blob/develop/src/sdk/clients/decorators/mee/signQuote.ts).

**The fee is a separate first user operation.** The node paymaster restricts submission to node-authorized workers. Local signatures can cap the authorized payment and bind the swaps, but cannot force the node to execute the swap after collecting that fee; another general bundler cannot simply complete it through this paymaster. No supported option combining fee collection and the swap atomically, or enforceable USDG refund for omitted execution, was established. Source-level refund handling concerns native gas for executed operations. [Node paymaster](https://github.com/bcnmy/mee-contracts/blob/dev/contracts/NodePaymaster.sol), [base paymaster](https://github.com/bcnmy/mee-contracts/blob/dev/contracts/BaseNodePaymaster.sol).

No personal Biconomy account, API key, SDK dependency, delegation, quote signature, payment or transaction was created. Accepting this bounded-fee execution trust versus keeping native gas or operating an atomic relayer is an explicit outstanding product choice.
