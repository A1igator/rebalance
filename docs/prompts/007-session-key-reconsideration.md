# Reconsidering session keys without budgets — 2026-09-04

## User requests (verbatim, in order)

> I wonder if best is we go back to our own signing with session keys. it's on the ledger roadmap anyways: "Agent intent & policies
> Async, queued approvals. Bounded autonomy. Crypto first, then beyond" and we can still demonstrate the easy signing UI

> no spending cap and budget accounting needed though still cuz that's still overkill for mvp

## Assessment and proposed next step

Keep spending caps and budget accounting out of every path, including any session implementation. Our own Ledger/DMK signing integration can provide agent-mediated review and device confirmation; session delegation is the extra capability that would permit automatic swaps after an initial Ledger approval. The chart remains view only.

The assistant checked the [Ledger roadmap](https://shop.ledger.com/pages/ledger-agent-stack): the quoted capability is labelled coming soon. It is not evidence of a working session API. [Ethereum's account-abstraction explanation](https://ethereum.org/roadmap/account-abstraction) distinguishes ordinary EOA keys from programmable account authorization. [Rhinestone Smart Sessions](https://docs.rhinestone.dev/smart-wallet/smart-sessions/overview) documents action and timeframe controls separately from spending-limit policies and marks SDK support experimental.

Proposed scope is a focused feasibility check of one existing account/session module on the selected chain: authorize one signer for specified rebalance operations/recipient, execute a real swap, reject an unrelated operation, and verify expiry/revocation. No spending/usage caps, counters, reservations or custom vault. Chain, package, funding/submission path and real Ledger authorization remain unverified. No module has been selected or installed.

The direct-wallet flow remains the baseline until this check produces evidence. If sessions are adopted, the demo must distinguish Ledger authorization of the session from subsequent software/Privy session signatures. A plain signed JSON file cannot itself delegate spending from an ordinary Ledger EOA. This preserves a simple product while allowing a stronger autonomy demonstration if an existing module fits.

## Independent review prompt (verbatim)

> New user weighing design: 'I wonder if best is we go back to our own signing with session keys. it's on the ledger roadmap anyways: "Agent intent & policies Async, queued approvals. Bounded autonomy. Crypto first, then beyond" and we can still demonstrate the easy signing UI'. Need concise independent recommendation consistent user simplify no monetaryspendlimits, keep sponsorLedger/Privy features; original viewonlychart agentonly. Compare current direct rawkey/Privyauto Ledgerpertrade vs sessionkey Ledgerinitialauthorization thenunattended. Explain sessionkey requires actual enforceable smartaccount/module/vault authorization, EOA signed JSON notenough; no fakehardware pertradeproof; sessions expiry/revoke/core permissions complexity. Would you recommend reintro now, narrow optional spike, or current design? Read-only no edits, no need broadweb unless source-specific needed. Root checking official roadmap.

The reviewer recommended preserving the direct-wallet baseline and assessing a narrow existing-module path before committing to an architecture rewrite. It distinguished session scope/duration from monetary limits and hardware session approval from per-swap signing. No implementation or transaction was performed.

## Final document review prompt (verbatim)

> Review active docs for the final scope: no spending caps/budget accounting, one simple TypeScript app, Ledger/Privy prize features retained, and existing-module session feasibility only with direct signing baseline until verified. Check PLAN.md README.md AGENTS.md CLAUDE.md docs/PRIVY.md docs/RESEARCH.md docs/LEDGER_AGENT_STACK.md for contradictions. Historical prompts/AI entries are intentionally preserved. Read-only; return material issues only.

The reviewer identified an implementation-status overclaim and a pending-transaction persistence ordering gap. The final plan uses prospective wording for the unbuilt Ledger adapter and records a pending marker before dispatch, stopping on uncertain submission rather than repeating it. No monetary accounting was added.
