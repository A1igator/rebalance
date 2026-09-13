# Real Ledger Clear Signing for a delegated rebalance

Date: September 13, 2026.

The owner requested implementing actual Clear Signing for the current Ledger rebalance after seeing the device's blind-signing warning. The current execution path is an EIP-7702 Simple7702Account self-call containing exact ERC20 approvals followed by a Uniswap SwapRouter02 deadline multicall and its ordered exact-input swaps on Robinhood chain 4663. Calibur remains an alternative implementation, not an inner call in this path.

## Scope

Investigate the installed Ledger Signer Kit and Context Module, the current public ERC-7730 registry, nested-call formatting and delegated-account resolution. Prepare and validate truthful descriptors if the toolchain can represent the complete transaction. Preserve the exact contract identities, recipients, spenders, amounts, minimum outputs and expiry. Do not hide undecoded fields, bypass device trust checks, use developer signing roots or call a local description production Clear Signing.

Probe public metadata access without loading a signer, using the device, reading wallet secrets or constructing a sendable transaction. Resolve any local integration defects supported by evidence. Trusted metadata, provider enrollment and actual device display are separate milestones. A successful lint, context lookup or earlier transaction is not proof of Clear Signing. No live trade, target/configuration edit, runner restart or signing request is authorized by a diagnostic probe. Prepare any provider request for review before sending it. Tenjin stays disabled for the demo.

## Validation

Use isolated files and synthetic calldata for formatting/probe checks. Record pinned source and tool versions, exact missing production prerequisites and results rather than assuming support. Any production completion claim must be based on an observed physical device display for the exact current path. Record the work and remaining external dependencies in the AI usage log.

## Outcome and scope correction

The owner clarified that partner enrollment is unavailable and deferred production implementation if it is required, then asked about the documented development route. Ledger's wallet integration guide requires an originToken, while the published registry hardware tester asks for a GATING_TOKEN and firmware access. The SDK tester can take a custom app binary and local ERC-7730 files; its source explicitly uses test certificates with the emulator's test root for injected metadata. This is a development display test, not evidence that an ordinary retail Ethereum app accepts the same descriptors. No working token-free retail-device setting was established.

Read-only source research confirmed nested CALLDATA references, production signed-descriptor and PKI requirements, and separate proxy-resolution support. Registry metadata preparation was paused before any descriptors were created; the unused metadata-probe draft was removed without running it. No provider request, metadata-service probe, device command, transaction or application configuration change occurred. The production implementation remains deferred. Development testing, if resumed, must be reported separately from the funded demo flow.

A later source check distinguishes the packaged setup instructions from the current SDK implementation: descriptor injection has a test-placeholder token fallback and its conversion endpoint has no token check. A partner-free emulator workflow may therefore be feasible. No end-to-end rendering or retail-device acceptance was tested, so this is not a production fix or a verified device setting.
