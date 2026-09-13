# Portfolio allocation

A wallet can keep manual target percentages or derive them from an explicit allocation policy. The agent captures the user's beliefs and intent; local code calculates and saves targets. The existing deterministic runner maintains those targets without an agent connection. The chart remains view-only, including its target ring.

## One-command Sharpe workflow

When the user explicitly asks to maximize Sharpe, the agent runs:

```sh
npm run cli -- allocation optimize sharpe
```

This command requires an actual conversation attachment, an explicit `--profile <public-address>`, or a pinned wallet worker. It never guesses the only saved wallet or copies another wallet's policy. If no portfolio is selected, it returns `needs-selection`; open `view` and invite selection. If this wallet already has a Sharpe policy, it recalculates using that wallet's **saved frozen history and constraints**, with no network fetch. The response identifies that basis and its as-of date.

Without a saved Sharpe policy it returns `needs-input` and one bundled question about the built-in test preset: one year of daily adjusted underlying stock prices plus actual USDG/USD prices, a zero-return benchmark, a 1% allocation grid, and existing bounds/risk limits retained. Without saved policy constraints, all five assets, including USDG, can range from 0% to 100%. Manual target percentages do not imply fixed weights or minimum allocations. Once the user accepts those assumptions—or has already explicitly authorized them—the agent runs:

```sh
npm run cli -- allocation optimize sharpe --preset stock-usdg-1y
```

An explicit preset fetches a fresh sample from public providers. The first-use response includes `presetRequiresNetwork: true`. When the host declares restricted network access, use its approved network permission mechanism on the **initial preset invocation** (Codex: `require_escalated`), after the preset assumptions are authorized. Pin the full wallet address returned by the selected-wallet command with `--profile`; preserve preview/application intent. Do not first run an expected-to-fail restricted fetch or repeat the assumptions question. Host approval review still applies; this does not change permissions or allowlists. The bare saved-history command needs no network access. Append `--preview` to either form to calculate without saving. The model need not build return rows, write a temporary policy file or ask the user to supply a CSV. Other methodologies remain available through the policy JSON interface below. Saved variable bounds incompatible with the preset's 1% grid require a choice; they are never silently rounded. Existing fixed weights, subjective risk caps/scores and horizon metadata are retained when switching objectives. The horizon metadata does not annualize the Sharpe calculation.

The command fetches and solves outside the configuration lock, then atomically saves the exact policy, provenance and targets only if the captured wallet configuration is unchanged. A concurrent edit returns `config-changed` without overwriting it. An application also saves one explicit rebalance request: a running portfolio re-evaluates after pending transactions settle, while a stopped portfolio stays stopped. It does not directly start, sign or submit a trade. Preview, missing assumptions, incompatible inputs and provider failure do not save targets. Compact output includes the assumptions, data basis, score, target weights and policy hash; the full frozen panel remains in the saved policy.

`history-unavailable` includes a sanitized `failure.code`: `network-access-denied`, `network-unavailable`, `timeout`, `provider-http` or `invalid-history`. HTTP failures identify only the fixed provider and status, never response bodies. A network failure is different from an invalid sample. If a restricted attempt was nevertheless made, the agent may retry a known prewrite network failure once using approved network access, the same returned `--profile`, the already-authorized preset and the same preview/application intent. DNS errors alone do not establish a sandbox restriction. HTTP/schema failures do not justify indiscriminate escalation. Missing command results or process timeouts require a public-state check before repeating an application, because repeating success would mint a new rebalance request.

### Preset data and interpretation

`stock-usdg-1y` supports USDG plus four stocks from the verified manifest. It fetches only fixed public Yahoo chart URLs and Kraken's `USDGUSD` OHLC endpoint, without wallet addresses, provider login or API keys. Requests run in parallel under a 15-second deadline with a 2 MiB limit per response. There is no silent provider fallback or automatic retry.

