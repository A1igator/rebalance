# Nested array compatibility limit

The current descriptors cannot complete a multi-call review through the pinned Ethereum app **1.22.3** and **erc7730 1.0.10** converter. This is a specific descriptor/toolchain limitation, not a conclusion about every possible Ledger integration or future release.

The [actual four-swap router diagnostic](nanox-router-failure.json) accepted its transaction metadata and outer contract, caller, native value and deadline fields (`9000`). The nested `CALLDATA` field returned `6a80`; generic review start returned `6980`, and the attempted basic-signing fallback was blocked. No nested review or signature completed in that run. Separate [approval](nanox-approval.json) and [direct swap](nanox-swap.json) captures passed their exact screen checks.

## Why the array fails

In app-ethereum commit `bc637f8986b3b1ec7e044daf7ecb3e832f24258b` (version 1.22.3), [`check_param`](https://github.com/LedgerHQ/app-ethereum/blob/bc637f8986b3b1ec7e044daf7ecb3e832f24258b/src/features/generic_tx_parser/gtp_param_calldata.c#L152-L179) requires the calldata, callee and each supplied chain/selector/amount/spender collection to have exactly the same size. [`value_get`](https://github.com/LedgerHQ/app-ethereum/blob/bc637f8986b3b1ec7e044daf7ecb3e832f24258b/src/features/generic_tx_parser/gtp_value.c#L83-L131) returns one value for `@.from`, `@.to`, `@.value` and constants. It does not replicate that scalar across the array.

| Current descriptor and fixture | Calldata count | Associated context counts | Consequence |
| --- | ---: | --- | --- |
| SwapRouter02 `data.[]`, four swaps | 4 | `@.to`, `@.value`, `@.from`: 1 each | Callee count fails first; amount and spender also differ. |
| Simple7702Account `calls.[].data`, four approvals plus router call | 5 | Targets and values: 5 each; spender `@.to`: 1 | Spender count would fail by the same source rule. This row is source-based inference, not a completed batch-device test. |

Adding a v2 `iteration: "bundled"` group does not solve this with the current converter. The installed **erc7730 1.0.10** `_convert_v2_field` flattens `ResolvedFieldGroup` children into v1 field instructions without preserving iteration. The same behavior is visible in [pinned upstream source](https://github.com/LedgerHQ/python-erc7730/blob/e095dede1da8c74c5b1cdbb075785559cae55fea/src/erc7730/convert/calldata/convert_erc7730_v2_input_to_calldata.py#L362-L370). The inspected 1.0.10 converter file has SHA-256 `e406c78a39a95410e03d51e1391ef38dce698521fe920c35ec8e6fb2565bb139`; the dependency is pinned in [requirements.lock](../requirements.lock). Thus successful schema conversion and the independent browser formatter do not establish device support for grouped nested calls.

No caller, amount, recipient, spender, expiry or nested-call field was removed to force a pass. No firmware was changed. A compatible converter/protocol path must preserve per-call iteration or explicitly support repeated scalar context, then pass full ordered screen checks for every approval and swap. Production metadata trust and real EIP-7702 delegated-account resolution would still need separate verification.
