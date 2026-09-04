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
