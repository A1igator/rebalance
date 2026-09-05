# Automatic launch recovery and chart gas label

Date: **2026-09-05**. Existing ETHOnline Start from Scratch work; earlier prompts and commits remain history.

## Material user requests

> also again it should not require user input for any of these things

> also can you show eth as gas in the bottom of the pie chart on the side

Context: the assistant gave an incorrect recovery-as-reload instruction, then a stop/launch sequence. A fresh unresolved swap blocked that launch. The user's separate recovery invocation confirmed a same-nonce cancellation while preserving their stop, and the subsequent bare skill invocation armed the updated runner. These extra commands exposed a launcher gate inconsistent with the requested automatic recovery. The successful launch did not establish completion of the portfolio.

## Implementation plan

- A full raw-key launch with a successful read-only check may start the existing deterministic runner even when the prior transaction is unresolved/reverted. Let its existing reconcile/recovery stages resolve the transaction before another trade; do not call the manual cancellation wrapper from launch.
- Preserve pending/recovery/cycle records, one-runner locking, invocation deduplication, configuration checks, unknown-start reporting and newer stops. Setup-only never arms or cancels. Deferred signing profiles do not fall back to raw keys.
- Remove routine manual-recovery instructions from the skill and clarify startup versus process-update behavior. A completed recovery journal does not reload a runner. This change does not hot-reload or restart the existing funded process.
- Add a small ETH gas balance at the lower side of the view-only chart. Use public native-balance data; ETH remains outside portfolio slices, weights and valuation. Do not fabricate an unknown balance.
- Validate recovery startup with isolated launcher fixtures and existing recovery tests; inspect the display in the existing chart. Do not invoke the funded hook or change hook trust, native settings, wallet, targets or cadence.

## Delegated work

- Read-only startup reviewer: inspect launcher/runtime/recovery barriers and recommend the minimal fix and regression cases; no funded execution or secret access.
- UI implementer: add the noninteractive ETH gas label in UI files, preserve SSE/holdings semantics, and validate display formatting; no runtime restart or funded operation.

## Evidence

Implementation, validation and limitations are recorded in [AI usage](../AI_USAGE.md). No dependency or external application source is planned.
