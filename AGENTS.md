# Project instructions

This is an ETHOnline 2026 **Start from Scratch** project. Read `PLAN.md`, `docs/HACKATHON.md` and `docs/AI_USAGE.md` before implementation. The latest MVP removes spending limits and generic infrastructure while retaining Ledger/Privy features for their prize demos.

- Preserve meaningful hackathon history and commit material prompts, specs, plans, AI disclosures and dependency provenance. Do not backdate or squash away the work.
- The owner uses `main` directly. Follow that preference and the session's commit/push authorization.
- All application commands go through the agent. The local chart is view only.
- Raw-key and Privy profiles execute automatically with no per-trade human input or LLM calls. Ledger tracks drift from its saved public address while disconnected, refreshes on connection and prompts through the agent if still needed. Signing requires physical confirmation; connection alone never authorizes it. Defer hardware tests until arrival.
- Keep the shared app small: one TypeScript project, one active profile/chain, ordinary local config, a basic CLI and a pending-transaction record. No spending caps, budget accounting, generic policy/permission engine or bespoke authentication framework.
- Retain Ledger Key Ring with a focused credential-broker demo and Privy-native scoped authorization where useful for prizes. Use service/contract/method restrictions rather than monetary caps. Verify actual allowed/denied behavior and isolation claims; do not generalize these integrations into a security platform.
- No session keys, delegation modules or session feasibility work. Prioritize current Ledger Agent Stack compatibility and direct signing. Refresh balances/quotes on reconnect, reconcile earlier sends, distinguish hardware detection from app/account readiness and avoid repeated prompts. Retain notifications while the agent is unavailable.
- Retain correct swap mechanics: integer amounts, valid target weights, correct network/assets/recipient, usable prices/routes, normal slippage/expiry, sufficient balance/gas and receipt tracking before another trade. Do not silently switch signers/accounts or duplicate unresolved transactions.
- Cloud LLM assistance and Privy's TEE are accepted. Keep secrets outside chat, source control and logs using local/provider setup or the focused Ring integration.
- Maximize applicable Ledger Agent Stack reuse and pin adopted versions/licenses. Read `docs/LEDGER_AGENT_STACK.md`; shared EVM config includes Robinhood/Base, and the CLI quote guard is not a blanket chain restriction.
- Robinhood remains viable; other L2s are allowed. Read `docs/NETWORK.md`, choose one working integration and preserve truthful asset/liquidity/verification claims. Begin with an actual testnet swap; simulation is a test tool.
- Keep application storage/calculation/chart local, bundle UI assets and avoid application telemetry. Disclose external RPC, Ledger or Privy dependencies accurately.
- Test the core arithmetic, automatic/device-confirmed execution and basic recovery. Record actual results; no invented hardware, network or sponsor evidence.

User instructions supersede project preferences. Published competition requirements still apply; distinguish them from optional product scope.
