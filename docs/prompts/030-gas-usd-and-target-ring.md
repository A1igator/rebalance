# Gas USD display and target ring

Date: **2026-09-05 America/Toronto** (September 6 UTC). Prior hackathon commits remain intact.

## Material user requests

> show eth on left side and in usd too with current gas prices under it with gwei and usd

> can we also show targets somehow? not sure what industry standard is for pie charts but maybe as a ring in the middle

> also some of the text is overlapping and the bars aren't parallel so if you could fix that it would be great too

## Plan

- Move the small ETH gas balance to the lower-left, include an approximate USD value, and place a gas-price line beneath it with gwei and USD **per unit of gas**, not a transaction-fee claim.
- Keep actual holdings on the outer ring and add a thin matching-color inner ring for saved targets, with a small Actual/Target distinction. Preserve truthful empty/unavailable holdings and view-only interaction.
- Keep asset order, starting angle and centered angular divider gaps consistent between rings; preserve differences arising from actual drift. Position the full three-line label stack outside the ring, including upper labels that overlapped during initial visual review.
- Add a read-only local gas-display endpoint. The server obtains Robinhood `eth_gasPrice` with chain-ID validation and Coinbase ETH-USD spot, using bounded requests, a shared 30-second cache, and coalesced concurrent calls. Keep source timestamps and last good values on partial failures; show unavailable/stale values accurately.
- Quote traffic contains no wallet, balance, allocation or credential. Browser requests stay local; conversion/calculation/display remain local. These external reference prices never enter portfolio planning or signing. No new dependencies or change to trading, cadence, recovery, signer or native hook.
- Validate integer USD/gwei conversion, source failures/cache behavior, view-only endpoint, browser lifecycle/freshness/rings, then reload only the read-only chart server and existing browser tab. Preserve the active funded runner.

## Sources and delegation

- [Coinbase price API](https://docs.cdp.coinbase.com/coinbase-app/track-apis/prices): public currency-pair spot endpoint without authentication; USD display uses ETH-USD rather than the portfolio's USDG DEX values.
- Robinhood RPC endpoint and chain ID are the existing verified application constants. Gas rate alone does not establish a full transaction fee; no hypothetical stock-swap gas count is presented.
- Gas-provider agent owns `src/gas-display.ts` and isolated provider tests. UI agent owns the view and focused browser tests. Root owns HTTP integration, provenance, review and live read-only verification.

Validation results are recorded in [AI usage](../AI_USAGE.md). Design choice: concentric actual/target rings are a clear comparison for this demo, not a claim of one mandatory industry standard.
