# User-defined risk allocation

A wallet can keep manual target percentages or derive them from an explicit allocation policy. The agent captures the user's beliefs and intent; local code calculates and saves targets. The existing deterministic runner maintains those targets without an agent connection. The chart remains view-only, including its target ring.

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

The agent writes the policy JSON locally from the user's stated inputs and runs these commands; the user need not use a CLI. Preview changes nothing. `set` calculates against the latest saved targets and atomically writes policy, calculation provenance and targets under the existing configuration lock. It does not start trading. An already armed runner consumes changed targets on its next eligible graph evaluation. Policy changes can be saved during pending transactions or an active multi-leg cycle. The next evaluation uses the new policy targets, while submitted transactions, recorded cycle timing and cooldown remain intact. See [live settings](LIVE_SETTINGS.md).

`manual` removes the policy while retaining its last target split. Explicit `targets set`, `targets replace` and `configure --targets` also switch to manual in the same write. Unrelated configuration changes preserve the policy. Each wallet owns its policy independently; changing the chat connection never changes it.

There is no recurring optimizer or scheduled AI task. The same assumptions and current targets yield the same solution. The agent submits a policy/data edit through `allocation set` to recalculate; editing an input JSON file alone has no effect. The saved deterministic runner handles subsequent holdings drift. This first version does not fetch history, infer forecasts from live prices, automatically roll a historical sample forward, or treat market ticks as changes to the user's beliefs.

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

No suitable market-history feed currently exists in this repository. The app's spot quotes value Robinhood ERC-20 token units in USDG; they do not provide a time series, measure USDG's dollar/depeg risk, or automatically match split/dividend-adjusted underlying shares. Historical diagnostics assume constant weights rebalanced each observation without costs. They are descriptions of that model, not the realized gas-costed execution graph or guarantees about future loss.

## Implementation boundary

`src/allocation.ts` contains the pure solver, `src/allocation-metrics.ts` validates and measures an optional frozen panel, and `src/allocation-management.ts` handles policy projection and validated adoption. The CLI writes one wallet-scoped config revision; ordinary reads do not rerun optimization. No live wallet policy or target was installed as part of building this feature. Inputs used for implementation verification are isolated fixtures.
