# Portfolio share codes

Date: 2026-09-11

## Human request

A teammate asked for a way to share portfolios. The plan in issue #21 first used ENSv2 names on Sepolia. Those only mattered for the ENS prize, would have taken one of the three partner slots, and records on mainnet cost gas plus a yearly name fee. The human asked for a free alternative instead: “can we have like copy to clipboard so other person can share and import or some other way that can be free”. The human then confirmed: “clipboard things work … button is allowed. Please open up PR into the repo”. The explicitly allowed chart button is an exception to the chart's click list; ENS is not adopted.

## Plan before implementation

- Share the strategy, not the wallet. A plain-text `rebalance:v1` code carries the five targets, the drift trigger and the cycle interval. It never carries the wallet address, signer mode, RPC URL, slippage, deadline, poll interval, allocation policy or holdings.
- `share export` prints the selected wallet's code.
- `share import '<code>'` previews target and setting changes plus untracked assets, and changes nothing.
- `--apply` saves the targets under the config lock, like `targets replace`, and drops any allocation policy.
- `--settings` also saves the drift trigger and interval. Without it they stay suggestions.
- Decoding resolves symbols through the verified manifest, so a code can never name a token address. It rejects unknown and duplicate fields and bounds settings to the existing configuration ranges.
- A chart **Share** button copies the same text from the status snapshot the page already receives. If the clipboard is denied, it shows the code as selectable text instead. It needs no view token and makes no request.
- Tests cover round trips, rejection, preview and apply through the real CLI, parity between the chart and CLI encoders, clipboard failure, and the served asset. No dependency, network call or trading behavior is added.

## Outcome

Implemented as planned:

- `src/share.ts` encodes and decodes codes.
- `src/commands.ts` adds `share export` and `share import`.
- `ui/share-code.js` adds the chart button.

The drift trigger and interval are adopted only with `--settings`. Import previews list `untrackedAssets`, whose holdings are not sold. Validation is recorded in `docs/AI_USAGE.md`. The PR is opened from the contributor fork for review; the assistant merged nothing.