Yahoo adjusted closes account for stock splits and dividends ([definition](https://help.yahoo.com/kb/SLN28256.html)). These are **underlying-share proxies**, not historical prices of the Robinhood tokens. The Yahoo chart endpoint has no stable published API guarantee; malformed or changed provider responses are rejected. Actual Kraken USDG/USD closes keep USDG variable rather than assuming a fixed $1 peg or reserving a fixed cash allocation. Kraken's final OHLC row is uncommitted and is always excluded; its endpoint returns at most 720 recent candles ([Kraken documentation](https://docs.kraken.com/api-reference/market-data/get-ohlc-data)).

The builder keeps completed prior-date stock bars over the last year, requires identical stock date sets, and requires an actual USDG price on every selected date. It aligns closes before calculating simple returns; it never fills missing observations or assigns them zero return. Stock closes occur at the US session close, whereas USDG candles close on UTC boundaries. The saved source labels that mismatch. The one-year preset requires at least 200 aligned closes plus coverage/staleness bounds to reject short, sparse or stale samples. These are heuristics, not an independently verified exchange calendar. The general custom-panel validator retains its 20-return minimum. The response records source URLs, fetch time, first/last dates, row count and a history hash.

The preset uses a labelled **zero-return test benchmark**, not an estimate of the risk-free rate. It maximizes the historical, unannualized Sharpe score over the declared grid plus a feasible incumbent. The compact output includes `scoreLabel` with the actual daily/weekly/monthly interval and `pathConvention: constant-weight-per-observation`. The built-in preset score is **daily historical Sharpe**, not an annual score or a percentage return. It assumes constant weights per observation and omits execution costs. This is a reproducible test model, not a forecast or proof of the best future portfolio. Samples stay frozen until an explicit preset refresh or policy edit; ordinary market ticks and runner cycles do not rerun optimization.

For each observation, portfolio return is the weighted sum of simple asset returns. Sharpe is the arithmetic mean of portfolio return minus the declared per-period benchmark, divided by its sample standard deviation (`n − 1`). A conventional daily-to-annual comparison multiplies by `sqrt(252)`; this assumes zero serial correlation with additive returns and ignores compounding effects, so the command does not do it automatically ([Sharpe, 1994](https://web.stanford.edu/~wfsharpe/art/sr/SR.htm)). It is not realized wallet performance.

Sharpe alone does not determine an appropriate cash allocation: with an exactly zero-return cash asset and a zero benchmark, scaling a risky portfolio down scales both mean excess return and standard deviation equally. This preset uses actual USDG returns, so small cash returns, covariance and the discrete grid can select a large USDG weight for a very small score improvement. Do not interpret that precise percentage as a robust forecast or silently add a cash cap; different risk constraints remain an explicit user choice.

## Reading the chart

One read-only caption above gas describes the saved **target allocation** model. User-risk mode shows the weighted risk on the 0–100 scale, the custom return/risk ratio and the user horizon. The ratio uses expected horizon excess return in basis points per subjective risk point; it is not standard Sharpe or a percentage. Historical Sharpe mode shows the observation period instead. Accessible chart details retain the units, assumptions and historical basis. A manual portfolio shows “Target risk · not set”; unavailable or disconnected data is labelled explicitly. No risk is inferred from current holdings, and chart rendering never recalculates or changes targets.

## Risk means what the user says it means

The main objective is `user-risk`. Each asset has a user-selected risk score from 0 to 100 over a stated horizon, and a user-supplied expected return for that same horizon. These scores are relative judgments, not probabilities of loss or calibrated market statistics. A user can judge a volatile asset to have little long-term risk. Code does not replace that judgment with observed volatility, downside moves or drawdown.

The objective is weighted expected excess return divided by weighted subjective risk. Expected returns and the benchmark are in basis points for the entire `horizonMonths`, not annualized. A risk point is the user's unit, so this is called a **user-risk score**, not a Sharpe ratio. The weighted score has no inferred correlation or diversification benefit; explicit allocation bounds can express a desired level of diversification.

A positive expected excess return with zero modeled risk makes the ratio undefined. The solver reports missing usable risk input rather than silently inserting a risk floor, ignoring the candidate, or returning infinity. Zero-risk candidates with nonpositive excess return have no score; if no candidate has a score, calculation fails without changing targets.

When expected excess returns are negative, maximizing a return/risk ratio can prefer a worse return and higher risk because a larger denominator makes a negative score less negative. This applies to the chosen ratio, including negative Sharpe scores; it is not a guarantee that the selected portfolio dominates alternatives on return and risk separately. Inspect negative scores and the underlying assumptions; optional risk limits and allocation bounds still apply.

The agent may translate natural language into a proposed numerical policy, but must preserve the user's meaning and resolve missing risk scores, horizon, expected returns and benchmark. It must not invent them or interpret “low risk” as a loss probability. Changing the horizon requires updating the horizon-dependent assumptions together. ETH mentioned as an example of long-term conviction does not add it to this app's allocation universe: native ETH remains gas-only.

## Agent operations

All operations use the connected wallet or an explicit `--profile <public-address>`:

```sh
npm run cli -- allocation preview /absolute/path/to/policy.json
npm run cli -- allocation set /absolute/path/to/policy.json
npm run cli -- allocation status
npm run cli -- allocation manual
```

For custom policies, the agent writes JSON locally from the user's stated inputs and runs these commands; the user need not use a CLI. Preview changes nothing. `set` calculates against the latest saved targets and atomically writes policy, calculation provenance, targets and one explicit rebalance request under the existing configuration lock. It does not start trading. An already armed runner consumes the request after pending transactions settle, bypassing automatic cooldown once. Policy changes can be saved during pending transactions or an active cycle; submitted transactions remain intact. See [live settings](LIVE_SETTINGS.md).

`manual` removes the policy while retaining its last target split. Explicit `targets set`, `targets replace` and `configure --targets` also switch to manual in the same write. Unrelated configuration changes preserve the policy. Each wallet owns its policy independently; changing the chat connection never changes it.

There is no recurring optimizer or scheduled AI task. The same assumptions and current targets yield the same solution. The agent submits a policy/data edit through `allocation set` or the Sharpe command above to recalculate; editing an input JSON file alone has no effect. The saved deterministic runner handles subsequent holdings drift. It does not infer forecasts from live prices, automatically roll a historical sample forward, or treat market ticks as changes to the user's beliefs.

## Policy schema

Required fields:

- `version`: `1`.
- `objective`: `user-risk` (the main choice) or explicitly selected `sharpe`.
- `horizonMonths`: integer 1–1200.
- `stepBps`: integer 100–1000 dividing 10,000, declaring the search grid's allocation increment.
- `benchmarkReturnBps`: integer −10,000 to 10,000,000 total benchmark return for the user's horizon, used by `user-risk`.
- `assets`: exactly the five currently configured asset IDs. Each has integer `minBps` and `maxBps` between 0 and 10,000. Variable bounds must be multiples of `stepBps`; fixed weights can be arbitrary basis points. To retain 5% USDG, set its minimum and maximum both to 500. This cash constraint must be carried from the user's preference; the solver does not assume that cash has zero risk.
- For `user-risk`, every asset additionally requires integer `riskScore` (0–100) and `expectedReturnBps` (−10,000 to 10,000,000). These are assumptions over `horizonMonths`, not estimates generated by the software.

Optional `riskDefinition` on the policy and `rationale` on each asset retain the user’s meaning and thesis as plain text (at most 1,000 characters each). They are included in provenance but never executed or used as hidden numerical inputs.

`maxRiskScore` is an optional integer 0–100 ceiling on the portfolio’s weighted subjective score. It requires explicit asset risk scores even in Sharpe mode. It is a subjective model constraint, not a monetary spending limit or a promised maximum loss.

Unsupported fields fail validation instead of silently dropping a requested constraint. The same validated data and current targets produce the same result and canonical SHA-256 policy hash. The solver searches feasible grid allocations plus a feasible incumbent, including one that lies off-grid. It conserves exactly 10,000 integer basis points, honors bounds and rejects searches beyond five million candidates. Score ties use a fixed numerical tolerance, then minimum target turnover, then stable asset ordering. “Best” refers to this declared search set and model; finer or different models can produce different allocations. The objective omits transaction costs. Existing drift and cycle cadence still govern swaps.

## Optional statistical mode and diagnostics

Standard Sharpe is an explicit alternative objective, not the definition imposed on user risk. It uses historical mean differential return divided by the sample standard deviation of differential returns. Its return and score refer to the supplied observation period, not the user horizon. This follows [Sharpe's original definition](https://web.stanford.edu/~wfsharpe/art/sr/SR.htm).

Supplying a validated aligned return panel also permits descriptive volatility, Sharpe, downside deviation, Sortino, compounded drawdown and historical 95% expected-shortfall diagnostics. In `user-risk` mode these diagnostics do not affect ranking. Metrics and return assumptions are labelled separately; no automatic annualization or substitution of historical mean returns into the subjective objective occurs.

The panel must state its source, quote currency, interval, as-of date and whether it describes tradable tokens, an underlying-asset proxy, or a synthetic fixture. Every dated row must contain all configured assets, with strictly ordered unique dates and finite simple returns. Missing observations are rejected; they are never treated as zero return. Twenty observations is a validation minimum, not evidence of predictive reliability. Synthetic panels work in preview/tests and cannot be adopted into a portfolio. The exact `history` fields are `source`, `basis` (`tradable-token`, `underlying-proxy` or `synthetic`), `quoteCurrency`, `interval` (`daily`, `weekly` or `monthly`), `asOf`, `benchmarkPeriodReturn`, and `observations`. Each observation has `date` (`YYYY-MM-DD`) and `returns` mapping every configured asset to a decimal simple return (0.01 means 1%). `benchmarkPeriodReturn` is constant per observation. Returns and the period benchmark must be between −1 and 1,000 inclusive. There must be 20–2000 rows. Dates must be ordered and no later than `asOf`; adoption rejects a future as-of date. The interval/calendar and source labels are assertions supplied with the data, not independent provider verification. An importer must align the calendar before supplying the panel; this validator cannot detect a missing market session from metadata alone.

The stock/USDG preset supplies the labelled proxy history described above. The app's execution spot quotes still value Robinhood ERC-20 token units in USDG; they cannot substitute for historical return rows. Historical diagnostics assume constant weights rebalanced each observation without costs. They are descriptions of that model, not the realized gas-costed execution graph or guarantees about future loss.

## Implementation boundary

`src/allocation.ts` contains the pure solver, `src/allocation-metrics.ts` validates and measures an optional frozen panel, and `src/allocation-management.ts` handles policy projection and validated adoption. `src/sharpe-history.ts` builds the bounded public proxy panel; `src/allocation-sharpe.ts` orchestrates the one-command workflow and guarded adoption. The CLI writes one wallet-scoped config revision; ordinary reads do not rerun optimization. No live wallet policy or target was installed as part of building this feature. Implementation verification uses isolated fixtures and a public-data preview in disposable storage.
