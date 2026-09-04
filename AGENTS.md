# Project instructions

This is an ETHOnline 2026 **Start from Scratch** project. Read `PLAN.md`, `docs/HACKATHON.md` and `docs/AI_USAGE.md` before implementation. Current state is planning only.

- Preserve incremental history. Do not backdate, squash away or rewrite hackathon development commits. Commit material specs, project prompts, plans and AI/reuse disclosures with the work they support.
- The owner uses `main` directly. Follow that explicit preference; do not require a PR for owner work. Do not push work unless authorized by the current task or existing session.
- All application commands and reviews go through the agent. The local pie chart is view only: no editors, action buttons, wallet connection, signing access or mutation credentials.
- Maximize deterministic code. Models translate explicit user requests into typed operations, including owner-authorization workflows and pause/resume. They do not receive keys, enter the scheduler or make trade-time decisions. Ledger requires physical confirmation; raw-key mode trusts the authenticated agent channel to convey exact user confirmation and does not provide independent proof of human presence.
- Support explicit `private-key`, `ledger` and `privy` profiles behind shared deterministic interfaces. Keep owner and executor authority distinct; never fall back between signers automatically. Each contributor uses independent accounts/vaults and local secrets.
- Cloud LLM assistance is accepted for the hackathon. Keep private keys and unrelated portfolio data out of model access. The agent passes a local secret reference, never raw key material through chat or command arguments.
- Physical Ledger integration is deferred until the owner confirms the device has arrived. Progress the deterministic core, real local-key backend, agent controls, view-only chart and simulation first. Keep test doubles isolated from real policy activation and broadcasting; do not claim hardware validation from software signatures or simulations.
- Privy's hosted TEE signing is explicitly accepted by the owner. It is the planned third prize target and an optional profile mode; implement substantive wallet/swap use with scoped executor authority. Preserve local raw-key/Ledger operation without a Privy dependency and state the selected signer mode accurately.
- Keep the app local. Do not introduce telemetry, a hosted backend, remote UI assets or a mandatory cloud execution service.
- Do not call ordinary RPC trustless. State verified capabilities, issuer/rollup/oracle assumptions, public-chain visibility and hardware limitations accurately.
- Keep runtime data/keys outside the source checkout and Git. Do not put credentials, real portfolio data or unredacted private prompts in docs or fixtures.
- Use integer financial arithmetic, reviewed chain/address manifests, fail-closed checks and narrow onchain session constraints as specified in the plan.
- Test meaningful arithmetic, authorization and transaction recovery behavior. Record environments and actual outcomes; never invent device tests, deployments or feedback.
- Use standard upstream dependencies only with provenance/license records. Do not import pre-event project-specific code/assets into Classic.
- Update README run instructions and judge evidence links when implementation exists. Complete sponsor feedback from real integration experience.

Plan changes should be dated and explained. User instructions take precedence over these project preferences; flag conflicts with published competition requirements factually before proceeding with work that would undermine eligibility.
