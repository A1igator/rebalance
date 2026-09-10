# Grid-only selector — 2026-09-07

## Human request

> can we clean up the text a lot. No text except the boxes probably best

## Plan before implementation

Remove the selector heading, brand line, introductory copy and routine connected/empty-list narration. Start the normal view directly with the square portfolio tiles. Retain their wallet, signer, status and target labels, their accessible descriptions and the setup dialog. Present any necessary loading, unlinked-view or failure feedback and retry within a compact box, keeping text out of the space around the grid. No service, wallet, target or execution change is needed. Run the existing selector checks, inspect the live side panel, and record results in AI_USAGE.md. Commit locally; the pending push authorization is unchanged.
