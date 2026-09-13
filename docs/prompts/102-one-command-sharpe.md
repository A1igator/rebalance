# One-command historical Sharpe optimization

Date: September 13, 2026.

The owner asked whether a Sharpe request could be easier for a lightweight agent after another conversation required them to supply a historical CSV. Codex found the existing optimizer and a prior one-off Yahoo/Kraken history workflow, but no reusable history builder. The owner approved implementing a deterministic command that handles history, calculation and requested adoption while asking only for missing assumptions.

## Scope and intended behavior

Add `allocation optimize sharpe`, with `--preview` for read-only calculation and `--preset stock-usdg-1y` to explicitly fetch the established historical test methodology. With no preset, reuse only the selected wallet's valid saved Sharpe policy and frozen history. If those are absent, return one concise input question describing the preset; do not ask the user to construct return rows. Never borrow another wallet's assumptions or treat an earlier preview as approval.

The explicit preset uses about one year of completed daily adjusted underlying-stock closes and actual USDG/USD market prices, a zero-return benchmark, and a one-percentage-point search grid. All five weights can vary unless existing allocation bounds or subjective constraints must be retained. Preserve and disclose those constraints. Underlying-share and exchange-price data are labelled proxies, with differing close times, not Robinhood token prices or forecasts.

Fetch from fixed public sources with bounded requests and validation. Exclude unfinished candles, align dates before calculating returns, and never fabricate missing prices or zero-fill USDG. Retain source, date and history identity in saved policy/provenance. Provider failure leaves targets unchanged. No provider credential, scheduled optimizer or new dependency is required.

Fetch and calculate outside the configuration lock. Adoption verifies that the originally selected configuration is still current before one atomic policy/target/request commit. A changed wallet/configuration requires a fresh invocation. Preview never saves a policy. Successful adoption follows prompt 101's explicit-request cadence, but never starts/stops a runner or invokes signing directly. Existing manual JSON and user-risk operations remain available.

## Material task split and verification

One collaborator implements provider fetch/parsing/alignment and isolated tests. A second implements orchestration, CLI routing, preserved constraints, configuration-race handling and isolated tests. The coordinator owns skill/product guidance, public-data preview in disposable storage, integration review and sanitized provenance. Tests must use the project isolation launcher. No live wallet allocation or funded execution is part of building the feature.

The team-shelf search returned NETWORK_ERROR. Publishing remains paused. Actual test and smoke results will be recorded after validation; no successful provider response or financial outcome is inferred in advance.

Validation update: the final isolated allocation/history/routing run passed 126/126. Review closed option-order selection bypass and sparse daily-history acceptance gaps before release. Typecheck, skill validation and whitespace checks passed. A real public-data CLI preview produced 249 aligned returns in disposable storage with its configuration byte-for-byte unchanged and no runner/transaction files. See [AI usage](../AI_USAGE.md) for the dated methodology and limits; no live portfolio was optimized by this implementation task.
