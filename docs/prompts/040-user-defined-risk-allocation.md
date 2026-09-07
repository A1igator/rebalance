# User-defined risk allocation — 2026-09-07

## Human request

> can we also add sharpe ratio based portfolio managment for best risk adjusted portfolio where the risk is inputted by the user via AI (I don't like volatility as the only risk metric even though it can be an option)

Clarification:

> user selected risk is the main thing. ETH for example I don't think is risky over the long term even if it has all of those. the rest are optional

## Plan committed before implementation

Add an optional per-wallet allocation policy whose primary risk input is the user's explicit, horizon-dependent assessment of each configured asset. The agent translates the user's preferences into validated data; it must not replace these judgments with volatility, drawdown, presets or invented risk/return assumptions. ETH is an example and remains gas-only in the current portfolio universe.

Provide deterministic allocation preview and saved policy operations through the existing CLI and agent skill. A user-risk return/risk objective must be labelled separately from standard Sharpe. Require explicit return assumptions and benchmark for the same horizon; zero denominators must not yield misleading infinite scores. Support standard Sharpe as an explicitly selected statistical alternative using validated aligned returns with provenance, and optional descriptive diagnostics. No historical data currently exists in the app: spot DEX quotes cannot be passed off as a return series.

Use a bounded, reproducible solver with declared allocation resolution, stable ordering/tie-breaking, exact weight conservation and constraint checks. Scope policy and calculation records to each wallet. Save adopted targets with the policy atomically so the existing deterministic rebalance graph and target ring consume a consistent allocation; no LLM participates in the background. Fixed policy inputs need recalculation only when inputs change, not a periodic model task. Explicit manual target edits disable managed allocation in the same write. Preserve unrelated settings, cadence and pending transactions.

Implement and test with disposable policies and synthetic return panels. Include policy validation, subjective-risk primacy, reproducibility, optional-metric behavior, missing/invalid inputs, zero-risk handling, infeasibility, wallet isolation and manual-target precedence. Do not invent or enable a policy for an active wallet, alter live targets, sign, trade, restart funded processes or inspect secrets. Update the skill, design and AI-use provenance; publish aggregate checks only. Existing push authorization applies.

## Delegation

Root integrates configuration, CLI and documentation. Independent agents implement/review pure optimization and optional statistics, with isolated tests. No dependency or live data provider is required for this first implementation.
