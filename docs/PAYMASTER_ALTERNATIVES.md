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

## Broader provider check

Other services exist; no assertion is made that the two investigated first are the only possibilities.

- **0x Gasless** supports Robinhood and token-paid gas, but requires a key. Its x402/MPP agent gateway exposes ordinary Swap API quotes, not the Gasless execution path. [Robinhood support](https://docs.0x.org/changelog/2026/7/31), [agent API scope](https://docs.0x.org/docs/introduction/develop-with-ai/autonomous-agent-payments).
- **Gelato** has old key-optional SyncFee documentation, but the official migration guide retires that route and replaces it with sponsored calls plus custom token collection. Current relayer API authentication requires a key. [Migration guide](https://github.com/gelatodigital/gelato-migration-erc2271-syncfee), [fee quote API](https://docs.gelato.cloud/gasless-with-relay/relayer-api-endpoints/relayer/relayer_getfeequote).
- **Circle Paymaster** is permissionless and needs no API key, but supports USDC rather than USDG, and Robinhood is absent from its documented network list. [Circle documentation](https://developers.circle.com/paymaster).
- **Pimlico** documents public endpoints, but its public paymaster is testnet-only. **Rhinestone** requires a mainnet API key. [Pimlico endpoints](https://docs.pimlico.io/references/bundler/public-endpoint), [Rhinestone intents](https://docs.rhinestone.dev/intents/overview).
- **ZeroDev Smart Routing Address** lists Robinhood/USDG, but uses gated alpha/project access and a routing-address model. **Across** requires API key/integrator identification and its gasless flow excludes embedded calls. [ZeroDev alpha](https://docs.zerodev.app/onramp/smart-routing-address/alpha), [Across feature matrix](https://docs.across.to/introduction/features).

These are current documented fit assessments, not authenticated service tests or proofs that an undocumented route cannot exist.

## Uniswap Calibur with an independently operated relayer

This is a closer architectural fit to the owner's direct Uniswap/Ledger/Privy preference than a new orchestration SDK. Uniswap's current [Calibur deployment reference](https://developers.uniswap.org/docs/protocols/smart-wallet/deployments) lists Robinhood and Calibur v1.1.0 at `0x000000005c84F8Fd50b21CAC312528A64437030e`, commit `249cac5e880831d7b2de4111a5920dbf0d242846`. The older GitHub chain inventory lists v1.0.0, so it is not the current version pin.

A narrow adapter could sign a chain-bound EIP-712 batch with exact Uniswap approval/swap calls and a final USDG transfer to the relayer, enforcing a nonce, deadline, executor and revert-on-failure. The operator fronts ETH; a reverted batch does not collect the signed USDG fee. This avoids a separate fee-first operation and needs no ERC-4337 bundler, session keys or portfolio custody. The owner still signs a one-time EIP-7702 delegation and each batch through the existing selected signer. [Calibur v1.1.0 source](https://github.com/Uniswap/calibur/blob/v1.1.0/src/Calibur.sol), [smart-wallet overview](https://developers.uniswap.org/docs/protocols/smart-wallet/overview).

An actual implementation still needs pinned deployment/bytecode validation, accurate fee quoting, gas reservation, signer adapters, relayer nonce/recovery handling, and an ETH-funded operator. No public Robinhood/USDG endpoint for this exact atomic route was verified. No new relayer wallet was created or funded, and no Calibur contract was invoked in this research.

Implementation version detail from the pinned source: release v1.1.0 still uses EIP-712 domain version `1.0.0`; the domain salt includes the current prefix and implementation address. A future adapter must verify the full domain instead of deriving it from the release number. The root EOA uses the zero key hash. A successful low-level call is not proof that an arbitrary ERC-20 returned true, so canonical USDG transfer behavior and post-state simulation must also be checked. No deployed-bytecode equivalence or signer compatibility was tested here. [EIP-712 source](https://github.com/Uniswap/calibur/blob/v1.1.0/src/EIP712.sol).
