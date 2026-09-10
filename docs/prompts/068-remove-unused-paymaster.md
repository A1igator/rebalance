# Remove unused gas abstraction — 2026-09-10

The owner previously requested reverting paymaster support if a path without API-key setup was unavailable. After reviewing hosted providers, Calibur relaying and UniswapX, the owner said: “nvm if no such a path exists then”. No verified hosted path met the combined Robinhood/USDG, no developer key, no operated backend and trust requirements. Defer gas abstraction rather than introduce one of those dependencies.

## Plan before implementation

Remove the unused optional Alchemy execution, provider configuration/commands and paymaster-only signer payloads introduced in c9e89f1/ec990e8. Preserve native ETH swaps, the per-wallet estimated fee target, local automatic execution, Privy Agent Sandbox, Ledger confirmation behavior, macOS Keychain wallet storage, live settings and subsequent companion UI fixes. Preserve the feature's original commits, prompts and research as labelled historical records; remove current skill/guide instructions that advertise unavailable commands.

Read only public portfolio configuration and pending metadata before rollback. Do not alter wallets, credentials, targets, run state, pending transactions or incident archives. Reject legacy gasPayment configurations and non-native pending transport fields explicitly so old data cannot silently fall back to native signing or cancellation. Keep those records intact for inspection.

Run the isolated test launcher, typecheck and documentation/reference checks. Record actual results and push the plan and rollback to main under the owner's standing authorization. No replacement paymaster, intent integration or relayer is implemented.
