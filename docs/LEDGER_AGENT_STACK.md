# Ledger Agent Stack integration assessment

Research: **2026-09-04**. No package installation, runtime probe, account discovery, hardware test or transaction has occurred. These are documentation/source findings, not a working integration. Read the [minimal-scope decisions](prompts/006-minimal-mvp.md) and [latest direct-signing decision](prompts/008-direct-signing-and-ledger-connect.md) alongside the current plan.

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

## Current Ledger flow

Use direct hardware signing with current Agent Stack components. Session-key/delegation work is cancelled; the earlier discussion remains in prompt history. Track the configured public address without a device. On connection or startup with the device attached, reconcile earlier sends, refresh balances/drift and prepare a fresh quote if rebalancing is still needed. Queue one agent-visible request, retaining it if the agent is unavailable.

Check device/app readiness and the configured account before signing. Connection or Ring decryption is not transaction approval. Physical confirmation remains required for each signing operation. Keep monitoring after rejection without repeatedly reopening its prompt. Demonstrate disconnected drift tracking, connection, the fresh request and device signing/rejection; the chart remains view only.
