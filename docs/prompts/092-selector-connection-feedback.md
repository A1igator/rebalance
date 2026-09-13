# Bounded portfolio connection and verified navigation

Date: 2026-09-13

The user referenced “Open Rebalance selector” and reported “Connecting this portfolio to your chat…” stuck. A read-only check confirmed the referenced conversation was already attached to its chosen Ledger portfolio. Its runner was active; attachment state and a finished browser navigation are distinct.

The selector had a separate unbounded HTTP wait even after the Start/Stop repair. Release its view stream while one explicit connection request and one authoritative attachment readback run, with bounded response-body waits. Navigate only when the saved attachment matches the requested wallet, preserving the view fragment and local chart URL restrictions. A lost response may still correspond to a completed connection; malformed successful responses cannot establish success. Never automatically resend selection. Keep a connection free until navigation/pagehide, restore normally after Back and ignore old replies. Preserve an unresolved connection error across unrelated healthy updates.

If a request is abandoned while its chart is being prepared, the server must check that the response remains open before committing the selection. A request already across that boundary can still finish; preserve uncertainty and check actual state. Keep notification binding and startup semantics unchanged. All tests use isolated temporary state or browser fixtures. No trading, wallet setup, target changes, signing or notifications are invoked by the repair.
