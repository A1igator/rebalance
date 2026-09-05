# Skill-only initialization — 2026-09-05

Exact human requests following the mainnet/cadence implementation:

> You should be able to initiate it. Remember it was supposed to be runnable via a skill

> But I want it to initialize with just the skill too

The assistant explained that the existing skill can invoke the runner, but it cannot itself initiate real-money stock-token trading through tools. The latest request also establishes a concrete setup UX: invoking the project skill should initialize the app rather than hand the user a list of terminal setup commands. Initialization and trading activation must be reported distinctly.

The implementation uses the existing CLI rather than adding an initialization framework or new control service. A bare `$rebalance` or `/rebalance` installs missing locked dependencies, reads public status, preserves existing wallet/configuration, creates/reuses a raw-key wallet only when appropriate for fresh setup, obtains missing weights in the same conversation, refreshes public state, reuses/starts and opens the view-only chart, and reuses previously requested notification setup. It never resets pending transactions/cycle timing, duplicates a runner or notification schedule, or arms trading implicitly. Specific operations such as status, notifications or stop do not trigger setup.

Root applies the installed skill-creator guidance to the existing project skill and updates `README.md`, `PLAN.md`, contributor instructions and AI provenance. A separate architecture reviewer checks startup/reuse behavior against the actual CLI and chart server, without making live changes. Review identifies the need for GET status verification, preserving paused notifications and treating malformed state as recovery rather than a fresh install. Validation exercises the actual already-configured setup using public metadata, a read-only check and existing chart/notification state. No stock trade, key rotation, funding transfer or phone delivery is implied by initialization.

Actual outcome: the mainnet read-only check passed at block 54,909,009 with the original wallet/allocation, no error and trading unarmed. The existing chart process and GET status were healthy and matched the selected wallet/network/weights; the existing Codex notification heartbeat remained active and was not duplicated. Computer Use could not inspect or reopen the chart tab because the Mac was locked. This is reported as a display limitation, not a failed chart service or a need to recreate setup.
