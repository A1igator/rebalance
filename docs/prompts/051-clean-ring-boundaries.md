# Clean allocation-ring boundaries — 2026-09-07

## Human request

> the pie chart colors are bleeding a bit into each other in the privy one

## Observation and plan before implementation

Live inspection of the portfolio selector shows a small orange-colored spill across the top Privy ring boundary into the green slice. The shared renderer uses wide dashed SVG circles with normalized path lengths.

Replace dashed-circle slices with filled annular SVG sectors whose endpoints use the exact cumulative allocation angles. Preserve the shared color palette, order, thin target ring and existing straight mask cuts for parallel gaps; handle a full allocation as a complete annulus. Both the selector previews and full chart use the same renderer. Preserve tiny allocations and dominant allocations above 50 percent.

Adapt the existing renderer assertions to verify geometry and weights with the new representation, run focused UI tests, and inspect the actual Privy preview and chart. This is a display-only change: no allocation, wallet, runner, provider, signing or notification operation is involved. Static assets are served from source, so browser refresh should suffice. Record actual results and AI provenance; no new dependency is planned.
