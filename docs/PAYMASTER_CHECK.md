# USDG paymaster verification — 2026-09-10

Historical research snapshot. The optional adapter was implemented under [prompt 066](prompts/066-usdg-paymaster-implementation.md), then removed under [prompt 068](prompts/068-remove-unused-paymaster.md) when the owner deferred gas abstraction. The [setup](PAYMASTER_SETUP.md) and [execution/evidence record](PAYMASTER_EXECUTION.md) are archived; their commands are no longer available. Observations below remain as originally measured.

**Robinhood infrastructure supports this direction, but canonical USDG payment acceptance and a sponsored Rebalance transaction are unverified.** Rebalance currently sends legacy EOA transactions and requires native ETH. The user's $0.05 estimated rebalance-fee target does not make those transactions ETH-free.

Research scope was authorized in [prompt 057](prompts/057-center-settings-and-paymaster-verification.md). Only public documentation, installed SDK source/types and read-only public requests were inspected. No credentials were discovered, policies created, accounts delegated, messages signed or transactions submitted.

## Documented support

Alchemy lists Robinhood Mainnet as supported for bundling, gas sponsorship and ERC-20 gas payments. [Supported chains](https://www.alchemy.com/docs/wallets/supported-chains)

Robinhood documents ERC-4337 and EIP-7702 support, the EntryPoints below, and the authenticated bundler/RPC route `https://robinhood-mainnet.g.alchemy.com/v2/{API_KEY}`. Its token list identifies the same USDG address used by Rebalance. [Account abstraction](https://docs.robinhood.com/chain/account-abstraction/), [canonical tokens](https://docs.robinhood.com/chain/contracts/)

Alchemy supports custom ERC-20 policies, requiring an API key, active policy and supported direct token price or same-decimal reference. The provider fronts ETH, collects tokens to a configured recipient and bills the policy owner. Post-operation collection supports batched approval; pre-operation collection requires an allowance or compatible permit. Automatic permits require ERC-7597, `version()` and a compatible domain separator. [Token gas payment guide](https://www.alchemy.com/docs/wallets/transactions/pay-gas-with-any-token)

Mainnet billing capacity is also required: the current FAQ lists no free mainnet sponsorship, PAYG capacity requiring credits/custom limits, and an 8% PAYG administration fee. These are provider terms observed today, not a project fee guarantee. [Gas Manager FAQ](https://www.alchemy.com/docs/wallets/reference/gas-manager-faqs)

## Public chain observations

Observed **2026-09-10T13:34:01.039Z** using `https://rpc.mainnet.chain.robinhood.com`. `eth_chainId` returned **4663**. All contract reads used block **59442299**, timestamp **2026-09-10T13:33:59Z**. Methods: `eth_getBlockByNumber`, `eth_getCode`, and read-only `eth_call`.

| Documented contract | Address | Runtime code bytes |
| --- | --- | ---: |
| EntryPoint v0.6.0 | `0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789` | 23689 |
| EntryPoint v0.7.0 | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` | 16035 |
| EntryPoint v0.8.0 | `0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108` | 21738 |
| Canonical USDG | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` | 170 |

Runtime Keccak-256 hashes, in the same order:

```text
0xc93c806e738300b5357ecdc2e971d6438d34d8e4e17b99b758b1f9cac91c8e70
0x8db5ff695839d655407cc8490bb7a5d82337a86a6b39c3f0258aa6c3b582fc58
0xa4b1c865a4a45b99ebaaf4bd06e0036ad489eb521786f59765e4e6a3c0524b03
0x864cc9ad53b338b82da1f7cab85ab0b3d5c8861acb422b6fec63cf36234f36a6
```

These confirm code presence at documented addresses; they are not independent bytecode/source equivalence verification or paymaster acceptance evidence.

USDG returned `symbol() = USDG`, `decimals() = 6`, and `DOMAIN_SEPARATOR() = 0x7a3d7400b27830f4f91c2c16a082486d67c1befecaec2f53b33f1f35d5b62036`. Its `version()` call reverted with selector `0x800ab12c`. Therefore the documented automatic pre-operation permit prerequisites did not all pass. ERC-7597 compatibility was not established; a responding domain separator alone does not establish it. This result does not rule out post-operation collection or a separately established allowance.

A price lookup for `robinhood-mainnet` and canonical USDG at the documented public `docs-demo` endpoint returned **HTTP 403**, body `Unspecified origin not on whitelist.` No origin spoofing or private key was used. This response proves neither available pricing nor token rejection by a configured policy. [Public pricing API reference](https://www.alchemy.com/docs/data/prices-api/prices-api-endpoints/prices-api-endpoints/get-token-prices-by-address)

## Signer and application readiness

The installed Ledger Ethereum signer 1.18.0 exposes `signDelegationAuthorization` and `signTypedData` in `node_modules/@ledgerhq/device-signer-kit-ethereum/lib/types/api/SignerEth.d.ts`. Installed viem 2.56.3 exposes `signAuthorization` and `signTypedData` through `privateKeyToAccount`. These are source-level capabilities; no device delegation or typed-data signature was tested.

Privy's official Agent CLI documents `eth_sign7702Authorization`, `eth_signTypedData_v4` and `eth_signUserOperation`. Its live service compatibility for this flow remains untested. [Agent CLI](https://docs.privy.io/recipes/agent-integrations/agent-cli)

The current [TransactionSigner](../src/signers.ts) exposes only `signTransaction`. [Ledger validation](../src/ledger-signing.ts) accepts prepared legacy transactions on 4663, and [Privy's adapter](../src/privy.ts) uses `eth_signTransaction`. There is no application paymaster, UserOperation or EIP-7702 execution path.

## Remaining prerequisites

1. An authorized Alchemy app/API key, mainnet billing capacity, and active ERC-20 policy explicitly accepting Robinhood canonical USDG, with its recipient and validated direct or six-decimal reference pricing.
2. An authenticated estimation result for this exact token, account, chain and operation. Use `wallet_prepareCalls` with `onlyEstimation` for a read-only fee check; inspect returned token, amount and proposed calls before any signing. [Estimation guidance](https://www.alchemy.com/docs/wallets/transactions/pay-gas-with-any-token)
3. A verified paymaster address matching the chain and EntryPoint, obtainable with the policy through `pm_getPaymasterStubData`; an actual quote from `alchemy_requestPaymasterTokenQuote`. A general deployment label or EntryPoint code alone cannot establish acceptance. [Low-level token payment flow](https://www.alchemy.com/docs/wallets/low-level-infra/gas-manager/gas-sponsorship/using-sdk/pay-gas-with-any-erc20-token)
4. A deliberately implemented and reviewed smart-account or EIP-7702 path, including account/nonce/signature validation, exact paymaster allowance, token balance handling, receipt reconciliation and preserved Ledger physical confirmation. Any account authorization and eventual live transaction require their own user-authorized execution; this research performed neither.
