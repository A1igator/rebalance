# OpenCode harness integration

Date: 2026-09-11

## Human request

After discussing portability beyond Codex and Claude Code, the owner requested: “let's do opencode then”. Preserve the same deterministic application and the existing signer behavior, portfolio isolation, quiet automatic recovery and persistent companion approach.

## Plan before implementation

Use the installed OpenCode 1.18.30 native plugin/command interfaces, checked against official tagged source. A project plugin should route a direct bare `/rebalance` invocation with stable native session/message identity to the existing launcher before the model decides on tools. Reject ambiguous identity, plan mode and model/subagent-generated launch requests; preserve duplicate-request routing and newer stop decisions. Scoped skill requests remain scoped.

Provide a namespaced OpenCode conversation identity to each command, preserving existing Codex/Claude routing and per-wallet backend state. The browser selector must attach to that same conversation, with wallet setup handled by the existing deterministic UI/CLI paths. Reuse the existing cmux companion helper when a native cmux workspace is available; otherwise return the local view URL honestly.

Add a plugin-owned, file-driven notification bridge to the known OpenCode session. Reuse the existing actionable-event filter; keep automatic read/quote retries and successful recovery local. Preserve event IDs, originating wallet, retained unacknowledged records and uncertain delivery semantics. No periodic model polling, automatic signing or approval relay. Keep notifications separate from the runner lifetime and permission settings.

Extend the canonical skill and project documentation, with focused adapter tests and full isolated regression validation. Verify the native OpenCode plugin/command wiring against disposable fixtures if the installed harness permits it without model credentials or touching real wallets. Native fixture dispatch is not evidence of a real funded launch, Ledger signature or phone delivery. Do not launch the user's trading runner, alter existing wallet settings, inspect secrets or change global harness approval/trust settings while implementing. Commit and push to main under the standing authorization.

## Sources and provenance

- Installed `opencode --version`: 1.18.30.
- Official skills, commands, plugins and SDK docs at https://opencode.ai/docs/.
- Official tagged implementation: https://github.com/anomalyco/opencode/tree/v1.18.30.
- Existing Rebalance launch, profile-routing, companion-view and notification-filter modules.
- Required Tenjin search returned NETWORK_ERROR and no finding. No external code/dependency is adopted without documenting its exact version and license.
