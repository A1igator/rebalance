# Animated Settings without chart movement — 2026-09-10

The human asked to restore the old Details opening/closing animation in the new Settings disclosure, then specified that opening it should not move the pie chart.

## Plan before implementation

Restore smooth open/close motion for the Settings content, anchored to its bottom control outside chart layout flow. Keep the chart and its center stationary while the panel animates. Retain only Drift trigger, Cycle interval and Fee target, with native disclosure accessibility, keyboard use and reduced-motion behavior. Check narrow-screen layout and opening/closing states; do not change portfolio configuration or run controls through UI verification.
