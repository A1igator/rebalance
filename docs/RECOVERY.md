# Explicit transaction recovery

An uncertain send blocks later trades. A missing transaction or receipt at one RPC does not prove that the transaction was never accepted. Preserve the original hash and nonce; the chart shows the last observed holdings while reconciliation waits.

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

This explicit operation may pay native ETH gas for **one zero-value self-transfer at the original transaction's nonce**. It does not repeat the original swap or spend a fresh transaction nonce. Only an uncertain original send in the selected raw-key account is eligible for a new cancellation; other signer modes do not fall back to software. The cancellation requires an account without executable code, usable RPC/nonce evidence, a gas estimate and sufficient native balance. Its fee uses twice the greater of the current gas price and the original transaction's gas price when the RPC exposes it. This does not guarantee acceptance or mining.

The handler saves the original identity, whether the runner was active, and its own stop generation before cooperatively stopping it. Recovery holds the execution lock through signing and submission, and also protects the selected configuration. The original and cancellation hashes are persisted before sending. Repeated delivery of the same request cannot send or restart again. An existing prepared, broadcast or unknown cancellation is only reconciled; it is never signed or blindly resent again.

Either the original transaction or the cancellation can win the nonce race. Recovery validates the transaction's chain/account/nonce, its receipt and canonical block with two observed confirmations. A cancellation must be a successful empty-input, zero-value self-transfer. Nonce advancement alone never identifies a winner. Until a winner is verified, the pending barrier and both identities remain. Recovery history is retained in ignored local storage; no signed payload or private key is written into those records.

After verified resolution, the handler refreshes public holdings and conditionally resumes through the existing launcher. It resumes only a runner that was active before recovery, preserves cycle timing, and respects any newer stop request. An uncertain resume result remains unknown and is not retried automatically. A cancellation receipt is not a completed rebalance; only subsequent swaps and a fresh within-threshold portfolio can produce that event.

The command waits for a bounded period. If it returns `pending`, `confirming` or `unknown`, retain its records and inspect again. A new explicit recovery request can reconcile the saved identities but cannot repeat an uncertain send. No background automatic replacement policy or spending-budget system is introduced.

The September 5 implementation and isolated test evidence are recorded in [prompt 025](prompts/025-stalled-rebalance-recovery.md) and [AI usage](AI_USAGE.md). A user-started Apple swap succeeded before the next swap became unresolved; the full five-asset rebalance remains incomplete. Preparing and testing this handler is not a mainnet cancellation, resumed-trading or phone-delivery claim.
