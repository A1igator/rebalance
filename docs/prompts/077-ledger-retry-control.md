# Retry cancelled Ledger requests from the companion

Date: 2026-09-12. Recorded before implementation.

## Human request

The owner requested a Retry button after cancelling a Ledger request, without requiring disconnect/reconnect or an agent command. They also asked about remote versus USB signing. The ongoing mainnet Ledger validation remains separately authorized, with physical confirmation of each transaction.

## Bounded implementation

Add a wallet-scoped Retry action to the existing companion control surface when a running Ledger portfolio has a suspended finished request. Reuse the existing explicit request command/service and fresh per-click UUID, with duplicate and uncertain-response handling. Preserve linked-view authorization, displayed-wallet/config binding, stop state, pending receipt barriers and concurrent-request exclusion. Never start a stopped portfolio from Retry, change targets, sign from a notification, weaken device display/fallback handling or clear a pending transaction record.

Keep the interface compact and make the in-flight state visible. A accepted/queued retry is preparation, not a signed or completed trade. Build isolated regression coverage through npm test, then inspect the UI and reload only the owned chart service when safe. Other portfolios and the active trading process remain independent. Verify remote transport claims against official Ledger documentation; distinguish remote control of the Mac from signing with a Ledger attached elsewhere. Preserve unrelated stock-link edits.

## Validation and evidence

Run appropriate control/route/display and request tests plus typecheck and whitespace checks. Record actual results and any device receipt separately. No live storage is used in tests. Required initial Tenjin search failed NETWORK_ERROR; no finding was read. Commit and push to main under the owner's standing preference.
