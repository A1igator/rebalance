# Verified combined Ledger rebalance and approval-batching research

Date: September 13, 2026. Documentation and research scope only.

The owner first reported that the referenced live run “still took like 6 transactions,” then clarified: “it might have been 3 but can we not batch the approvals too all into one transaction?” The next question was: “no smart wallet/7702 that can be helpful?”

## Evidence correction

Retain the bounded public RPC audit for Robinhood chain 4663 and Ledger wallet `0xCeD38202ef03b2cB7dc69cD004F5cCe70dC21808`. Blocks 61703500–61706020 advance its next nonce from 21 to 24 and contain exactly three successful outgoing transactions: an AAPL approval, a USDG approval and one four-leg Uniswap multicall. The multicall sells AAPL for USDG, then buys AMD, NVDA and MSFT with USDG. Its receipt is block 61705868 at 05:24:24 UTC; the referenced task's public status records completion at 05:24:28.752 UTC and on-target holdings.

Publish only sanitized public evidence and correct the current execution, batching and demo documentation. Keep the September 12 sequential and earlier September 13 phase-batch results as dated history. Three onchain transactions do not establish the number of physical Ledger screens, taps or unbroadcast prompts. Clear Signing and explicit rejection evidence remain separate.

## Approval-batching question

Research whether a smart account or EIP-7702 could reduce distinct token approvals, considering the owner's existing trust-minimization preference, direct Uniswap execution and Ledger/Privy sponsor integrations. This specific question permits that comparison despite the older preference against delegation research; it does not authorize implementation, account migration, delegation, deployment, signing, new approvals or a transaction. Do not broaden the general product scope or remove the current direct-signing path.

No production code, skill, live runner, configuration, wallet or credential changes belong to this documentation update. Tenjin publishing remains paused. The coordinating agent handles any separate researched answer and the final commit/push.

## Research result supplied by the coordinating agent

[Robinhood's account-abstraction documentation](https://docs.robinhood.com/chain/account-abstraction) explicitly supports EIP-7702. [Uniswap's deployment list](https://developers.uniswap.org/docs/protocols/smart-wallet/deployments) lists Robinhood Calibur 1.1.0 at `0x000000005c84F8Fd50b21CAC312528A64437030e`, with commit `249cac5e880831d7b2de4111a5920dbf0d242846`. A separate read-only RPC observation at 05:32:19 UTC confirmed chain 4663, 22020 deployed-code bytes and code hash `0xba697585ba58ba66ebd095ab4c7f980ed42ad115b2e3bb9b5b9bdf167bf08b1b`; this is not proof of source/deployed-bytecode equivalence. The coordinating agent's source review found Calibur 1.1.0 `execute(BatchedCall)` supports a root self-call containing exact approvals plus a swap with `revertOnFailure=true`, without requiring a relayer, API key or session key; native ETH still pays gas. The pinned Ledger Signer Kit 1.18.0 declaration exposes `signDelegationAuthorization`.

This is a possible research direction, not an implemented Rebalance feature or a verified device flow. The deployment page and README commit references differ and need resolution before pinning; simulation and a live device authorization remain unverified. An EIP-7702 delegation persists even if the subsequent call batch reverts. Preserve the existing default direct-signing policy until the owner requests a concrete implementation.

The owner also asked whether this could enable USDG-paid gas. Calibur supports gas abstraction, but Robinhood network fees still require native ETH. A compatible paymaster or relayer would have to pay ETH and collect USDG; no such service meeting the requested Robinhood/USDG/no-API-key/no-operated-backend constraints was verified in this audit. Self-funded batching does not depend on that service. See the [official Calibur overview](https://developers.uniswap.org/docs/protocols/smart-wallet/overview).
