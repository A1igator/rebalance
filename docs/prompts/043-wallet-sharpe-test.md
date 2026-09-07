# Test standard Sharpe for the selected wallet — 2026-09-07

## Human requests

> and for risk stuff let's just set it to sharpe for now for testing. don't remove the other machinery but for this portfolio specifically

The human approved using underlying stock history as a labelled proxy.

> and usdg should be at sharpe max too no need to keep it seperate

## Plan committed before policy setup

Apply the test to the Privy portfolio, as clarified below; preserve the local-key portfolio and the user-risk optimizer. Prepare a wallet-scoped standard Sharpe policy for the current USDG/AAPL/NVDA/MSFT/AMD portfolio, allowing all five weights to vary. Retrieve a verifiable aligned historical stock-return panel, preferably recent daily adjusted observations, retaining source/date/basis information. Do not fabricate or relabel synthetic observations as market history. Resolve the cash proxy assumption explicitly; standard Sharpe with a constant-value cash asset and zero cash benchmark does not uniquely determine cash weight, so report the existing deterministic tie-break behavior rather than claim a unique optimal cash allocation.

Use the existing pure optimizer and CLI preview. Save the requested policy only with usable validated data and a fully stated resolved policy/result. Existing execution guards govern subsequent funded swaps; policy setup does not sign, submit or restart trading. The statistical Sharpe inputs remain frozen until edited. Do not introduce a scheduled historical feed or remove the subjective-risk machinery. Record source provenance and aggregate validation without publishing live wallet/runtime identifiers.

## Work alongside notification repair

Finish action-only retry notifications in parallel. Notification activation remains limited to the notification listener. A research agent may locate historical source data; root owns policy validation and wallet-scoped adoption.

## Target-wallet clarification before adoption

> do the sharpe target for the privy portfolio not the local one so we can see both

No live policy had been adopted before this clarification. Scope preview and adoption explicitly to the registered Privy portfolio. Leave the local-key wallet and this chat's current wallet attachment unchanged; show both existing chart URLs for comparison. The selected test uses 251 daily return observations from September 8, 2025 through September 4, 2026: split/dividend-adjusted underlying share closes plus actual Kraken USDG/USD prices, with explicit proxy/close-time provenance and a zero-return test benchmark. All five assets vary from 0–100% on a one-percentage-point grid, with existing deterministic tie-breaks. These are frozen testing inputs, not a newly installed market-data feed.
