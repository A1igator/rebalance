# Prepare Ledger Clear Signing compatibility

Date: September 13, 2026.

The owner resumed development after the Speculos explanation: “also let’s do it anyways to be ready for max ledger compatibility”. Prepare ERC-7730 v2 descriptors for the actual Simple7702Account batch, nested Uniswap SwapRouter02 deadline multicall and exact-input swaps, plus exact ERC20 approvals. Build reproducible isolated formatting and emulator checks using public upstream tools and synthetic transactions. Preserve every security-relevant amount, target, recipient, spender, expiry and native value. Unknown nested calls must remain visibly unsupported; a generic readable wrapper does not make the entire batch clear.

The current funded runtime, signer behavior, delegation, fee settings and transactions are outside this development task. Do not change device settings, install test trust roots on the physical Ledger, read wallet secrets, broadcast, contact providers or submit descriptors without separate authorization. Emulator test certificates are for isolated development only. No partnership or production originToken is available. Record pinned versions/licenses and actual results; distinguish schema validation, software rendering, emulator screen evidence and production device acceptance. Keep Tenjin disabled and push the completed project changes to main, preserving unrelated edits.

The owner paused the emulator during filming, then explicitly resumed and asked for a visible emulator to screenshot for the hackathon. Preserve the work through the pause. On resume, use the native Speculos WebUI and clearly distinguish emulator/test-metadata screenshots from physical-device or funded execution evidence. Limit concurrent emulator resource use; leave unrelated VMs untouched.
