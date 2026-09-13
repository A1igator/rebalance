# First-attempt Sharpe access and explicit score units

Date: September 13, 2026.

The owner referenced another Sharpe request and asked whether it could work on the first attempt and whether the reported ratio was correct. The selected-wallet command had resolved assumptions correctly, but the fresh-history invocation first used restricted network access, returned a known prewrite network failure, and only then retried with approved access.

## Scope

Guide explicit fresh-preset requests to use the host's approved network permission mechanism on their initial invocation when the host declares restricted networking. Preserve the actual selected wallet, authorized assumptions and preview/application intent. A first-use response declares that the preset requires network access. Saved frozen-policy calculations stay local. Do not change permission settings, bypass approval review, silently change portfolios or retry uncertain applications.

Make the compact result label daily, weekly or monthly historical Sharpe explicitly, without annualizing or changing the calculation. Include the existing constant-weight-per-observation convention. Explain the zero-return benchmark, underlying-stock proxies, omitted execution costs and cash-weight sensitivity. No live policy update, runner control, signing or trade is part of this work. Tenjin remains fully disabled for the demo.

## Verification

Read the referenced task and this wallet's saved public allocation state. Independently reconstruct weighted observation returns, arithmetic mean excess return and sample standard deviation; compare the ratio with the saved result. Independently enumerate the feasible 1% grid to check the maximum, without invoking a live optimization application. Preserve actual financial data in local state rather than public fixture files. Cross-check definitions and time scaling against [Sharpe's 1994 paper](https://web.stanford.edu/~wfsharpe/art/sr/SR.htm).

Use isolated output regression tests to retain actual observation intervals and unchanged scores, byte-identical previews and no network fetch for saved policies. Typecheck, validate the skill and review the focused diff before committing. Record actual results in the AI usage log.
