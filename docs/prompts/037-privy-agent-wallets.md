# Privy Agent Wallets integration plan — 2026-09-06

## Human request

> for privy, we should use https://agents.privy.io and https://agents.privy.io/skill.md

Existing decisions remain: Robinhood mainnet 4663 only; deterministic recurring rebalances without model calls; raw-key and Privy automatic; no session-key delegation, monetary caps or budget accounting; use the selected signer without fallback.

## Planned work before implementation

1. Read the official Privy skill and inspect the pinned agent-wallet CLI package/documented transaction format. Use the official device-code login on this local machine; browser approval remains the user's one-time action. Keep credentials in Privy's credential manager, outside the repository and model output.
2. Integrate the CLI's signing-only Ethereum operation into the deterministic transaction boundary, with explicit Robinhood chain, sender, nonce, gas, destination, amount and calldata. Validate the returned signature/transaction before using the existing persisted-hash/broadcast/receipt path. Never use the CLI's transaction-sending or paid-fetch commands in the adapter.
3. Provide agent-facing onboarding and public-wallet inspection commands. Preserve the active raw-key configuration and runner during development. Do not silently select a newly provisioned wallet or move funds.
4. Exercise the adapter and failure/restart boundaries using isolated fixture accounts and mocked CLI/RPC. Verify package evidence before enabling any unsupported provider capability. Record actual Robinhood/provider compatibility separately from local tests; no live trade is promised by login or signature support.
5. Update the plan, Rebalance skill and Privy guide with the supported flow, dependency provenance, one-time browser step and remaining demo evidence. Do not claim Privy native policies or sponsor eligibility from the CLI alone.

## Delegated review

A parallel reviewer inspects official CLI/package and primary documentation for exact signing request/response shapes, arbitrary-EVM support, session lifecycle and noninteractive operation. The root handles onboarding and implementation. Review is read-only; no signing, transactions or credential inspection.

## Validation planned

TypeScript check; focused fixture tests for signing request correctness, response validation, account/chain mismatch, authentication failure, stop/deadline rechecks and no duplicate broadcast; relevant existing transaction/recovery/launch regression tests. Public docs/whitespace review. No production key access, funded runner lifecycle change or financial transaction as part of implementation.
