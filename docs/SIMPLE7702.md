# Simple7702 Ledger batching on Robinhood

[Prompt 097](prompts/097-simple7702-ledger-batching.md) selects the canonical **Simple7702Account** as the current setup path for an undelegated Ledger wallet. The application keeps the same wallet and batches exact deficient token approvals plus the existing ordered Uniswap router multicall in one self-funded transaction after setup. Native ETH remains required. No hosted service, relayer, API credential, session key or USDG gas payment is introduced.

## Why the implementation changed

The owner reported that Ledger refused the Calibur authorization because its delegate was not on the device whitelist. The pinned [Ledger Ethereum app whitelist](https://github.com/LedgerHQ/app-ethereum/blob/bc637f8986b3b1ec7e044daf7ecb3e832f24258b/src/features/sign_authorization_eip7702/whitelist_7702.c) includes Simple7702Account at the address below with chain ID zero (any chain). The same source revision's [authorization handler](https://github.com/LedgerHQ/app-ethereum/blob/bc637f8986b3b1ec7e044daf7ecb3e832f24258b/src/features/sign_authorization_eip7702/commands_7702.c#L140-L148) rejects an unsupported delegate. This is official source evidence plus an owner-observed Calibur refusal; the physical device's firmware version was not independently queried during this change. That source comparison alone did not prove device acceptance. The later live Simple authorization is verified below; Clear Signing for swaps remains unverified.

The [Calibur implementation and bytecode evidence](CALIBUR.md) remain historical and available for an existing Calibur delegation or pending operation. Those records are never reinterpreted as Simple7702 transactions.

## Chain deployment and wallet setup are separate

**Once per chain:** the shared implementation must exist at its canonical address with the exact pinned runtime. Deployment is an operator one-off script, `scripts/deploy-simple7702.ts`, outside the product. Its default path prepares and verifies only; sending requires explicit `--send` and physical Ledger confirmation. The application never deploys it from Start. Missing deployment produces an actionable setup block instead of repeated device prompts.

Operator preparation uses `node --import tsx scripts/deploy-simple7702.ts --wallet ADDRESS --root-dir /absolute/portfolio-root --journal /absolute/separate-directory/deployment.json`. The journal directory must already exist outside portfolio storage. Only a separately authorized deployment adds `--send --max-fee-wei INTEGER`, where the integer caps the complete buffered network fee. Sending requires that Ledger portfolio to be stopped and have no unresolved operation; the script does not stop or start it. Once a journal exists, every invocation checks its receipt only and retains the journal, even with `--send`. No API key, service or recurring deployment job is required.

**Once per wallet:** an explicit Start on a stopped Ledger portfolio checks public code and unresolved operations before selecting `execution: "simple7702"`. A failed Calibur setting may migrate only after fresh evidence proves the wallet is undelegated and no operation is pending. An actual Calibur delegate keeps the Calibur path. Missing or changed implementation code, another delegate, unknown state or unresolved unrelated transactions block setup.

Per-wallet setup signs a chain-4663 EIP-7702 authorization and a zero-value type-4 self-call to `executeBatch([])`. Outer nonce N requires authorization nonce N+1. This is two signatures for one onchain setup transaction, with no token approvals or trades. The button reports authorization, signing and receipt stages; the runner starts only after exact receipt/delegation verification. Standalone `ledger setup-simple7702` does not start trading; `ledger simple7702-status` reads public progress/code or reconciles a receipt without loading a signer. A newer Stop invalidates unbroadcast work. An uncertain send retains its own pending barrier; a later explicit continuation checks its receipt and never silently signs again.

**Later rebalances:** the verified delegated wallet signs one outer self-call containing exact approvals followed by the existing sale/purchase multicall. All inner calls have zero native value and failures revert the complete batch. Several Ledger review screens may still precede that one signature. ETH pays gas. The configured fee target includes the actual execution path; quote expiry, native balance, nonce, Stop, configuration and pinned code are checked around device work. No signed authorization is disclosed to optional external transaction-check services before broadcast.

Delegation persists independently of a batch's success: a type-4 execution revert does not undo delegation, and changing the application setting back to direct does not revoke it. Simple7702Account itself also trusts its canonical EntryPoint; Rebalance uses only the root self-call path, not its bundler/UserOperation interface.

## Canonical provenance

| Property | Pin |
| --- | --- |
| Implementation | `0x4Cd241E8d1510e30b2076397afc7508Ae59C66c9` |
| Runtime bytes | 3,639 |
| Runtime keccak256 | `0x82c1e6c0f83d22eef579344e8eff26baf24db4dabe5408d681b00d0512bc3ec4` |
| Upstream repository | `eth-infinitism/account-abstraction` |
| Source/artifact commit | `1c6b669d0eea734e09a87e095ba15e076151718a` |
| Artifact | `deployments/ethereum/Simple7702Account.json` |
| Artifact Git blob | `584fe60a6e87f77389ea14bb649cd8cdafae8a3a` |
| Compiler | `0.8.28+commit.7893614a` |
| CREATE2 factory | `0x4e59b44847b379578588920cA78FbF26c0B4956C` |
| CREATE2 salt | 32 zero bytes |
| Constructor arguments | None |
| License | MIT |

[Public verification evidence](evidence/simple7702-deployment.json) retains the complete compiler/source manifest, runtime, deployment simulation and local EVM results. [The pinned upstream artifact](https://github.com/eth-infinitism/account-abstraction/blob/1c6b669d0eea734e09a87e095ba15e076151718a/deployments/ethereum/Simple7702Account.json) embeds 20 literal source files. Compiling those files with checksum-pinned solc reproduces the runtime and canonical CREATE2 address exactly. Current upstream Solidity/deployment scripts have changed and are not substituted for this artifact. Settings include via IR, Cancun, optimizer 1,000,000 runs and literal-source IPFS metadata. The contract has no constructor arguments, immutables or mutable initialization. Its fixed EntryPoint is `0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108`.

The retained artifact and source retain their upstream MIT provenance. New adapter, deployment verification, controller and test code is project work assisted by Codex; see [AI disclosure](AI_USAGE.md).

## Verification boundary — September 13, 2026

The public Robinhood read at 07:25:53 UTC confirmed the canonical factory, but **no Simple7702Account code was deployed there yet**. A read-only simulation using a disposable public account and balance override returned the canonical deployment address and estimated 850,330 gas. No transaction was broadcast by that verification.

The canonical disposable Anvil suite passed 2/2. It deployed the exact CREATE2 artifact, rejected repeated deployment, verified an empty delegated self-call changes no token/storage state, rejected an unrelated caller, and proved complete rollback of exact approvals, a sale and an earlier purchase when a later purchase failed. The identical batch then succeeded with the fixture failure disabled. Fixture code installed the delegation designator; this was not a signed EIP-7702 authorization.

At **07:51:39 UTC**, the separately authorized one-off script deployed the implementation in Robinhood block **61793215**, transaction [`0x551d…6dc3`](https://robinhoodchain.blockscout.com/tx/0x551dbbd3af22ba4d18126dee3bd4493df4caaf83d0438f2c1721c88e6b4e6dc3). The existing Ledger signed the exact factory call; public receipt verification checked two canonical confirmations and reproduced the pinned 3,639-byte runtime hash. Actual network fee was **0.000071173612416 ETH**, below the explicit 0.00011 ETH limit. The [separate immutable send journal](evidence/simple7702-live-deployment.json) and [public receipt evidence](evidence/simple7702-live-receipt.json) are retained. No portfolio runner or wallet delegation was started by that one-off deployment. At that time `ledger simple7702-status` returned `needed`; the later wallet setup is recorded below.

At **07:59:56 UTC**, wallet `0xCeD38202ef03b2cB7dc69cD004F5cCe70dC21808` completed its own Simple7702 setup in block **61798118**, transaction [`0xe53d…01b2`](https://robinhoodchain.blockscout.com/tx/0xe53d8dbe9f8eac1024e24b1b9da5998b5739914a3e1eaadc7c5e131c3d9701b2). The successful type-4 transaction is an exact zero-value `executeBatch([])` self-call at outer nonce **25**, with one chain-4663 authorization to the canonical implementation at nonce **26**. It emitted no logs and paid **0.000003279729728 ETH** in network fees. Public code at 08:05:23 UTC matched the exact delegation designator and pinned implementation runtime; `ledger simple7702-status` returned `already-enabled`. [Sanitized wallet setup receipt and app observation](evidence/simple7702-live-wallet-setup-2026-09-13.json) omit signature bytes and raw signed transactions.

The owner reported successful EIP-7702 approval, and the chain independently confirms authorization and wallet setup. At the setup audit, the app was armed, had no error or proposal, and reported on-target existing holdings. Its retained cycle was the earlier 05:23 direct-router rebalance. The wallet's next nonce was still **27** at that audit block; this was setup evidence, not trade completion.

At **08:25:08 and 08:25:24 UTC**, two subsequent Simple7702 self-calls succeeded at nonces **27 and 28**. Each atomically combined one exact USDG approval and one Uniswap AAPL purchase, spending **0.022673 USDG** and then **0.000002 USDG**. Neither included a new authorization. [Public receipt and decoded-call evidence](evidence/simple7702-partial-rebalance-2026-09-13.json) confirms live delegated approval/swap execution. It does not prove target completion: the fresh daemon observation still had AAPL 572 basis points below its 30% target, despite recording an on-target Ledger outcome. The planner incorrectly preferred spare cash over funding stock sales. [Prompt 099](prompts/099-funded-batch-planning-and-stream-rotation.md) corrects that decision and empty-plan completion handling. At that milestone, a complete Simple7702 target rebalance, a live combined sale/purchase Simple batch and Clear Signing had not been verified.

A subsequent owner-started corrective run using the fixed planner completed the intended allocation. Independent receipt/ABI checks verified one successful Simple7702 self-call containing all four exact approvals followed by the Uniswap sales-and-purchases multicall, without a new delegation authorization. Fresh holdings confirmed completion against the targets used by that run. This supersedes the earlier incomplete-rebalance status above; physical device screen count and Clear Signing remain unverified. Session-specific transaction and allocation details are retained in the ignored local audit.

Reproduce the source/deployment proof with `node scripts/verify-simple7702-deployment.mjs`; it reads public sources/RPC and uses disposable compilation state, without signing. Receipt verification itself does not start a runner, sign or submit transactions.


## Restarting an already-enabled wallet

Under [prompt 109](prompts/109-ledger-restart-preflight.md), an explicit Ledger Start initially shows ordinary startup while checking the existing public delegation. If fresh proof reports the configured implementation is ready, the controller rechecks the unchanged configuration, Stop generation and absence of pending work under its existing locks, then proceeds to launch without invoking the setup command. Real first-time or retained setup work keeps its separate setup-stage display.

A failed read-only verification before setup/launch dispatch returns a retryable blocked result with an explanation. A potentially dispatched command still retains its uncertainty barrier. If an earlier Start is unknown and no active ownership or setup-receipt continuation is present, the chart offers **Cancel start**. That explicit click uses the existing Stop command to supersede the old request before a separate Start; it neither replays Start nor deletes transaction or control history.
