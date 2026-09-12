# Explain Ledger retry failures in the chart

Date: 2026-09-12. Recorded before implementation.

The owner reports that Retry appears ineffective despite an open Ledger. Public request records show three explicit user clicks accepted and consumed within 27–76 ms, then failing during the first account check. No new transaction was recorded. A bounded read-only USB address probe reproduced an error at that stage; existing diagnostics omit its specific SDK tag, and the chart falls back to generic attention text.

Preserve retry dispatch, physical confirmation, account binding, receipt/cadence barriers and blind-signing refusal. Add only verified, fixed SDK error classifications and concise chart states for account/device readiness versus unsupported signing, retaining actionable information after passive refresh. Do not infer readiness from USB presence or expose arbitrary SDK messages, credentials or payloads. No new live retry or transaction is part of UI validation. Any hardware-only setting remains with the user.

Validate with isolated signer/display tests through npm test, typecheck, whitespace checks and read-only browser inspection. Preserve unrelated stock-link edits. Reload only the owned chart for UI code, without changing the existing monitor or portfolio state; document any runtime-code reload still required. Commit and push to main under the standing instruction. The required Tenjin search returned NETWORK_ERROR; the supplied Vercel AI SDK reset-step finding is unrelated to this plain-JavaScript companion.
