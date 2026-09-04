# Raw-key support and Privy prize inquiry — 2026-09-04

## User requests (verbatim, in order)

> also my teammate which might contribute has no ledger so it should also work with a basic raw private key

> can you also check if we can go for the privy prize? they have no agent path so I don't think so but asking

After the research findings were shared, the user added:

> it's a TEE so it's fine trust minimization wise

## Applied decisions

Support an explicit local raw-private-key owner backend as well as Ledger. Both share deterministic operations and onchain session restrictions. Raw-key signing requires no device and remains available after Ledger arrives. Its agent-mediated user confirmations trust the authenticated agent/local host; do not claim independent physical human approval in that mode. Each contributor has separate keys/accounts/state. Private key bytes never belong in model prompts or the chart.

Investigate Privy with official sources. The subsequent TEE acceptance resolves the trust-model question: plan Privy as the third partner and an optional profile mode alongside local raw-key and Ledger modes. Keep local planning/scheduling deterministic and verify a substantive Privy wallet/swap flow. No account creation, transactions or enrollment has been performed or is implied by this planning record.

## Signer review prompt (verbatim)

> New user clarification supersedes the no-software-owner-signer assumption: 'also my teammate which might contribute has no ledger so it should also work with a basic raw private key'. Root will add explicit Ledger and local raw-private-key owner backends sharing deterministic proposal/transaction construction and session constraints, no automatic fallback, agent-only controls, secrets referenced locally and not sent to cloud LLM. Review material design implications for approval semantics, raw owner key vs session key, teammate independent accounts, Ledger prize evidence and pre-device milestones. Read-only, no implementation, browse or edits. Return concise material recommendations.

The review identified that not exposing a key does not eliminate effective signing authority. The plan explicitly distinguishes trusted agent-mediated software confirmation from Ledger's independent physical confirmation.

## Privy researcher prompt (verbatim)

> User asks: 'can you also check if we can go for the privy prize? they have no agent path so I don't think so but asking'. Verify current ETHOnline 2026 Privy prize exact eligibility/deliverables and official Privy agent/headless/raw-key/wallet tooling. Primary sources only, browse official event and Privy docs. Project has view-only local pie chart, all human controls via Claude Code/Codex, deterministic local recurring rebalance, Robinhood + Uniswap, local raw-owner-key backend and optional Ledger (device delayed). Need whether Privy has an agent path; technical vs architecture fit; can add Privy optional adapter without forcing cloud signing to core; max three prize partners known. Return concise recommendation and precise official URLs, note trust/local-operation tradeoffs and avoid claiming an adapter alone guarantees prize eligibility. Do not edit files or use external accounts.
