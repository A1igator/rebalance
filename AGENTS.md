# Project instructions

This is an ETHOnline 2026 **Start from Scratch** project. Read `PLAN.md`, `docs/HACKATHON.md` and `docs/AI_USAGE.md` before implementation. Current state is planning only.

- Preserve incremental history. Do not backdate, squash away or rewrite hackathon development commits. Commit material specs, project prompts, plans and AI/reuse disclosures with the work they support.
- The owner uses `main` directly. Follow that explicit preference; do not require a PR for owner work. Do not push work unless authorized by the current task or existing session.
- Maximize deterministic code. Models may propose policy changes; they must not enter the scheduler, sign, activate policies or make trade-time decisions.
- Cloud LLM proposal assistance is accepted for the hackathon. Keep signing authority, secrets and unrelated portfolio data out of model access.
- Keep the app local. Do not introduce telemetry, a hosted backend, remote UI assets or a mandatory cloud execution service.
- Do not call ordinary RPC trustless. State verified capabilities, issuer/rollup/oracle assumptions, public-chain visibility and hardware limitations accurately.
- Keep runtime data/keys outside the source checkout and Git. Do not put credentials, real portfolio data or unredacted private prompts in docs or fixtures.
- Use integer financial arithmetic, reviewed chain/address manifests, fail-closed checks and narrow onchain session constraints as specified in the plan.
- Test meaningful arithmetic, authorization and transaction recovery behavior. Record environments and actual outcomes; never invent device tests, deployments or feedback.
- Use standard upstream dependencies only with provenance/license records. Do not import pre-event project-specific code/assets into Classic.
- Update README run instructions and judge evidence links when implementation exists. Complete sponsor feedback from real integration experience.

Plan changes should be dated and explained. User instructions take precedence over these project preferences; flag conflicts with published competition requirements factually before proceeding with work that would undermine eligibility.
