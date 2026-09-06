# Parallel ring divider edges

Date: **2026-09-06 America/Toronto**.

## Material user request

> the outer bars are still nit paralell

## Diagnosis and plan

The previous correction made angular gaps consistent across rings, but an angular gap is still a wedge: its width increases with radius. At the outer ring's 125/203 inner/outer radii, a 0.5% angular gap widens from approximately 3.9 to 6.4 SVG units. The user's remaining complaint is valid; consistent angles did not make the two sides of each divider parallel.

- Render each colored segment at its full saved/current angular share, preserving cumulative weight boundaries.
- Use an SVG mask with straight radial strokes to cut constant-width dividers. Apply the outer mask to the background track too, so both rings' cuts expose the same page background.
- Use four SVG units per divider in ordinary cases. Bound width against the two adjacent slices at the inner radius so a tiny holding remains visible; skip dividers for a single 100% slice. Keep mask and segment coordinates aligned.
- Preserve the actual/target distinction, label clearance, gas display, view-only interaction and all portfolio/runtime behavior. No dependency or external artwork is added.
- Update existing geometry checks, inspect the real chart, and commit the prompt, implementation and AI record on main. This is a browser asset change; no server or trading process restart is needed.

Root owns UI changes/provenance. A UI agent independently reviewed the geometry and owns focused updates to the existing browser geometry tests. No financial operation is part of this work.
