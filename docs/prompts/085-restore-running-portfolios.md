# Restore previously running portfolios on app entry

Date: 2026-09-12. This is the latest human clarification to prompt 084: the skill should ready background portfolios and use a short natural ready/pick message. The subsequent clarification explicitly limits restoration to portfolios that were running previously, rather than starting all registered wallets.

## Final behavior

Bare native Rebalance entry restores saved running preferences, reuses live services, and opens the linked portfolio selector. The chat connection is independent of background execution. Explicitly stopped, never-started and unknown portfolios remain stopped. Card selection only attaches the chat. The response should be brief and natural, not a fixed script, with truthful exceptions for actual blockers.

Persist per-wallet running intent at a real runner start; explicit Stop persists disabled intent and remains authoritative. An unexpected process exit preserves the preference for a future explicit skill invocation. For legacy runners lacking preferences, adopt only public evidence of a currently live owned runner with matching wallet/chain and no Stop; never infer prior running from cached armed state alone. No startup at login or new periodic task is introduced.

A new restoration invocation freezes eligible wallet identities, preference generations and Stop generations before view/dependency/launch side effects. Replays cannot add wallets or resume a newer Stop. Old single-wallet and terminal selection-only hook receipts keep their original meaning. Scoped launch/start/all/status/setup-only and pinned workers retain their named semantics. Native Codex, Claude and OpenCode entry provenance remains required for deterministic dispatch; no changes to host trust or permission settings and no model workaround for blocked financial actions.

## Validation and scope

Use isolated fixtures for persisted start/Stop intent, legacy live adoption, fresh/inactive wallets, process exits, cross-conversation selection, newer Stop/config races, immutable restoration replay, duplicate prevention, partial failures and view availability. Validate the shared host adapters and concise skill guidance. No live restoration, trading, signing, cancellation, target edits or credential inspection occurs during development. Commit/push main under standing authorization, excluding pre-existing stock-link edits. Prompt 084 remains the recorded earlier selection-first design; its full-launch interpretation is superseded here.
