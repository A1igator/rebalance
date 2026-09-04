# ETHOnline 2026 compliance and submission

Verified against official sources on **September 4, 2026**. This is a working checklist, not organizer approval or evidence of participant registration. Recheck the event dashboard before submission for changes.

## Dates

The [official schedule](https://ethglobal.com/events/ethonline2026), displayed in America/Toronto, lists:

| Event | Toronto time (EDT) | UTC |
| --- | --- | --- |
| Hacking begins | Sep 4, 12:00 | Sep 4, 16:00 |
| First check-in | Sep 7, 23:59 | Sep 8, 03:59 |
| Second check-in | Sep 10, 23:59 | Sep 11, 03:59 |
| Project submission deadline | **Sep 13, 12:00** | **Sep 13, 16:00** |
| First judging | Sep 13, 15:00 | Sep 13, 19:00 |

The overall event runs September 4–16; September 16 is not the submission deadline. The provided `/home` URL may require login; the public event landing page exposes the schedule.

## Start from Scratch and provenance

The [Classic getting-started rules](https://ethglobal.com/events/ethonline2026/info/start) require the project to start during the event. Prior project-specific code, designs, and assets cannot be brought into this track; permitted public libraries/boilerplate must be distinguished from original work. Teams have 1–5 members; each participant must satisfy acceptance and staking requirements.

The [submission rules](https://ethglobal.com/events/ethonline2026/info/details) require committing specs, prompts and planning artifacts for spec-driven development, identifying AI-assisted portions, and keeping meaningful development history. There is no prescribed planning filename or initial commit message. A large final code dump or missing history can jeopardize eligibility. The [general rules](https://ethglobal.com/rules) also require reuse disclosure and license compliance.

Repository procedure:

- Start with the dated plan and prompt/provenance records before implementation.
- Commit coherent development milestones throughout the event; do not backdate, erase, or squash away the hackathon history.
- Add each material project-specific prompt/spec/plan and its affected files to the disclosure log.
- Record upstream source, version/commit, license, purpose, and modifications when adding a dependency or borrowed component.
- Never publish private keys, credentials or private participant data; keep sanitized provenance with an explicit redaction note if necessary.
- Record human product decisions, reviews, hardware tests and validation actually performed. An AI-generated plan does not establish human review of future implementation.

## Primary partner prizes

### Uniswap — Best Uniswap Stack Contribution, From Scratch

[Official prize](https://ethglobal.com/events/ethonline2026/prizes/uniswap-foundation): $3,000 pool, up to three $1,000 awards. Meaningful use of the Uniswap stack is in scope, including AMM v2/v3/v4, API, CCA or tooling. The published track does not mandate Unichain, v4, a hosted API or a particular SDK. The separate Continuity pool does not apply.

Deliver:

- [ ] Working, substantive Uniswap integration and reproducible demonstration.
- [x] Public repository with an open-source license for original work.
- [ ] README links to relevant contracts and exact code lines in the final submission commit.
- [ ] Complete [FEEDBACK.md](../FEEDBACK.md) with actual integration experience.
- [ ] Owner submits the [developer feedback form](https://developers.uniswap.org/hackathon-feedback) with the `FEEDBACK.md` link and records confirmation.

Fit: direct deterministic swaps can satisfy the integration direction without introducing a hosted routing dependency. Pool liquidity and contract verification remain implementation gates.

### Ledger — AI Agents x Ledger, From Scratch

[Official prize](https://ethglobal.com/events/ethonline2026/prizes/ledger): $3,500 split $2,000/$1,000/$500. Build a new product where device security has a central role. The [Ledger event portal](https://developers.ledger.com/ethonline) opens CLI, DMK skills and Key Ring tooling to both tracks. Its headless-secret and remote Key Ring examples specifically require Agent Stack/`wallet-cli ring`; the chosen human-approval DMK direction is a separate fit, not a claim that those examples are implemented.

Deliver:

- [ ] Actual Ledger-backed approval protecting the transition from agent proposal to spending authority.
- [ ] Runnable demo with explicit human approval and unattended-execution boundaries.
- [ ] [Ledger feedback](LEDGER_FEEDBACK.md) covering real SDK/docs experience, specific gaps and improvements; include evidence where useful.
- [ ] Hardware, app, SDK and chain compatibility evidence; accurate disclosure of display/context limitations.

The published requirements do not mandate a particular chain or ERC-7730 artifact. Clear Signing is a design objective to verify, not an achieved feature or a fabricated eligibility rule. The Continuity prize is excluded.

## Optional third partner

The event permits at most **three partner selections**, with multiple tracks from one partner counted once. Keep the third slot unused unless the core demo is complete.

[1inch — Build an Aqua App](https://ethglobal.com/events/ethonline2026/prizes/1inch) offers $5,000 split $2,500/$1,500/$1,000. It requires a substantive Aqua position using official contracts and demonstrated token transfers; local forks are allowed and SwapVM is preferred. A separate adapter could fit, but a quote-API integration alone cannot.

[Chainlink's confidential-compute track](https://ethglobal.com/events/ethonline2026/prizes/chainlink) requires meaningful CRE confidential TEE execution and evidence. Defer it because this changes the local execution model; ordinary feed consumption is not sufficient.

## Submission readiness

- [ ] Owner confirms Classic selection, participant acceptance/stake, team membership and required check-ins in the event dashboard. No account status was inspected during this planning session.
- [ ] Working project, public source, complete provenance, accurate description and reproducible setup.
- [ ] All material planning/spec files and sanitized project prompts committed; AI usage updated by file/component.
- [ ] 2–4 minute demo, at least 720p, human narration, normal playback speed; no AI voiceover or phone recording.
- [ ] Final README contains exact code/contract links, environment distinctions and integration evidence.
- [ ] Uniswap feedback file/form and Ledger tooling feedback complete.
- [ ] Select applicable From Scratch prizes, at most three partners, and submit before the deadline.
- [ ] Save the submission URL/confirmation and final commit SHA. Do not claim submission until confirmed.

Judging assesses technicality, originality, practicality, usability and wow factor. Partner judging is asynchronous. If selected as a finalist, prepare a four-minute presentation and three minutes of questions. See the [submission page](https://ethglobal.com/events/ethonline2026/info/details) for authoritative details.
