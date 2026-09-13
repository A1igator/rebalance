# Development descriptor provenance

These original Rebalance descriptors describe the current application function surfaces on Robinhood mainnet (4663). They are development inputs. They have no production descriptor signature, Ledger attestation, or registry acceptance. Nothing in this directory changes the running signer or supplies metadata to a real device.

| File | Contract binding | Functions |
| --- | --- | --- |
| `calldata-Simple7702Account.json` | Canonical implementation `0x4Cd241E8d1510e30b2076397afc7508Ae59C66c9` on 4663 | `executeBatch((address,uint256,bytes)[])` |
| `calldata-SwapRouter02.json` | Router `0xCaf681a66D020601342297493863E78C959E5cb2` on 4663 | `multicall(uint256,bytes[])`, `exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))` |
| `calldata-RebalanceERC20.json` | The nine canonical current/legacy asset addresses in `src/assets.ts`, each on 4663 | `approve(address,uint256)` |

Only these function surfaces are covered. Other methods and chains must remain unknown. The metadata owner `Rebalance development` identifies the descriptor authoring context; it does not claim that Rebalance owns the external contracts or that Ledger or Uniswap reviewed the files.

## Source and reuse

- The checked application ABI/address sources are `src/simple7702.ts`, `src/chain.ts`, `src/assets.ts` and viem 2.56.3's standard ERC-20 approval ABI. They are compared by the development checks. No wallet data is embedded in the descriptors.
- Simple7702 source provenance remains the [pinned account-abstraction artifact](https://github.com/eth-infinitism/account-abstraction/blob/1c6b669d0eea734e09a87e095ba15e076151718a/deployments/ethereum/Simple7702Account.json), MIT. The existing `src/artifacts/simple7702.json` and `docs/SIMPLE7702.md` retain runtime/deployment evidence; this descriptor work does not perform a fresh on-chain check.
- The [ERC-7730 registry](https://github.com/ethereum/clear-signing-erc7730-registry/tree/59caf861229afdc584767bb127eea9a6c8c729a6), CC0-1.0, supplied the schema and patterns for [tuple-array nested calls](https://github.com/ethereum/clear-signing-erc7730-registry/blob/59caf861229afdc584767bb127eea9a6c8c729a6/registry/safe/calldata-BatchExecutor.json) and [Uniswap fields](https://github.com/ethereum/clear-signing-erc7730-registry/blob/59caf861229afdc584767bb127eea9a6c8c729a6/registry/uniswap/calldata-UniswapV3Router02.json). The router binding, multicall wrapper, complete price-limit field, raw identities, explicit native amounts, sender context and flag explanation are Rebalance additions. The registry router example itself binds only Ethereum chain 1 and omits this multicall wrapper.
- `../schema/erc7730-v2.schema.json` is an unmodified copy of that registry commit's schema. SHA-256: `999c1e7366d58cb10d207a7396331e990a0d9f40f0b8b269c6bab4df78682dc1`. Its complete upstream CC0 license is in `../schema/LICENSE-CC0.md`. Two upstream trailing-whitespace lines are retained to preserve the exact schema checksum; authored-file whitespace checks exclude only this unchanged vendor file.
- Optional Ledger conversion/lint uses `erc7730==1.0.10` (Apache-2.0), the registry's pinned Python tool version, plus `jsonschema==4.26.0` (MIT). These are isolated development dependencies in `../requirements-ledger.txt`, not production application dependencies. No upstream Python source or signing key is copied into this repository.
- Independent generic rendering uses `@ethereum-sourcify/clear-signing==0.2.2` (MIT) and viem 2.56.3 (MIT), isolated in `clear-signing/package.json`. It validates rendering only; the package does not emulate Ledger PKI or device firmware.

## Display and nested-call decisions

Every dynamic ABI input in the covered methods has a visible field or recursively decoded calldata. There are no excluded/hidden fields, unlimited-approval substitution thresholds, constant spender/recipient replacements, or hard-coded expected trade amounts. Token symbols/decimals are resolved externally by the formatter; an address is separately visible, and fixture metadata is explicitly synthetic.

The account displays its actual transaction `@.to`, native wei, and every call target/value. Nested calls pass their target, value and the executing account (`spenderPath: @.to`). The router's multicall displays the common deadline and recursively resolves every `data[]` element against the same router. It preserves the original router caller (`spenderPath: @.from`) because those calls are delegatecalls. The router caller, token identities, input/minimum output, pool fee, recipient and raw X96 price-limit value stay visible.

The router input label explicitly states `0=router bal`, and recipient flags explicitly explain `1=sender; 2=router`. [Uniswap's source](https://github.com/Uniswap/swap-router-contracts/blob/main/contracts/V3SwapRouter.sol) and [constants](https://github.com/Uniswap/swap-router-contracts/blob/main/contracts/libraries/Constants.sol) implement these sentinel values. A zero input therefore names a dynamic source, not a promise to spend zero. The current application uses positive inputs, explicit wallet recipients and zero X96 (the router's default price limit). These explanations do not resolve on-chain router balances or establish the effects of arbitrary router usage.

## Reproducible validation and its limits

After installing the root Node dependencies, install `clear-signing/requirements-ledger.txt` into an isolated Python 3.12 environment and run:

```sh
/path/to/isolated/python scripts/ledger-clear-signing-validate.py
```

The script checks the vendored schema checksum, validates all three JSON files against the actual schema, runs the official v2 linter with the current application ABI surfaces as explicit local reference data, and invokes the official Ledger converter. It requires complete binding/selector output and preserved visible field order and nested callee/amount/spender context. For the current files, the converter emits 12 unsigned records: one account record, two router records, and nine approval records. No metadata service, wallet, RPC, device, key, or application storage is accessed.

The normal upstream v2 linter fetches remote reference ABIs; version 1.0.10 forwards `--skip-abi-validation` only to its v1 branch. This script replaces only that ABI lookup with documented local ABI data. It checks agreement with the application's selected function surfaces, not all functions of the external contracts or fresh deployment correctness.

There is one retained upstream linter warning: `Missing display field` for `#.calls.[]` in selector `0x34fcd5be`. The linter includes the tuple-array container in its ABI path set but its group collector retains only the target/value/data children. All three children remain visible and convert successfully. Adding a hidden tuple field to silence this warning would misrepresent coverage; the script reports it explicitly and rejects any different or additional warning. This is a qualified validation result, not a warning-free full-contract lint pass.

The Ledger converter flattens v2 field groups and does not encode the requested bundled iteration order. Its successful conversion proves these paths can be represented, not physical presentation order or recursive hardware support. The independent generic renderer exercises grouped full batches, nested fields and failure cases with static fixtures. The subsequent Nano X emulator runs verify exact approval and direct-swap screens with public test certificates. The four-call router wrapper was rejected before review; complete nested and retail-device display remain unverified. See the emulator evidence and reproduction in `../emulator/README.md`.

The Simple7702 deployment binding is deliberately the implementation address, not a funded wallet EOA. The standard's [multi-instance/proxy guidance](https://github.com/ethereum/clear-signing-erc7730-registry/blob/59caf861229afdc584767bb127eea9a6c8c729a6/specs/erc-7730.md#proxy-support) delegates proxy detection to wallets. A production integration must verify the EIP-7702 delegation and runtime and bind the reviewed descriptor to the real self-call while retaining the real wallet container. A test-only in-memory EOA alias exercises formatting; it is not proof of trusted delegation lookup.

Ledger's [tester source](https://github.com/LedgerHQ/device-sdk-ts/blob/21debb71425117964b8c7001070a6ca8d1a9b2da/apps/clear-signing-tester/src/infrastructure/scenarios/ContainerScenarioRunner.ts#L39-L43) states that injected descriptors use test certificates and must not verify against the production PKI root. The documented development route uses Speculos/test certificates. No retail-device developer setting, test-certificate acceptance, production descriptor distribution or hardware approval is established by these checks.
