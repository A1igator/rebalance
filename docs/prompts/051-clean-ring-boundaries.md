# Clean allocation-ring boundaries — 2026-09-07

## Human request

> the pie chart colors are bleeding a bit into each other in the privy one

## Observation and plan before implementation

Live inspection of the portfolio selector shows a small orange-colored spill across the top Privy ring boundary into the green slice. The shared renderer uses wide dashed SVG circles with normalized path lengths.

Replace dashed-circle slices with filled annular SVG sectors whose endpoints use the exact cumulative allocation angles. Preserve the shared color palette, order, thin target ring and existing straight mask cuts for parallel gaps; handle a full allocation as a complete annulus. Both the selector previews and full chart use the same renderer. Preserve tiny allocations and dominant allocations above 50 percent.

Adapt the existing renderer assertions to verify geometry and weights with the new representation, run focused UI tests, and inspect the actual Privy preview and chart. This is a display-only change: no allocation, wallet, runner, provider, signing or notification operation is involved. Static assets are served from source, so browser refresh should suffice. Record actual results and AI provenance; no new dependency is planned.

## Implementation and visual result

Partial allocations now use filled SVG annular-sector paths with exact outer/inner arc endpoints and the appropriate major-arc flag. A single 100% allocation uses an undashed full circle. Existing mask dividers, adaptive gap width, colors and callers are unchanged.

Browser refresh visibly removed the orange spill at the Privy preview’s top seam. The full Privy chart also shows clean boundaries with USDG 71%, AAPL 18%, NVDA 1% and AMD 10%. The local-key preview remains visually intact. Verification opened the already-connected Privy chart and returned to the grid; no allocation or trading control was changed. Static source reload required no server/runner restart.
