# Transaction recovery

An uncertain send blocks later trades. A missing transaction or receipt at one RPC does not prove that the transaction was never accepted. Preserve the original hash and nonce; the chart shows the last observed holdings while reconciliation waits.

## Automatic recovery in an armed runner

The [automatic-recovery decision](prompts/026-automatic-recovery.md) supersedes the earlier requirement to issue a recovery command for every stuck transaction. An armed raw-key runner now has a deterministic recovery stage after receipt reconciliation. It runs without an LLM, agent message, notification task, CLI subprocess or self-restart. The [startup correction](prompts/029-automatic-launch-recovery-and-gas-label.md) lets a full raw-key launch start this graph through unresolved/reverted pending state after successful read-only preflight. The transaction blocks another trade, not the runner needed to recover it. No separate recovery or stop/start message is required. Setup-only and read-only `check`, `status`, `events` and `recover` never enter that signing path. Ledger still needs physical signing; its adapter and Privy remain deferred, with no raw-key fallback.

The [event-driven timing update](EXECUTION_TIMING.md) schedules the recovery deadline directly and reduces the previous five-minute grace. A prepared, uncertain or broadcast original gets a **30-second receipt grace** from its saved creation time. A missing receipt or expired swap deadline does not establish that it failed. After the grace, the runner can prepare one zero-value self-cancellation at the original nonce, with the same chain/account/nonce/gas checks as explicit recovery. It saves both identities before sending. Every subsequent poll only reconciles an existing prepared, broadcast or unknown cancellation; it does not re-sign, reprice or resend it.

Either the original or the cancellation may win. Only a verified canonical receipt with two observed confirmations clears the barrier. A successful original continues ordinary sequential execution. A confirmed cancellation or original revert allows work to continue in the current active window; it does not force an hourly wait. The shared cadence record marks a canonical successful swap **before removing its pending state**. Cycles with at least one successful swap retain their saved hourly eligibility. A new cycle with no successful swap may retry after its original ten-minute window. Older records without the marker retain conservative timing. Receipt checks continue during cooldown. An unmined send costs no onchain gas; approvals, cancellations and mined reverts still do.

The automatic path owns no stop/resume lifecycle: it uses the runner's existing execution lock, takes the shared recovery lock without waiting, and respects stop/configuration changes before signing/sending. Manual recovery can take precedence without deadlocking against that runner. Inconsistent nonce evidence, invalid timestamps, insufficient gas, RPC failures and unknown cancellation outcomes retain the barrier and report attention. Automatic recovery is bounded; it cannot guarantee that every RPC failure or cancellation will resolve unattended.

New transaction records retain public gas parameters and a fixed send-failure classification when available. No provider error text, credentials, private key or signed transaction is retained in those diagnostics. A classification explains the observed failure; it never authorizes forgetting or blindly retrying the original.

`rebalance-recovered` reports a verified cancelled/reverted nonce separately from `rebalance-completed`. The latter still requires a successful swap and fresh holdings within the configured drift threshold. The chart stays view-only and indicates when automatic recovery is waiting.

Already running Node processes keep their loaded code. Installing this change does not update an older funded runner in place. A later permitted start loads the current implementation. A completed recovery journal is a no-op and does not reload code; recovery is not an update command. The launcher-only correction applies on subsequent launches and requires no restart of a runner that already has automatic recovery. The assistant does not restart funded trading or trigger its hook to apply the update.

## Inspection and explicit recovery

Ask the agent to assess recovery, or use the read-only contributor command:

```sh
npm run cli -- recover
```

It reads public RPC evidence without stopping, signing, changing transaction records or resuming a runner. `cancellation-needed` describes an available explicit recovery path, not a confirmed dropped transaction.

After reviewing that action, the user can submit **`$rebalance recover`** in the existing Codex conversation. The already user-reviewed project hook routes this exact command to `recover --cancel` without an LLM choosing tools. The canonical project skill link followed by ` recover`, and the exact browser framing supported for launch, also match. This is a separate operation from bare launch. Do not trigger the funded hook on the user's behalf or change trust settings. Claude retains the underlying CLI path where its executing agent is permitted; no Claude prompt hook is installed.

The contributor equivalent is:

```sh
npm run cli -- recover --cancel
```

This explicit operation may pay native ETH gas for **one zero-value self-transfer at the original transaction's nonce**. It does not repeat the original swap or spend a fresh transaction nonce. Only an uncertain original send in the selected raw-key account is eligible for a new cancellation; other signer modes do not fall back to software. The cancellation requires an account without executable code, usable RPC/nonce evidence, a gas estimate and sufficient native balance. Its fee uses twice the greatest of the current gas price, the original transaction's RPC gas price, and its saved gas price when available. This does not guarantee acceptance or mining.

The handler saves the original identity, whether the runner was active, and its own stop generation before cooperatively stopping it. Recovery holds the execution lock through signing and submission, and also protects the selected configuration. The original and cancellation hashes are persisted before sending. Repeated delivery of the same request cannot send or restart again. An existing prepared, broadcast or unknown cancellation is only reconciled; it is never signed or blindly resent again.

Either the original transaction or the cancellation can win the nonce race. Recovery validates the transaction's chain/account/nonce, its receipt and canonical block with two observed confirmations. A cancellation must be a successful empty-input, zero-value self-transfer. Nonce advancement alone never identifies a winner. Until a winner is verified, the pending barrier and both identities remain. Recovery history is retained in ignored local storage; no signed payload or private key is written into those records.

After verified resolution, the handler refreshes public holdings and conditionally resumes through the existing launcher. It resumes only a runner that was active before recovery, preserves cycle timing, and respects any newer stop request. An uncertain resume result remains unknown and is not retried automatically. A cancellation receipt is not a completed rebalance; only subsequent swaps and a fresh within-threshold portfolio can produce that event.

The command waits for a bounded period. If it returns `pending`, `confirming` or `unknown`, retain its records and inspect again. A new explicit recovery request can reconcile the saved identities but cannot repeat an uncertain send. The explicit command remains available for inspection-driven intervention; routine stale recovery now belongs to the armed runner. Neither path introduces a spending-budget system. Successful-swap cadence marking is shared by both receipt-resolution paths.

The September 5 implementation and isolated test evidence are recorded in [prompt 025](prompts/025-stalled-rebalance-recovery.md) and [AI usage](AI_USAGE.md). A user-started Apple swap succeeded before the next swap became unresolved. A subsequent user-issued recovery hook reported a confirmed cancellation and resumed the runner, which later recorded another uncertain swap. The portfolio was incomplete at that checkpoint. Subsequent user-issued recovery/relaunch led to a completed-rebalance event at 2026-09-05T23:33:58.399Z, independently checked against the final successful swap receipt at block 55516741 and fresh five-asset holdings. This live result is separate from isolated test evidence and does not prove phone delivery.
