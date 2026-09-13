# Clear the chat attachment when returning to the selector

The user corrected the notification rollout: “there’s no ledger selected right now”. The companion was showing the portfolio grid, but its Back link had kept the old Ledger attachment in the conversation record. The notifier therefore treated an old attachment as the current selection.

Make explicit Back navigation clear only that capability-bound conversation’s displayed-wallet attachment before navigating to the selector. Compare the expected wallet under the existing notification-selection lock so an obsolete chart cannot detach a different current portfolio. Already-unattached Back is idempotent; stale different selection is a visible refusal. Chart view updates with no attachment return to the selector. Passive view reads and old background selector pages must never detach a newer selection.

Deselecting suspends chat delivery through the existing selected-running gate, preserving explicit notification preferences, queue/uncertainty records and all trading state. A new card or explicit agent connection chooses a portfolio again. Verify with isolated backend capability/concurrency/state-preservation and browser-navigation tests. Correct this conversation’s known stale attachment without changing its running Ledger portfolio. Keep Tenjin publication paused and push the tested fix to main.
