# One target-allocation label in the ring center

Date: 2026-09-11

## Human request

“can we remove "Targets only" and make it clear in the middle of circle. kinda duplicating "targets" a lot”

## Plan

Remove the separate target-only legend below the ring. When the chart has saved targets but no valued holdings, label the center “Target allocation” and retain the precise explanation beneath it: wallet empty, holdings not checked or holdings below precision. Preserve execution/error priority and actual-versus-target accessibility semantics. Update the existing display checks, inspect the current companion after reloading, and push the UI change to main. Do not change allocations, wallet data or runner state.

The required Tenjin search returned NETWORK_ERROR without a finding. This is a local UI copy change with no new dependency.
