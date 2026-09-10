# USDG paymaster execution

> **Archived — removed on September 10, 2026.** The owner withdrew gas abstraction under [prompt 068](prompts/068-remove-unused-paymaster.md). The implementation and CLI commands described below are historical and are unavailable in current main. Native ETH gas and the per-wallet fee target remain. Older gasPayment configurations and paymaster pending records are rejected without modification.

This optional per-wallet transport implements the user's [paymaster request](prompts/066-usdg-paymaster-implementation.md). It does not activate existing portfolios. [Setup](PAYMASTER_SETUP.md) requires an Alchemy app/key, active Robinhood USDG policy and an authenticated read-only estimate. Native ETH mode remains the default.

## Execution

`runtime.ts` prepares a deterministic plan and calls `preparePaymasterTrade`. This requests a non-reserving estimate, reserves quoted USDG for the projected remaining swaps, and rebuilds a smaller buy when needed. Three unsigned preparations bound quote churn; no targets change. `chain.ts` batches an exact router allowance and a freshly quoted SwapRouter02 deadline multicall. No WETH wrap or ETH value call is allowed in this transport.

`paymaster.ts` reads fresh wallet code, EOA pending/latest nonce, EntryPoint owner nonce lane, canonical USDG balance/paymaster allowance and infrastructure code. Empty-code accounts need a chain-bound EIP-7702 authorization for `0x77021100bD87b7008E5E1989d0eB38555d0d0000`; already-delegated accounts must point to exactly that implementation. The delegate must return `alchemy.sma-7702.1.1.0`. A different implementation is not automatically replaced. This identity/code-presence check is not an independent bytecode audit.

The adapter explicitly requests `ModularAccountV2` version `v1.1.0` and Wallet API nonce override zero. The account SDK's owner/global-validation encoding maps that override to EntryPoint key **1**, not key zero. It uses EntryPoint v0.7 `0x0000000071727De22E5E9d8BAf0edAc6f37da032` on chain4663. No new session key or autonomous permission module is installed.

`paymaster-protocol.ts` accepts only the implemented current authorization/user-operation-v070 schema. It locally computes the authorization and UserOperation hashes, requires exact intended calls in order, and permits only the documented prepended exact USDG paymaster approval. Unsupported envelopes, factories, tokens, chains, extra calls and mismatched signing requests fail before signing. The fee target is assessed before policy reservation, then again from final preparation. Both signatures are locally recovered to the selected wallet before submission.

Raw-key mode uses the existing local/Keychain signer; Privy uses only its existing Agent Sandbox signer with explicit ECDSA message-signing output. Ledger uses the existing device signer SDK with sequential physical actions, shared USB locking, cancellation and request lifetime checks. First use may require an authorization signature and then a personal-message UserOperation-hash signature. That second payload is a hash: semantic device display of stock amounts and Clear Signing are **not verified**. Software tests do not prove actual device support or display quality.

Before sending, configuration, stop/request/cycle/swap deadlines, nonce, wallet code, USDG balance and required allowance are rechecked. A warmed provider client starts its request within the short configuration lock; responses and signing waits occur outside it. A public pending identity is written before invocation. It stores the local UserOperation hash and chain-prefixed call ID, never private keys or signatures. Any uncertain send remains a receipt barrier and is never resubmitted or converted into an ETH transaction.

## Receipts and local retries

`paymaster-receipts.ts` treats bundler responses only as transaction-location hints. Actual completion requires exactly one matching EntryPoint UserOperationEvent for the saved hash, wallet, paymaster and nonce, plus canonical block evidence and two observed confirmations. Outer transaction success alone cannot establish UserOperation success. The MVP supports outer calls to the pinned EntryPoint; wrapper transaction targets fail closed. A missing provider hint falls back to bounded, persisted public log scans, including two-block overlap and retained ranges when a receipt disappears.

Successful swaps update the existing cycle before clearing pending. Verified automatic-signer reverts release the barrier without claiming success; Ledger reverts need the existing explicit acknowledgement command, using the same event verifier. Neither explicit nor automatic native recovery can cancel a UserOperation. A transport setting change does not alter the saved receipt transport.

Temporary provider/read failures are retried locally without model messages, and do not clear an earlier actionable incident. Invalid intent/evidence, unsupported configuration or unresolved submissions can require attention. Completion still requires a verified swap and fresh within-target portfolio, not queue acceptance or a recovered failed operation.

## Dependencies and limits

Requests go directly to Alchemy's fixed Wallet API/bundler hosts with a private key in its documented URL path; that URL, response bodies and signed payloads are never printed or exposed by the companion. Requests/bodies/timeouts are bounded, and submission has no automatic HTTP retry. The provider receives public wallet/calls and signatures, not wallet secrets. The local API credential is stored separately from wallet material, owner-only and outside Git.

Alchemy fronts native ETH and collects USDG after execution; provider billing capacity, policy pricing/recipient and service availability remain dependencies. FeePayment metadata is a provider quote. Exact injected approval is calldata-bound, while a pre-existing allowance may exceed the quoted fee. The quoted full-rebalance target is prospective estimation, not cryptographically enforced accounting. See [fee calculation](FEE_TARGET.md). An account needs a USDG fee float; this implementation does not borrow its first gas payment or silently use ETH. Initial full-balance buys can fail to quote if provider simulation needs a fee reserve first.

EIP-7702 account code persists when the transport is disabled. Disable chooses native gas for future calls and does not undelegate the wallet. Account abstraction adds trust in the chosen implementation and provider; chain reads still use RPC, not a light client. No live portfolio was configured, delegated, armed, signed or submitted during development.

## Public infrastructure evidence

Read-only RPC observation at **2026-09-10T21:46:58.783Z**, Robinhood block **59735747**, chain **4663**, using `https://rpc.mainnet.chain.robinhood.com`:

| Contract | Runtime bytes | Runtime Keccak-256 |
| --- | ---: | --- |
| Pinned v1.1 delegate | 24358 | `0x46fc4ecb190e16f7734d2ebe8f7e1d616a1b07c5e7cf1fc5c47dbb4e7c1a7ee0` |
| EntryPoint v0.7 | 16035 | `0x8db5ff695839d655407cc8490bb7a5d82337a86a6b39c3f0258aa6c3b582fc58` |
| Canonical USDG | 170 | `0x864cc9ad53b338b82da1f7cab85ab0b3d5c8861acb422b6fec63cf36234f36a6` |

`accountId()` returned `alchemy.sma-7702.1.1.0`. These observations establish deployed code and self-reported version, not source equivalence, policy acceptance, economic safety or successful execution. Authenticated canonical-USDG acceptance, first delegation, hardware signing/rejection and a USDG-paid swap remain live verification work after owner provisioning.

Primary references: [Alchemy ERC-20 payment guide](https://www.alchemy.com/docs/wallets/transactions/pay-gas-with-any-token), [EIP-7702 versions](https://www.alchemy.com/docs/wallets/transactions/using-eip-7702), [nonce encoding](https://www.alchemy.com/docs/wallets/transactions/send-parallel-transactions), [send result](https://www.alchemy.com/docs/wallets/api-reference/smart-wallets/wallet-api-endpoints/wallet-send-prepared-calls), [EIP-4337](https://eips.ethereum.org/EIPS/eip-4337). Existing viem2.56.3, Ledger Ethereum signer1.18.0 and Privy Agent CLI0.3.6 are reused; no new package or custom on-chain contract was added.
