# Portfolio navigation must finish or recover visibly

Date: 2026-09-13. Follow-up to prompts 092/093 and the owner-reported successful Simple7702 setup.

The owner reported that selecting a portfolio remained on the grid with a browser-tab/address-bar spinner. A later timeout said the connection was saved but the chart did not open, and closing a tab did not resolve it. The owner asked whether disconnecting the session was necessary.

The saved attachment and document navigation are separate outcomes. Read-only inspection confirmed the intended Ledger attachment was already saved; repairing page loading must not disconnect it, stop/restart trading, replay a financial control, or change targets. A browser navigation request is not evidence of a loaded document.

## Implementation

- Limit long-lived status, view and setup event responses to four per chart listener. A new stream ends the oldest read-only stream, which reconnects through its existing transport. This reserves document/short-request capacity in a modeled six-connection HTTP pool, including when the destination chart has other tabs open. Validate protected stream requests before admitting them.
- Keep visible opening feedback after a verified selection. If the original page remains after 15 seconds without pagehide, cancel its unfinished document load, restore interaction, retain the saved attachment and explain that opening failed.
- Apply the same bounded navigation to agent-driven chart changes and return-to-selector navigation. Release each caller's stream holds and Back busy state. Pagehide cancels stale deadlines; fresh snapshots must not loop the failed navigation. Only an explicit user retry repeats it.
- Keep loopback-host preservation, capability checks, authoritative selection readback, control deduplication and trading/notification boundaries intact. Closing tabs or disconnecting a portfolio is not the required workaround.

## Verification

The isolated UI/server suite passed 194/194 and TypeScript checking passed. Tests cover capacity reservation with six pooled sockets, initial/reconnected read-only streams, single-dispatch fixture controls, saved-selection navigation timeout, viewing-only timeout, automatic navigation suppression, explicit retry, Back busy-state recovery and page lifecycle cleanup. A pre-existing server display mock needed its missing DOM removeAttribute method; two old timer assertions now distinguish the new document deadline from polling. All fixtures use disposable state; no real financial command is invoked.

Only the two verified read-only selector/chart listeners on ports 4663/4666 were refreshed. The actual Ledger runner remained running before and after. In the Codex in-app browser, clicking the already-attached Ledger card opened its chart across those ports, with document.readyState complete and an empty navigation error. The temporary verification tab was closed. This is one live successful selection, not proof that every browser failure is eliminated.

Separately, the owner's successful EIP-7702 report was checked against public receipt, transaction, delegation and pinned-runtime evidence. Empty wallet setup succeeded in block 61798118; it is not a live Simple7702 rebalance or Clear Signing result. See the separate evidence in docs/SIMPLE7702.md. No signing or financial-state mutation was performed for the navigation repair or evidence audit. Tenjin publishing remains paused.
