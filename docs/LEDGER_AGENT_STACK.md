# Ledger Agent Stack integration assessment

Initial research: **2026-09-04**. The September 4 findings below preceded installation or device work. The [September 7 adoption record](#deterministic-account-onboarding--2026-09-07) adds a tested setup implementation and exact SDK dependencies; physical address verification subsequently succeeded; transaction execution is now wired but live transaction/display evidence remains unverified. See [the September 10 flow](LEDGER_EXECUTION.md). Read the [minimal-scope decisions](prompts/006-minimal-mvp.md) and [latest direct-signing decision](prompts/008-direct-signing-and-ledger-connect.md) alongside the current plan.

The project's sole network is **Robinhood mainnet (4663)**. Other chain configurations cited below are source-comparison evidence from the earlier CLI investigation, not additional project targets or fallbacks. See [the network decision](prompts/010-robinhood-only.md).

## Reuse strategy

The [Agent Stack](https://shop.ledger.com/pages/ledger-agent-stack) combines runtime wallet tools, coding skills and hardware security. Use its native device lifecycle, Ethereum signing and suitable swap primitives before building equivalents. Running deterministic code around an SDK/CLI does not require an LLM in the transaction loop. The hardware backend waits for physical approval; raw-key and Privy use separate automatic signer adapters.

Use the official [DMK skills](https://developers.ledger.com/docs/ai-tools/ledger-dmk-skills): `ledger-dmk-implementation`, `dmk-intent-vocabulary` and `dmk-business-logic`. Pin their source/version and record adoption before implementation. Native transport keeps hardware interaction outside the view-only chart. Skills guide development; installing them alone is not a demonstrated Ledger integration.

## Chain support: corrected conclusion

The [CLI documentation](https://developers.ledger.com/docs/ai-tools/ledger-cli) advertises Ethereum/EVM support, JSON output and a Uniswap provider. **Robinhood must not be ruled out because it is an L2.** Source inspection found a narrower quote-command guard alongside broader EVM paths.

Source snapshot: [Ledger Live commit `6f9b570`](https://github.com/LedgerHQ/ledger-live/tree/6f9b570de882356b1660e75b7c747ef2887fde13/apps/wallet-cli), whose package identifies version 2.4.0. The documentation's example version is 2.1.0. Neither establishes the behavior of a future installed release.

| Source evidence | Meaning and remaining gate |
| --- | --- |
| Shared EVM [Robinhood mainnet config](https://github.com/LedgerHQ/ledger-live/blob/6f9b570de882356b1660e75b7c747ef2887fde13/libs/ledger-live-common/src/families/evm/config.ts#L1101), [testnet config](https://github.com/LedgerHQ/ledger-live/blob/6f9b570de882356b1660e75b7c747ef2887fde13/libs/ledger-live-common/src/families/evm/config.ts#L1116), [Base config](https://github.com/LedgerHQ/ledger-live/blob/6f9b570de882356b1660e75b7c747ef2887fde13/libs/ledger-live-common/src/families/evm/config.ts#L608) | Existing configurations include chain IDs 4663, 46630 and 8453. EVM capability is broader than Ethereum mainnet. |
| [Account discovery](https://github.com/LedgerHQ/ledger-live/blob/6f9b570de882356b1660e75b7c747ef2887fde13/apps/wallet-cli/src/commands/account/discover.ts#L69) and [network resolution](https://github.com/LedgerHQ/ledger-live/blob/6f9b570de882356b1660e75b7c747ef2887fde13/apps/wallet-cli/src/shared/accountDescriptor/network.ts#L121) | Registry-based network selection; not the quote guard and not arbitrary chain-ID/RPC flags. Packaged registry/bridge coverage needs validation. |
| [Send dispatch](https://github.com/LedgerHQ/ledger-live/blob/6f9b570de882356b1660e75b7c747ef2887fde13/apps/wallet-cli/src/commands/send.ts#L80) | Uses blockchain family, including EVM; actual synchronization/signing remains untested. |
| [Swap quote guard](https://github.com/LedgerHQ/ledger-live/blob/6f9b570de882356b1660e75b7c747ef2887fde13/apps/wallet-cli/src/commands/swap/quote.ts#L22) | Explicitly accepts Bitcoin, Ethereum and Solana IDs or tokens whose parent is one of those IDs. This command rejects Base/Robinhood currencies at this snapshot. |
| [Execute currency resolution](https://github.com/LedgerHQ/ledger-live/blob/6f9b570de882356b1660e75b7c747ef2887fde13/apps/wallet-cli/src/commands/swap/execute.ts#L164) and [EVM pipeline](https://github.com/LedgerHQ/ledger-live/blob/6f9b570de882356b1660e75b7c747ef2887fde13/apps/wallet-cli/src/commands/swap/execute.ts#L252) | Resolves registered currencies/tokens without the same guard, obtains its own quote and dispatches supported DEX providers through EVM execution. This does not prove successful Robinhood swaps, but invalidates a blanket no-L2 conclusion. |

Do not change Ethereum's RPC and leave chain ID 1. Use the actual target-network configuration and verify serialized chain IDs. Next validate the pinned package, registry/account path, token metadata, quote/build service coverage and available routes; device signing follows after arrival. A provider supporting a chain does not establish stock-pair liquidity.

## Transaction and privacy boundaries

The inspected execute command requotes and does not expose an exact prepared-transaction/quote-ID or sufficient minimum-output/slippage interface for our swap settings. Reuse shared components to inspect the final transaction before signing. Do not treat a fresh opaque swap command as proof that a prior preview was preserved. This is normal swap correctness, not a spending-budget engine.

The shared [Uniswap adapter](https://github.com/LedgerHQ/ledger-live/blob/6f9b570de882356b1660e75b7c747ef2887fde13/libs/ledger-live-common/src/wallet-api/Exchange/dex/swap-api/uniswap.ts) calls Ledger-hosted swap infrastructure. The CLI [entry point](https://github.com/LedgerHQ/ledger-live/blob/6f9b570de882356b1660e75b7c747ef2887fde13/apps/wallet-cli/src/cli.ts) initializes analytics, with [Segment implementation](https://github.com/LedgerHQ/ledger-live/blob/6f9b570de882356b1660e75b7c747ef2887fde13/apps/wallet-cli/src/analytics/segment.ts). Pin and inspect behavior; do not bundle the stock CLI unchanged while claiming the entire path is telemetry-free or local-only.

No raw-private-key/Privy signer switch was identified in the inspected hardware swap command. Sharing planning and suitable swap primitives does not mean routing software signing through a hardware-only command. Verify actual Clear Signing/context behavior separately using the [Ethereum signer](https://developers.ledger.com/docs/device-interaction/dmk-ts/references/signers/eth).

## Key Ring and prize value

The documented Ring lifecycle uses hardware for enrollment, then a local password and network trustchain restoration for subsequent encryption/decryption without another device tap. Decryption produces plaintext; Ring is not a scoped service proxy. [Ring documentation](https://developers.ledger.com/docs/ai-tools/ledger-cli#key-ring)

Retain a small local broker for a credential the application actually needs, such as Privy or a quote service. Demonstrate private credential retrieval and an allowed service operation versus a denied unrelated request, using endpoint/method restrictions and redacted output. No amount limits or budget counters. The broker checks are our implementation. Claiming that an agent cannot extract secrets requires actual isolation; unrestricted same-user shell access defeats that claim. Implement only what the demonstrated boundary needs and state its limits. Ring network dependence remains explicit. Contributors without devices keep normal local secret references.

For [Ledger judging](https://ethglobal.com/events/ethonline2026/prizes/ledger), demonstrate real device-confirmed rebalancing and rejection, plus a Ring-backed allowed/denied operation if adopted. Keep device feedback pending until tested. No installation count or speculative broker substitutes for working evidence.

## Deterministic account onboarding — 2026-09-07

[Prompt 047](prompts/047-deterministic-wallet-onboarding.md), committed as `1e0857d` before adoption, authorizes New portfolio → Ledger to run local setup without a model-directed dialogue. `src/ledger-onboarding.ts` uses the official DMK and Ethereum Signer Kit directly. It never initializes or resets the device seed, installs device apps, signs a message or transaction, fetches balances, broadcasts, or arms a runner. Unlocking the device, opening Ethereum and physically verifying the new address remain hardware interactions.

Installed with `npm install --save-exact --ignore-scripts --no-audit --no-fund`; no dependency lifecycle script was executed. Exact package tarball URLs, integrity hashes and resolved transitive versions are retained in `package-lock.json`. No stock `wallet-cli` was installed and no CLI analytics entrypoint is used.

| Direct dependency | Exact version | License | Primary provenance |
| --- | --- | --- | --- |
| `@ledgerhq/device-management-kit` | 1.9.0 | Apache-2.0 | [Published package](https://registry.npmjs.org/@ledgerhq/device-management-kit/1.9.0) |
| `@ledgerhq/device-transport-kit-node-hid` | 1.0.1 | Apache-2.0 | [Published package](https://registry.npmjs.org/@ledgerhq/device-transport-kit-node-hid/1.0.1) |
| `@ledgerhq/device-signer-kit-ethereum` | 1.18.0 | Apache-2.0 | [Published package](https://registry.npmjs.org/@ledgerhq/device-signer-kit-ethereum/1.18.0) |
| `@ledgerhq/context-module` | 2.5.0 | Apache-2.0 | [Published package](https://registry.npmjs.org/@ledgerhq/context-module/2.5.0) |
| `rxjs` | 7.8.2 | Apache-2.0 | [Published package](https://registry.npmjs.org/rxjs/7.8.2) |

Ledger package source provenance is [LedgerHQ/device-sdk-ts](https://github.com/LedgerHQ/device-sdk-ts), including source maps shipped in these npm artifacts. Resolved native transitive packages are `node-hid@3.4.0` (`MIT OR X11`) and `usb@2.18.0` (MIT); the lockfile records the rest. Package licenses continue to apply independently of this repository's MIT license.

### Public account derivation and replay

The hardware path is lazy: loading the app, selecting a different signer, or replaying a completed Ledger request does not load the native SDK. Selecting Ledger connects through DMK Node HID, with no logger subscribers and no session background refresh. Device discovery waits for one available device; multiple exposed devices require the user to connect just the intended Ledger. The operation has a 120-second deadline and bounded two-second cleanup, with observable cancellation/unsubscription, DMK disconnection and native transport destruction. The pinned Node HID implementation also installs a process exit callback; the adapter removes only the callback installed by its own transport during cleanup.

The app derives public account zero at `44'/60'/0'/0/0` without displaying or exporting a chain code, hashes the public address as a local seed identifier, then reserves the next index starting at **1**. Paths follow the Ledger Live account convention `44'/60'/index'/0/0`. The address action for that reserved path uses `checkOnDevice: true` and `returnChainCode: false`. Only a valid completed device response succeeds; pending, rejection, interruption, malformed output or timeout cannot create a completed wallet. A second public anchor read checks that the seed identity did not change during verification.

The local `ledger-onboarding/accounts.json` journal stores the request key, public seed fingerprint, index/path and, after verification, public address/timestamp. It contains no secret, seed, chain code or public-key export. A Ledger-only process lock serializes reservations/device access, and atomic 0600 writes persist the reservation **before** requesting physical verification. Existing directory components are checked for aliases; journal/lock reads use no-follow file descriptors and reject linked files, oversized data and broad file permissions. The same request retains its original seed and index after rejection or interruption; completed requests return the saved public result without hardware access. New requests increment independently for each seed. Account zero remains reserved for the existing primary account. This means **new to Rebalance**, not a guarantee that an index has never been used in another app or on another chain.

Ethereum addresses are chain-independent. Setup intentionally omits `chainId` from `getAddress`; the published signer would otherwise load dynamic network context while verifying. The screen verifies an Ethereum address, and the application separately binds the resulting portfolio to Robinhood 4663. This is not evidence of Robinhood-specific device labeling or Clear Signing. No telemetry/logging subscriber is enabled; broader Ledger signing, metadata and Ring operations may have external dependencies and are outside this setup-only path. [Ethereum signer API](https://developers.ledger.com/docs/device-interaction/dmk-ts/references/signers/eth)

### Actual validation and remaining limits

All four adopted Ledger package CommonJS entrypoints loaded on **Node v24.18.0, macOS arm64**, with lifecycle scripts still disabled. The verification only required modules: it did not construct DMK/transport, discover/connect a device, derive an address or make a device request. The packages' ESM entrypoints failed under native Node because they contain extensionless/directory imports. The adapter therefore uses their documented package `require` exports through lazy `createRequire`, and the published signer constructor `{ dmk, sessionId }`, rather than the website's older `{ sdk, sessionId }` example.

`tests/ledger-onboarding.test.ts` passed **15/15** isolated fixtures, and project TypeScript checking passed. Fixtures cover completed-only output, durable reservation before verification, replay, per-seed index separation, cross-seed rejection, identity changes, malformed output, cancellation/timeouts, missing/multiple devices, late connection disposal, lock serialization, linked-storage rejection and unchanged existing profile/trading files. Native imports passing does not establish USB/device compatibility; the transport's own README reports testing on Node 20. Its current discovery implementation also deduplicates entries by device model, so only the intended Ledger should be connected; multiple devices of the same model are not reliably distinguishable through that interface. Ledger hardware confirmation, rejection, Robinhood signing and prize qualification remain pending actual tests.

## Current Ledger flow

Use direct hardware signing with current Agent Stack components. Session-key/delegation work is cancelled; the earlier discussion remains in prompt history. Track the configured public address without a device. On connection or startup with the device attached, reconcile earlier sends, refresh balances/drift and prepare a fresh quote if rebalancing is still needed. Queue one agent-visible request, retaining it if the agent is unavailable.

Check device/app readiness and the configured account before signing. Connection or Ring decryption is not transaction approval. Physical confirmation remains required for each signing operation. Keep monitoring after rejection without repeatedly reopening its prompt. Demonstrate disconnected drift tracking, connection, the fresh request and device signing/rejection; the chart remains view only.

## Device signing adoption — 2026-09-10

[Prompt 053](prompts/053-ledger-execution.md) was committed as `6708dd9` before implementation. The signer reuses the existing locked packages and the shared indexed account journal/hardware mutex. No package versions changed. Official development guidance was read from [LedgerHQ/agent-skills at `2edb393`](https://github.com/LedgerHQ/agent-skills/tree/2edb3937d80dec28f46c87c29aae841e6874fc7d/skills/dmk/ledger-dmk-implementation), including its skill and SDK/code/platform references; these instructions were not vendored. Installed type definitions/source maps were authoritative where examples differed.

The application signs its exact viem-serialized chain-4663 legacy transaction through `SignerEth.signTransaction`, checks the returned EIP-155 signature and sender, and retains its normal pending-hash/receipt journal. Each signature uses the saved verified indexed path and actual device confirmation. The standalone wallet-cli 2.1.0 helped diagnose the Nano Gen5 and perform a genuine check; its opaque swap command is not used for application dispatch.

Pinned SDK source revealed `BlindSigningDetectionTask` reports signing metadata through Context Module even without DMK log subscribers. The builder now retains its context resolution methods but replaces `report` and `signReport` with no-ops. Ledger context services remain an external dependency. The adapter cancels the explicit fallback transition and does not claim universal Clear Signing. Passive Node HID discovery observes USB changes without opening a device connection. See [behavior and test limits](LEDGER_EXECUTION.md).
