# Clickable stock rings — 2026-09-10

The human requested clickable pie bars and stock labels, with animation, that open Google so viewers can inspect the stock chart.

## Plan before implementation

Give actual and target ring segments and their corresponding labels native links to a Google search for the represented stock. USDG links to a stablecoin search. Construct queries from the existing public asset name/ticker only; never include wallet addresses, holdings or conversation handles. Open in a new tab with referrer suppression. Add subtle pointer/focus/press feedback and respect reduced-motion settings. Keep empty, single-asset and small-segment geometry accurate; make links keyboard-accessible without changing portfolio selection or trading. Validate link identity, labels and animation behavior using isolated fixtures and visually inspect the live chart without clicking trading controls.
