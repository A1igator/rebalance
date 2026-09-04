# Project instructions

This is an ETHOnline 2026 **Start from Scratch** project. Read `PLAN.md`, `docs/HACKATHON.md` and `docs/AI_USAGE.md` before implementation. Current state is planning only; the latest plan supersedes earlier vault/session-key and all-modes-confirmed designs.

- Preserve incremental history; do not backdate, squash away or rewrite hackathon commits. Commit material project prompts, specs, plans, AI disclosures and upstream provenance.
- The owner uses `main` directly. Follow that preference and push only when authorized by the task/session.
- All application commands/reviews go through the agent. The chart is view only, with no signing or mutation capability.
- MVP local-key/Privy profiles execute swaps and required finite approvals automatically under versioned policy, without per-trade human input or LLM calls. Ledger profiles wait for physical confirmation. No custom vault or session-key contract is needed.
- Support explicit local raw-key, Ledger and Privy signer profiles. Agent-mediated configuration/policy changes control automation. Never silently switch signer/account or enable automation merely because credentials exist. Direct-owner software limits are not onchain guarantees; document verified Privy enforcement separately.
- Cloud LLM assistance and Privy's TEE signing are accepted. Keep keys/API secrets out of model context, source, command arguments and logs. Each contributor uses independent wallets/local secrets.
- Robinhood remains viable; the user also permits other L2s. Base/Base Sepolia is a candidate with documented stock and Uniswap deployments. Select the network from verified integration evidence; preserve asset/liquidity/light-client gates.
- Prioritize Ledger Agent Stack reuse. Read `docs/LEDGER_AGENT_STACK.md`, use official Ledger skills during implementation and pin component versions/source/licenses. Shared EVM config includes Robinhood/Base; the CLI quote allowlist does not establish all CLI chain support. Verify the packaged flow, enforce policy bounds despite requoting, and inspect telemetry. CLI hardware signing is separate from raw-key/Privy adapters.
- Physical Ledger enrollment/signing tests wait for device arrival. Software work, route validation and raw-key network integration can proceed. Do not claim hardware evidence from mocks/software signatures.
- Key Ring is encryption infrastructure; a scoped broker is our work. Keep plaintext out of agent-visible output and document its network/isolation assumptions. Do not claim hardware confirmation on every Ring decrypt.
- Use integer financial arithmetic, reviewed chain/address manifests, finite allowances, persistent spending limits, one economic intent per wallet/chain and conservative stale/invalid-state handling. Ledger review must bind the actual transaction. Read `docs/NETWORK.md` for B20 pricing/native-precompile specifics.
- Keep application calculation/storage/UI local and telemetry-free. Disclose selected Privy, Ledger/Ring, quote or RPC services accurately. Do not call RPC access or matching responses a proof.
- Test meaningful planning, automatic versus device-confirmed dispatch, signer, duplicate-request and transaction-recovery behavior. Record actual environments/results; never invent deployments, device tests or sponsor feedback.
- Attribute public dependencies and copied upstream work. Do not import pre-event project-specific code/assets into Classic. Update setup and judge evidence once implementation exists.

User instructions supersede project preferences. Flag any conflict with published competition requirements factually before work that would undermine eligibility.
