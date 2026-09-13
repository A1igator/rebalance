# Notifications follow the selected running portfolio

The user asked whether notifications were already configured. Read-only inspection found the old binding only in the retired raw-wallet incident archive; none of the three registered wallets had a current Codex binding. The user first proposed all wallets, then clarified: “or actually yeah the selected portfolio makes sense if it’s running”.

Implement automatic Codex notification setup from the trusted native chat selection and companion view. Deliver only while that same conversation selects the wallet and its local runner is verifiably running. Stop or selection mismatch suspends delivery without changing the explicit notification pause preference or trading. Latest explicit selection may transfer the existing single-wallet Codex destination; retain all accepted/uncertain delivery barriers. Recheck the selection and owned running state immediately before native queue dispatch. Keep automatic read/quote retries and successful recovery excluded before the model.

Reuse the local file-driven worker and native Codex queue. No all-wallet subscription, periodic model task, generic event bus, new signing permission or trading control. Opening a selector without a selected wallet does not guess one. Preserve the host-specific OpenCode/Claude notification paths and narrow them to selected running scope where their native transport permits it.

Validate using isolated temporary directories and stub native queue effects. Do not invoke live notification setup, queue messages, sign, or change financial state during development.
