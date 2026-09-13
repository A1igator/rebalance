# Preserve loopback navigation and release streams before page loads

Date: 2026-09-13

After the selector repair, the user reported “this session is stuck too now” on localhost:4666. Read-only API checks confirmed this separate conversation was attached to its Ledger portfolio, the runner was active and the last Start request had completed. The served selector contained the bounded-request repair. Six Codex connections were established to the chart port, but socket metadata alone cannot establish their HTTP roles or hostname pools.

The backend registry returns 127.0.0.1 chart links. Existing UI validation preserved that host, so a localhost selector switched back to 127.0.0.1 on card selection or an agent-driven wallet change. Preserve the current validated loopback hostname after validating the destination, keeping its wallet port, chart path and conversation fragment. Reject external hosts, credentials and unsafe destinations before rewriting.

Release existing live view/status streams before Back and agent-driven navigation, not only on pagehide: the next document may itself be waiting for an available HTTP connection. Retain the holds through navigation and restore them correctly after Back/page restoration; preserve compare-and-clear selection authority, existing response bounds and stale-event checks. This repair is non-trading. Refresh only the chart service, leaving the active portfolio runner untouched. Test changes in isolated fixtures; do not claim browser recovery solely from a working backend endpoint.
