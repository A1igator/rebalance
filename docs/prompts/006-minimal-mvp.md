# Minimal MVP with sponsor-specific features — 2026-09-04

## User requests (verbatim, in order)

> no spending limits needed. it's mvp so security features like this are not needed simplify it as much as possible

> the ledger specific ones can stay to demonstrate ledger more for prizes

> same with privy tbh

## Applied decisions

Remove per-trade/daily/cumulative spending caps, budget accounting and generic policy/security infrastructure. Collapse the package monorepo into one TypeScript app with ordinary config, a CLI, the deterministic loop, signer/network modules, a view-only chart and a small pending-transaction record.

Retain Ledger-specific device signing, Key Ring and a focused credential-broker demonstration, and Privy-specific TEE wallet/scoped authorization features for prize value. Use supported operation/contract/method restrictions without monetary caps. Keep their actual allowed/denied evidence focused on the integration rather than building a general permissions platform.

Keep the mechanics needed for a working swap: correct integer amounts/targets, selected chain/assets/recipient, usable price/route, slippage/expiry, available balance/gas and pending-transaction tracking. Automatic local-key/Privy execution still needs no human or LLM input per swap. Device work remains deferred until arrival; all app commands remain agent-mediated and the chart stays view only.

The initial draft deferred all broker/extra authorization work; the two sponsor clarifications superseded that interpretation before commit. The subsequent [session-key discussion](007-session-key-reconsideration.md) adds a separate feasibility check while preserving the no-budget requirement.

## Material review prompts (verbatim)

> User: 'no spending limits needed. it's mvp so security features like this are not needed simplify it as much as possible'. Root will rewrite PLAN to minimal targets+drift+poll loop, raw-key/Privy auto Ledgerdevice, local CLI+config+read-only chart, basic transaction persistence. Remove per-trade/daily/rolling caps, budget accounting, policy engine/Privy custom restrictions, Ring capability broker/isolation, generic routing/auth/control infrastructure, hysteresis/cooldown as extra configurable features. Retain basic correct swaps (integer amounts, right chain/assets/recipient, slippage/deadline, available balance/gas, no duplicate concurrent sends, receipt before nexttrade, no secret logging) and user-required Ledger physical confirmation. Review current docs read-only for material simplification scope suggestions; do not reintroduce security framework or optional budgets. No research, edits or implementation.

> User further clarifies 'the ledger specific ones can stay to demonstrate ledger more for prizes' then 'same with privy tbh'. Root will retain Ledger KeyRing + small credential broker/allowed-denied demo and Privy scoped service authorization/allowed-denied demo where supported, but NO monetary spendcaps/budgetaccounting (original removal persists). Shared app remains one TypeScript project, plainconfig +pendingtx, no general policyframework. No need new research; correction for final review scope.

The reviewer recommended one application, ordinary config, a pending transaction record, one selected network/route and focused signer integrations. No implementation or signing was performed.
