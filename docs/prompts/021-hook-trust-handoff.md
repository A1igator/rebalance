# Hook trust diagnosis and user handoff — 2026-09-05

## Human request

> so how do we get it the launch to run on skill invocation? can you do all the work and give me the simplest step I need to do that you can't

This follows a bare `$rebalance` invocation that loaded the skill but supplied no hook result. A real setup-only check succeeded; the funded runner remained unarmed.

## Plan

1. Verify the documented hook lifecycle and inspect installed CLI capabilities and project hook discovery without executing a hook or changing trust.
2. Correct safely handled hook failures so the native host receives a structured public result. Add isolated tests for the process exit/output contract; preserve unknown state after a potentially dispatched launch.
3. Document the actual blocker and prepare native hook review for the user. Do not trust/enable the live-trading hook, submit the bare launch command, start the funded runner, or inspect secrets.
4. Preserve the single-invocation product semantics, existing wallet/allocation/cadence and notifications. Commit the fix, evidence and AI disclosure on main.

## Diagnosis

Official sources: [Hooks](https://learn.chatgpt.com/docs/hooks) and the documented read-only [`hooks/list` method](https://learn.chatgpt.com/docs/app-server). Generated protocol types came from the installed CLI in a temporary directory; no upstream code or dependency was adopted.

Installed CLI `0.148.0` reports `hooks` enabled. Its `hooks/list` response for this repository discovers `.codex/hooks.json`, with event `userPromptSubmit`, `enabled=true`, `isManaged=false`, `trustStatus=untrusted`, and no load warnings/errors. Project trust is already set. This identifies missing individual hook trust, not missing application wiring. The query used a separate short-lived stdio process, with initialization and `hooks/list` only: no thread, turn, hook execution or trust mutation.

Native app inspection was denied by the computer-use tool. No alternate UI-control route was used. The supported CLI discovery query establishes the configuration/trust result, not Desktop skill-picker serialization or live dispatch.

## Material delegation

A read-only reviewer inspected the prompt hook, launcher and tests for a source-side reason that bare skill invocation could lack a hook result. It confirmed exact literal routing and identified a reporting gap: the top-level catch writes public JSON but exits with a hook-process error. Follow-up work is limited to safe error reporting and isolated fixtures; the real hook, funded state and trust settings remain untouched.

Validation and the final handoff are recorded in `docs/AI_USAGE.md` and `docs/LAUNCH.md` after completion.
