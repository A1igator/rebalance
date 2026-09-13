# Calibur batching on Robinhood

The owner authorized the narrow Ledger integration in [prompt 095](prompts/095-calibur-batching-and-quiet-chat.md). An explicit per-wallet `execution: "calibur"` option combines deficient exact ERC20 approvals and the already validated Uniswap router multicall into one atomic root self-call. Existing portfolios default to direct execution. The wallet address, holdings, router, recipients, target calculation, fresh quotes, input bounds, slippage minima, expiry, fee target and pending-receipt barriers stay portfolio-local.

This uses the existing wallet's Ledger key directly. There is no new session key, registration of another signing key, hosted relayer, API credential, paymaster or USDG gas-payment path. Native ETH still pays network fees. Enabling/disabling this mode requires an idle portfolio with no unresolved operation. The local setting does not itself sign or install delegation.

On first use, Ledger must approve a Robinhood-specific EIP-7702 authorization and the outer type-4 transaction. For a self-funded transaction at nonce N, its authorization uses N+1. Subsequent batches on the correctly delegated account need one outer transaction signature, although device UI can contain several review screens. Both first-use physical validation and Calibur-specific Clear Signing remain separate, unverified milestones. A successful local test is not evidence of a device display or mainnet transaction.

EIP-7702 delegation is persistent account code. An execution revert does not undo a delegation installed by that transaction, and switching the application back to direct mode does not revoke it. The implementation accepts only empty account code or the exact 23-byte `ef0100` designator for the pinned Calibur address. It refuses another delegate or ordinary contract code. Read the [EIP](https://eips.ethereum.org/EIPS/eip-7702) for the authorization processing order and persistent-code semantics.

## Selecting the execution mode

For the intended, already configured Ledger portfolio, after it is stopped and its pending operation is reconciled:

```sh
npm run cli -- --profile <public-address> configure --execution calibur
```

The command changes only that portfolio's public execution setting. A subsequent explicit Start loads the new runner and retains the saved targets and settings. First use requests **two signatures for one onchain transaction**: authorization, then the atomic batch. Later batches use one transaction signature. Verify the resulting receipt and fresh daemon holdings before calling the live test complete. The current implementation has not enabled this option on a live portfolio.

The first type-4 transaction contains an already-signed delegation authorization before the outer signature exists. Its raw bytes are therefore excluded from external Ledger transaction-check/metadata requests; only public call metadata is forwarded. The device still receives the full transaction. This does not add Clear Signing support or silently enable a fallback.

## Canonical deployment and complete bytecode proof

Verified September 13, 2026 using public sources and read-only RPC calls:

| Property | Pin |
| --- | --- |
| Network | Robinhood mainnet, chain ID 4663 |
| Official deployment | `0x000000005c84F8Fd50b21CAC312528A64437030e` |
| Release | Uniswap Calibur `v1.1.0` |
| Source commit | `249cac5e880831d7b2de4111a5920dbf0d242846` |
| Entry contract | `src/CaliburEntry.sol:CaliburEntry` |
| Runtime bytes | 22,020 |
| Runtime keccak256 | `0xba697585ba58ba66ebd095ab4c7f980ed42ad115b2e3bb9b5b9bdf167bf08b1b` |
| Solidity compiler | `0.8.29+commit.ab55807c` |
| Compiler SHA256 | `87616a5fc7ab3551f4133bbd2c3e1be123eae219facc2a56f8f3a4366520c67b` |
| Compilation | via IR, Cancun, optimizer 1,000 runs, no metadata bytecode hash |

[Uniswap's deployment table](https://developers.uniswap.org/docs/protocols/smart-wallet/deployments) and the [GitHub v1.1.0 tag](https://api.github.com/repos/Uniswap/calibur/git/ref/tags/v1.1.0) identify the source commit above. The README inside that tag retains a different `d7dbc80…` deployment reference; this proof uses the actual tag object and deployment table. The tagged [deployment script](https://github.com/Uniswap/calibur/blob/249cac5e880831d7b2de4111a5920dbf0d242846/script/DeployCaliburEntry.s.sol) deploys **CaliburEntry**, not bare Calibur. Its custom storage base is `0x3b86514c5c56b21f08d8e56ab090292e07c2483b3e667a2a45849dcb71368600`.

Robinhood's explorer source API was unavailable during verification. The [same-address Unichain verified-source API](https://unichain.blockscout.com/api/v2/smart-contracts/0x000000005c84F8Fd50b21CAC312528A64437030e) supplied the complete compiler input. Every one of its 66 source files was independently matched to the Git blob at the immutable upstream source/dependency commits. Those sources were compiled using the checksum-verified official Solidity compiler. Only the compiler-declared immutable slots were filled: `keccak256("Calibur")`, `keccak256("1.0.0")`, and the canonical implementation address. The entire resulting runtime, including every other byte, matched Robinhood `eth_getCode` exactly. This verifies source equivalence rather than assuming two deployments match because they share an address.

The complete runtime, ABI, compiler settings, immutable positions and source manifest are retained in [public deployment evidence](evidence/calibur-deployment.json). Dependency source commits used in that compilation:

- OpenZeppelin/openzeppelin-contracts: `56a3de2cea907c9a500d32e70c275f68393b7ba6`
- Vectorized/solady: `1eb89b9af0a09468c6ccff51ce8ed5eb520b4fb5`
- eth-infinitism/account-abstraction: `3c9ef104688649b7ba6ee0c788aa494783ee24f7`
- base/webauthn-sol: `619f20ab0f074fef41066ee4ab24849a913263b2`
- rdubois-crypto/FreshCryptoLib: `76f3f135b7b27d2aa519f265b56bfc49a2573ab5`

The included compiled sources declare MIT licensing. Rebalance reuses the existing deployed contract and retains its public bytecode as verification/test evidence; it does not deploy a modified Calibur contract or execute upstream deployment scripts. All new helper, verification and fixture code is original project code assisted by Codex, disclosed in [AI usage](AI_USAGE.md).

Reproduce the public source/compiler/runtime and isolated mock-fixture proof with Node 24 and installed project dependencies:

```sh
node scripts/verify-calibur-deployment.mjs
```

This downloads public source/compiler artifacts to a disposable `/tmp` directory and performs only public `eth_chainId`/`eth_getCode` reads. It needs network access, takes roughly a minute, and never reads application storage or signs. `--fixtures-only` reproduces just the local mock contracts using the same checksum-pinned compiler. Network/source unavailability fails the verification; the script never changes production pins automatically.

## Root execution and atomicity

The canonical ABI is `execute(((address to,uint256 value,bytes data)[] calls,bool revertOnFailure) batchedCall)`. In [Calibur.sol](https://github.com/Uniswap/calibur/blob/249cac5e880831d7b2de4111a5920dbf0d242846/src/Calibur.sol), this overload derives the caller's key hash and checks its authority. [KeyLib.sol](https://github.com/Uniswap/calibur/blob/249cac5e880831d7b2de4111a5920dbf0d242846/src/libraries/KeyLib.sol) identifies `msg.sender == address(this)` as the root key; [KeyManagement.sol](https://github.com/Uniswap/calibur/blob/249cac5e880831d7b2de4111a5920dbf0d242846/src/KeyManagement.sol) recognizes root authority without installing another key. A Ledger-signed transaction from the wallet to itself therefore executes at that wallet and preserves the wallet as the caller of token/router contracts.

Rebalance encodes one to five zero-value calls: at most four deficient input-token approvals at the exact prepared aggregate amounts, followed by one canonical Uniswap router multicall. It always sets `revertOnFailure: true`. The final boundary checks the calls against the configured assets and fresh prepared trade plan; this is not a general arbitrary-call signing interface.

Fresh complete-call simulation covers the approvals together with the router multicall. The application rechecks code identity, account delegation, nonce, configuration/Stop state and deadline around device waits before sending. Public chain checks occur before acquiring the short local configuration lock; they are observations rather than a guarantee of unchanged chain state until inclusion. A competing nonce-consuming transaction invalidates the prepared outer nonce. The transaction stays a single swap operation for receipt/cadence tracking. Nothing in a simulation proves final execution under later market conditions.

## Verification results and limits

`npm test -- tests/calibur.test.ts` passed **5/5** on September 13, including the optional real EVM proof with installed **Anvil 1.7.1** (`4072e48705af9d93e3c0f6e29e93b5e9a40caed8`). The local Anvil uses a disposable IPC endpoint, zero generated accounts, public impersonated fixture addresses, no fork and no inherited wallet/Foundry configuration. The pinned full canonical CaliburEntry runtime executes through the wallet's real EIP-7702 delegation designator on the Prague EVM.

The EVM proof makes two exact token approvals followed by a router multicall with one sale and two purchases. A call trace confirms that the first purchase and an approval executed successfully before the final purchase failed. The reverted receipt leaves **all** token balances, allowances and router state unchanged. A foreign caller cannot use the root overload. Removing the fixture failure allows the same batch to complete in one self-call, with exact inputs spent and the delegation retained. The source and reproducible bytecode for the deliberately minimal ERC20/router fixtures live under `tests/fixtures/CaliburMocks.sol` and `tests/fixtures/calibur-mocks.json`; these are local rollback checks, not a Uniswap price/liquidity or Robinhood mainnet execution claim. Without Anvil installed, the test explicitly skips this EVM case; the pure tests still run.

A separate **public read-only Robinhood simulation** at `2026-09-13T06:01:40.653Z` used the unrelated deterministic public fixture address `0xda0a4fb97a4916fd0d89d8e3b7288165ddc85e8f`. Its actual code was empty. Temporarily overriding only that fixture's code to the canonical delegation and funding its simulated gas balance allowed a self-call containing `USDG.approve(canonicalRouter,0)` to return `0x`; `eth_estimateGas` returned **45,819** (`0xb2fb`). No authorization was produced and no transaction was submitted. This establishes support for the pre-authorization state-override estimate path; it does not establish the cost of a rebalance or install any delegation. [Robinhood's account-abstraction documentation](https://docs.robinhood.com/chain/account-abstraction/) also explicitly documents EIP-7702 support.

Still required for a live Calibur milestone: the owner's device review of chain-specific authorization and the type-4 transaction, actual onchain delegation/batch receipt, fresh resulting holdings and independently observed device display semantics. Earlier direct Ledger rebalance receipts remain separate evidence in [Ledger execution](LEDGER_EXECUTION.md).
