# Stable Ledger approvals and completed Stop feedback

Date: 2026-09-13

User requests:

- “still taking 8 signatures to rebalance” (referencing the existing Open Rebalance portfolio selector task).
- “ah do I need to stop and start the ledger process?”
- “I pressed stop but ‘stopping...’ seems to be stuck”.
- After pressing Start, the user reported “Starting” stuck while public metadata still showed no new Start journal entry or runner.

Read-only investigation verified seven confirmed outgoing transactions in the latest rebalance: four stock approvals (AMD twice), one three-sale multicall, one USDG approval, and one AAPL-purchase multicall. This establishes seven broadcasts, not the number of physical device screens or unbroadcast signatures. The running process loaded the older phase-batching implementation before combined sales/purchases landed. A tiny change to the freshly calculated AMD sale raised its exact approval requirement and caused the duplicate approval.

Implementation:

- Keep combined swaps and fresh balance, route, tradability, minimum-output and gas checks.
- Persist the prepared batch’s public aggregate input amounts before signing. Each later preparation may tighten them, never raise them; missing input tokens cannot gain authority in that batch. Clip sales before quoting and cap aggregate USDG spending before apportioning buys.
- Scope saved amounts to wallet, validated configuration fingerprint, active cycle and the preceding confirmed swap. Approval receipts and process restarts retain them. A confirmed new swap or a changed configuration/cycle allows a newly prepared batch. These are preparation bounds, not an allowance grant, spending-limit feature or permission to sign.
- If fresh holdings need entirely different inputs, wait for the existing next eligible cycle without claiming completion. Preserve pending receipts and cadence.
- Refresh runner status only during transient Start/Stop states, with a bounded serial read-only check. Process exit can occur after the last file event; that must not leave the UI permanently showing Stopping. Never retry the mutation or poll healthy state.
- Bound the browser control-response wait as well: aborting an HTTP wait is not cancellation of the server action. Preserve an explicit unknown-outcome message, reconcile through read-only runner status, ignore late responses and never retry a Start/Stop POST automatically. Public GET responsiveness with no new Start journal distinguishes a stalled client request from a launched runner; six open chart connections suggest SSE/browser connection contention, but do not prove its precise cause.
- Unit and integration tests use only isolated storage and mocked RPC/signers. No live Start, signing, target change or transaction is performed by this repair. The owner’s Stop completed naturally; any later Start remains owner-controlled.

The next explicit Start also timed out and showed Unavailable. Read-only checks still found an immediate stopped runner response, a valid selected view and no Start receipt after the owner's earlier Stop. Six chart connections belonged to the Codex browser process. The repair releases this page's long-lived status and view streams during an explicit control request and its status readback, then resumes them when visible. Bounded transition readback uses the same temporary stream holds so reconnection cannot starve the final process-state check. Request identity and server validation remain unchanged; connection availability does not authorize retries. A six-connection isolated HTTP fixture tests the starvation mechanism separately from the unverified live browser cause.
