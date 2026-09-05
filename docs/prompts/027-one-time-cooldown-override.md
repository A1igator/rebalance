# One-time cooldown override — 2026-09-05

## Human request

> can you run a manual recovery rn to test so we don't have to wait

The assistant inspected recovery using public RPC. It reported the previous cancellation resolved and the existing runner armed. Recovery preserves the saved cycle deadline, so another recovery would not shorten that wait. The human then explicitly requested the timing override:

> yeah can you overwrite it for now

This authorizes changing this one expired legacy cycle's eligibility. It does not change the default interval for future cycles or authorize forgetting a pending transaction. The runner was already armed by the user's native command and has loaded automatic recovery.

## Operation plan

1. Inspect public state and the exact legacy cycle, whose active window has expired and eligibility is still in the future. Confirm no pending transaction and the expected resolved cancellation record.
2. Under the existing recovery and configuration locks, verify the same wallet/network, live runner identity, absence of a stop, and exact cycle/receipt-record identities again. Retain the original cycle and requested replacement in a unique ignored local audit file.
3. Atomically replace only this cycle's `nextEligibleAt` with the current time. Do not set successful-swap evidence, reset the active window, modify allocations/default timing, erase records, invoke a hook or start/stop/restart the runner. The already armed process may begin a fresh cycle on its next ordinary poll.
4. Release locks promptly and inspect public status. A fresh cycle after the edit is expected; never restore the old cycle over it. Record the actual outcome separately from any later swap receipt.

A read-only reviewer checked the current cadence writers and lock interaction. The expired window and future original deadline leave no eligible cycle writer before the atomic replacement; pending absence and resolved recovery exclude receipt-driven success marking. This is a one-time user-requested state operation, not a reusable cadence bypass feature.

## Actual result

At **22:29:12.959 UTC**, the assistant applied the requested local timing edit after all identity/state checks passed. The original eligibility had been **22:44:20.689 UTC**. A unique ignored `cycle-overrides` audit record preserves both versions. The saved future interval remains 3,600 seconds; the original cycle's other fields and recovery records were not modified.

Public status then showed the existing process starting a fresh cycle at **22:29:18.855 UTC**, with a ten-minute active window and a pending approval for its AMD purchase proposal. This confirms the old cooldown was bypassed once and the already armed process proceeded. A pending approval is not a swap receipt or full rebalance. The assistant did not call a signer, invoke a hook, restart a process or inspect a private key. The timing change intentionally permitted the existing runner to execute sooner under the saved allocation.

Validation was the guarded operation, retained before/after audit, fresh public runner status, independent read-only review and documentation whitespace/link checks. No application source or dependency changed, and the prior 194-test result was not rerun or presented as new live evidence.
