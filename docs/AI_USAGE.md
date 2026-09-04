# AI assistance and reuse provenance

Maintain this document throughout development. Record actual assistance and review, not a generic declaration that conceals which parts were generated.

## Initial planning session — 2026-09-04

Tool: Codex assistant with three parallel research/design agents. Human inputs: the project request and the clarification accepting cloud LLM use, preserved in [the planning prompt record](prompts/001-planning-session.md).

The human specified the product, deterministic automation requirement, local pie chart, chain, Ledger/Uniswap prize targets, personal repository and direct-to-main workflow. The assistant researched official sources, synthesized the architecture and schedule, generated the files below, created the GitHub repository and configured its branch rules. No human hardware review, contract audit, integration test or event submission has occurred or is claimed.

| Files | AI contribution | Validation at this stage |
| --- | --- | --- |
| `README.md`, `PLAN.md` | Entire initial draft and architecture synthesis | Cross-checked against primary-source findings and independent design review |
| `docs/HACKATHON.md`, `docs/RESEARCH.md` | Rule/prize/technical research summaries and checklists | Official URLs recorded; unresolved runtime questions marked |
| `docs/AI_USAGE.md`, `docs/prompts/001-planning-session.md` | Disclosure, exact user requests and task-prompt record | Compared with planning-session messages |
| `FEEDBACK.md`, `docs/LEDGER_FEEDBACK.md` | Empty evidence templates | Explicitly marked pending; no invented developer feedback |
| `docs/REPOSITORY.md`, `.github/main.ruleset.json` | Governance description and requested GitHub configuration | Live GitHub response/readback recorded in repository governance |
| `AGENTS.md`, `CLAUDE.md`, `.gitignore` | Contributor instructions and local-data exclusions | Reviewed for project scope and history/provenance requirements |
| `LICENSE` | Standard MIT text for original work | Upstream dependencies retain separate licenses |

No project implementation code or generated product image was created in this session. Platform facts have been researched, not empirically proved. Do not represent this initial plan as a finished application.

## Interaction clarification — 2026-09-04

Human decision: the pie chart is view only and all application interaction goes through the agent. The exact request and independent review task are recorded in [the clarification prompt](prompts/002-agent-only-interaction.md).

Codex updated `README.md`, `PLAN.md`, `AGENTS.md`, `CLAUDE.md` and `docs/RESEARCH.md`; generated the new prompt record; and added this disclosure entry. One parallel design reviewer checked implications for agent controls, view-only permissions and the Ledger boundary. The revision removes the chart editor and manual action flows, adds typed agent lifecycle operations, and keeps deterministic execution and physical owner confirmation.

Validation: documentation consistency, Markdown links and Git whitespace review. No implementation, hardware test, transaction or new dependency was introduced. Earlier planning prompts and commits are preserved.

## Ledger availability update — 2026-09-04

Human decision: delay Ledger work until the device arrives in a couple of days. The exact request and review prompt are recorded in [the deferral prompt](prompts/003-ledger-deferral.md).

Codex revised `PLAN.md`, `README.md`, `AGENTS.md`, `docs/RESEARCH.md` and `docs/LEDGER_FEEDBACK.md`; added the prompt record and this disclosure. One parallel reviewer checked scheduling and dependency implications. The immediate milestone now covers deterministic proposals, agent controls, view-only display and simulation, with physical hardware work conditional on confirmed arrival.

Validation: documentation consistency, Markdown links and Git whitespace review. No implementation, SDK installation, hardware test, transaction, dependency or scheduled reminder was introduced. Hardware approval requirements remain in the final design.

## Raw-key support and Privy assessment — 2026-09-04

Human decisions: support a basic raw private key for a potential teammate without a Ledger; investigate whether the Privy prize fits. Exact requests and delegated prompts are recorded in [the signer/prize prompt](prompts/004-raw-key-and-privy.md).

Codex updated `README.md`, `PLAN.md`, `AGENTS.md`, `CLAUDE.md`, `docs/RESEARCH.md`, `docs/HACKATHON.md`, `docs/LEDGER_FEEDBACK.md`, the current deferral prompt and this disclosure; created `docs/PRIVY.md` and the new prompt record. One reviewer assessed signer/approval boundaries and one researcher verified official Privy prize/tooling sources. Raw-key mode is first-class and trusts the authenticated agent/local host; Ledger provides an independent physical approval step. After receiving the research, the human explicitly accepted Privy's TEE trust model. The assistant incorporated that clarification and planned Privy as the third partner with a distinct scoped owner/executor wallet flow. It is not implemented or submitted yet.

Validation: consistency and link/whitespace checks; source URLs retained in the assessment. No wallet, secret, SDK, transaction, hardware connection, deployment, external form submission or teammate access grant was created. Earlier committed prompts/history remain unchanged; the uncommitted deferral interpretation is explicitly superseded by the raw-key clarification.

## Development log template

For each material implementation session, append:

- Date, tool/model if known, and committed prompt/spec paths.
- Files/components/assets generated or substantially modified with AI assistance.
- Human decisions/review and tests actually performed.
- Dependencies or copied upstream code added, with license and attribution.
- Remaining issues and relevant commit references.

Do not record a guessed model version or fabricated review. Keep material project prompts/specs in Git; sanitize credentials/private data and describe redactions if any. System/runtime instructions are not project specifications.

## Existing work / dependency register

Initial state: the workspace had an initialized `main` branch with **zero commits and zero project files**. No earlier project implementation, design assets, or code were imported. Research links identify existing external platforms, not work authored by this project.

No application dependencies have been installed or vendored yet. The proposed libraries/protocols in the plan are candidates, not completed integrations. Before adding one, record:

| Dependency/component | Upstream URL | Version/commit | License | How used / modifications |
| --- | --- | --- | --- | --- |
| None yet | — | — | — | Documentation-only starting point |

The MIT license covers original project files; it does not override licenses on Uniswap, Ledger, fonts, libraries, boilerplate or other third-party materials.
