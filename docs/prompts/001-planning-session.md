# Initial planning prompts — 2026-09-04

These project-specific prompts and constraints produced the initial plan. No application implementation was requested or produced in this session. No secrets or private portfolio data are included.

## Original user request (verbatim)

> The goal of this project is to compete in [https://ethglobal.com/events/ethonline2026/home](https://ethglobal.com/events/ethonline2026/home) start from scratch track so make sure you abide by all the rules like committing plan files. I want to build a completely trustless, local, privacy preserving rebalancer with claude code/codex input and a simple local pie chart UI. I want to maximize the deterministic code parts while allowing LLM input into the rebalance. ie can ask codex to change ETH percent from 20% to 30%, but the automatic rebalancing should happen with no LLM input. I want it on robinhood chain since there's stocks there, using a lightnode if possible to make it trustless. I'm also aiming for both uniswap and ledger prize tracks. You can suggest additional ones if you think makes sense. Make the repo on my personal for the hackathon as I believe it's started and push a plan for it to said repo. Make the repo branch protected for everyone except me. I'll push to main

## User clarification (verbatim)

> cloud LLM use is fine for now and hackathon purposes trust wise

Applied interpretation: cloud coding assistants are accepted for allocation proposals. A local model is not required. Deterministic scheduled execution and separation of keys/activation authority remain requirements.

## Parallel task prompts

### Hackathon rules researcher

> Verify ETHOnline 2026 official dates, start-from-scratch track rules (especially planning files/initial commits), judging/submission requirements and exact Uniswap and Ledger prize track requirements. Browse official sources; event URL https://ethglobal.com/events/ethonline2026/home is JS-heavy. Use CUA if needed (you own browser work for event so root won't collide). Return precise actionable findings with official URLs, dates, quoted short relevant passages, ambiguities. Also suggest at most two additional confirmed compatible sponsor tracks. Do not modify repo or send external messages.

Follow-up:

> Please send exact prize details/links soon; ready to draft initial commit. Need specific Uniswap requirement API vs SDK vs v4 and Ledger DMK/Clear Signing constraints. Repo now created public https://github.com/A1igator/rebalance, no commits yet. Root will handle all files.

### Chain feasibility researcher

> Research official current Robinhood Chain feasibility for local privacy-preserving deterministic rebalancer: deployed network(s), real vs test stocks, asset/pool availability, Uniswap deployments/integration, light clients/trust model (Arbitrum/Nitro, Helios etc), Ledger support where documented. Need honest limitations and viable hackathon MVP. Browse primary docs only, no active network probes/install experiments. Return source-backed findings and specific unresolved gates. Do not modify repo.

Follow-up:

> Please send concise final source URLs and dates for verified facts/gates soon; root drafting plan now. Need Ledger SDK hardware custom chain uncertainty and official Uniswap direct execution vs APIs supported facts. Root writing docs only.

### Architecture reviewer

> Independently propose/review a bounded security architecture for planning only: local deterministic portfolio rebalancer with loopback pie UI; optional Claude Code/Codex proposes allocation edits, automated recurring trades require zero LLM; Ledger owner approval and constrained local session key for unattended trades; Robinhood Nitro chain with Uniswap. Identify critical correctness/privacy/custody boundaries, deterministic rounding and ambiguous 20->30% edit handling, transaction lifecycle tests, potential smart account policy bypass pitfalls. No browse needed unless making factual platform claims; no implementation or repo edits. Return concise decisions/invariants and achievable MVP scope to feed PLAN.md.

Follow-up document review:

> Please review newly created PLAN.md and README.md in shared workspace read-only for contradictions, critical omitted controls, and overclaims. User explicitly clarified cloud LLM use is acceptable for hackathon. Focus bounded docs review, no implementation/tests/edits. Send only material changes needed.

## Result and subsequent records

Research/design outputs are incorporated into `PLAN.md`, `docs/HACKATHON.md` and `docs/RESEARCH.md`, with unresolved claims explicitly separated from verified documentation. GitHub rules documentation informed the owner-only branch configuration. Later material prompts, implementation specs, reviews and plan changes should receive dated records here and corresponding disclosure entries.
