# Fixed matching-context protocol adapter

`compile-matching.py` is an isolated development adapter for the fixed four-swap router fixture and five-call Simple7702 fixture. The canonical ERC-7730 descriptors remain unchanged. It uses the unmodified pinned Ledger converter to produce indexed fields, then adds a firmware-enforced array-length assertion as a binary FIELD instruction. This extension is not ordinary ERC-7730 v2 conversion and is never loaded by the production signer.

Run it after the ordinary compiler has created `compiled-test-context.json` in an explicit `/tmp` work directory:

```sh
"$emulator_dir/python/bin/python" clear-signing/emulator/compile-matching.py \
  "$emulator_dir/device-sdk-ts" "$emulator_dir"
python3 clear-signing/emulator/test_matching.py
```

The compiler accepts only absolute paths, requires the pinned SDK and converter, reuses the existing public test certificates/token/network fixtures, and writes a new `matching-test-context.json` exclusively. It never calls the upstream certificate-fetch endpoint. Repeated compilation must use a fresh output location; it never overwrites existing metadata. The injector's explicit `--matching-context` option selects this file for synthetic fixtures only.

## What is preserved

Router `data.[]` becomes four separate `data.[0]` through `data.[3]` calldata fields. Each keeps its actual router callee, native amount and original caller. Account `calls.[]` becomes five groups of indexed target, value and calldata fields; each calldata field keeps that same index's target/value and the executing account as spender. No call target, amount, spender, nested swap field or outer field is removed.

Indexing alone cannot establish that all array elements were reviewed. A guard therefore precedes every other field. It reads the actual uint256 array length from the transaction's ABI data and requires exactly four router elements or five account elements. A mismatch prevents approval; the negative fixture results distinguish earlier SDK path rejection from firmware guard rejection. The original field bytes remain in order after the guard, and the transaction-info signature covers the SHA3-256 digest of the complete new field list, including that guard.

## Binary instruction provenance

Protocol identity: `rebalance-fixed-array-context-v1`. These are original Rebalance compiler instructions implementing the public Ledger protocol, with no new dependency or firmware changes. Upstream Ledger SDK, Ethereum app and converter retain their Apache-2.0 licenses.

| Component | Pin and purpose |
| --- | --- |
| Ledger sample converter/test signing | device-sdk-ts `21debb71425117964b8c7001070a6ca8d1a9b2da`, unchanged `apps/sample/api/index.py` |
| ERC-7730 conversion | `erc7730==1.0.10`; converter SHA-256 `e406c78a39a95410e03d51e1391ef38dce698521fe920c35ec8e6fb2565bb139` |
| Binary parser reference | app-ethereum `bc637f8986b3b1ec7e044daf7ecb3e832f24258b`, Ethereum app 1.22.3 |

The guard uses FIELD version 1, RAW parameter type 0 and a UINT value with 32-byte size. DATA_PATH is `TUPLE(head slot) → REF → STATIC_LEAF`: slot 1 for the router's `bytes[]`, slot 0 for the account's tuple array. The path follows the ABI head offset and reads the array-length word; the count is not a host-supplied display value. FIELD tag `0x04` sets visibility to `MUST_BE` (`0x01`), and tag `0x05` supplies the expected uint256 count. The exact-count assertion need not appear as a screen, but the firmware must enforce it before nested review.

Verified source references:

- [ABI tuple, reference and static-leaf interpretation](https://github.com/LedgerHQ/app-ethereum/blob/bc637f8986b3b1ec7e044daf7ecb3e832f24258b/src/features/generic_tx_parser/gtp_data_path.c#L114-L157).
- [FIELD visibility/constraint tags](https://github.com/LedgerHQ/app-ethereum/blob/bc637f8986b3b1ec7e044daf7ecb3e832f24258b/src/features/generic_tx_parser/gtp_field.c#L35-L42) and [constraint parsing](https://github.com/LedgerHQ/app-ethereum/blob/bc637f8986b3b1ec7e044daf7ecb3e832f24258b/src/features/generic_tx_parser/gtp_field.c#L82-L134).
- [Mandatory uint256 equality and rejection](https://github.com/LedgerHQ/app-ethereum/blob/bc637f8986b3b1ec7e044daf7ecb3e832f24258b/src/features/generic_tx_parser/gtp_param_raw.c#L45-L110).
- [Signed-field hash updated before formatting and rolled back on rejection](https://github.com/LedgerHQ/app-ethereum/blob/bc637f8986b3b1ec7e044daf7ecb3e832f24258b/src/features/generic_tx_parser/cmd_field.c#L28-L58).

The pinned Python FIELD model/serializer does not expose those visibility tags, and its ordinary ABI path conversion rejects array leaves. Consequently the extension emits this one narrow RAW guard directly; it does not modify the upstream package or pretend an array is an ERC-7730 scalar field. No private production metadata key or test key is copied into the repository. Test signing stays with the upstream public emulator converter.

## Scope and validation

The offline protocol tests evaluate the emitted guard bytes against real viem ABI encodings for lengths 0–6, mutated counts, malformed pointers and truncated payloads. They also verify that index expansion preserves every field and association, rejects changed assumptions, and cannot overwrite a prior output. These are independent protocol/ABI checks; actual firmware and screen evidence is recorded separately in the [emulator workflow](README.md).

Only the exact four-swap/five-call synthetic variants are packaged. Supporting every production batch length would need separately authenticated count variants and compatible selection for each nested call. The ordinary CAL descriptor lookup selects by chain, address and selector; it does not select by calldata array length. Full EIP-7702 wallet-to-implementation resolution, production metadata trust/distribution and physical-device display remain unverified. Test certificates, successful emulator signatures and this narrow compatibility result establish none of those production capabilities.
