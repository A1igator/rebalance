# Loading feedback without layout shift — 2026-09-07

## Human request

> can we also make loading a pop up as opposed to shifting the UI down

## Plan before implementation

The portfolio selector currently renders its loading/connection feedback in normal flow above the grid, so showing it pushes the cards down. Move the existing feedback panel to a compact fixed overlay. Apply matching placement to the chart’s existing transient control message, which otherwise changes the centered chart’s layout. Preserve live status announcements, retry links, message lifecycle and existing loading/duplicate-click behavior. Wallet setup already has its own dialog.

Use CSS-only positioning, constrained to the viewport with a safe-area inset. The overlay should not capture focus or add a confirmation step. Inspect the visible popup and confirm underlying content does not move; run the existing relevant UI checks without adding a test framework. No wallet, allocation, trading, provider, notification or server process change is required. Record actual results and provenance.
