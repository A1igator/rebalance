# Center settings and paymaster verification — 2026-09-10

The human asked to verify the USDG paymaster path, then requested: “cycle interval and when it rebalances can also be in the middle section and we can just delete details after that tbh”. This supersedes the Details layout in prompts 054–056.

## Plan before implementation

Move the displayed portfolio's drift trigger, cycle interval and optional fee target into compact center text alongside execution status. Remove Details entirely, retaining the ring, targets, native Start/Stop, Back and explorer controls. Gas prices appear only during a fee-target block. Keep mobile center labels legible with no overlap; check loading, empty, on-target, cooldown, rebalancing and failure states. Allocation and settings changes remain agent-controlled.

The earlier user answer chose $0.05 for the displayed raw-key portfolio; other wallets retain their own settings. Finish the previously planned deterministic estimated-fee guard and its isolated tests. Do not treat this as actual-spend accounting or a guarantee of total realized fees.

Verify paymaster support through official documentation and public read-only chain/provider queries. Separate supported chain infrastructure, canonical USDG pricing/policy acceptance, signer capability, local integration and a verified sponsored transaction. Do not discover credentials, create provider policies, sign delegations or submit financial transactions as verification. Record exact prerequisites and remaining uncertainty in project documentation.
