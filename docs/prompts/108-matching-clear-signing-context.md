# Matching Clear Signing contexts and router research

Date: 2026-09-13. This records a development-only follow-up; it is not financial activation or production metadata approval.

## Material user requests

- “how hard would universal router support be?”
- “and yeah check if they have meaningful v4 liquidity”
- “can you double check these answers and link me lines of code in the meanwhile” (Uniswap, Ledger and Privy submission descriptions)
- “why not clear signing for the full rebalance batch?”
- “can we not do matching context?”
- “you didn't give me line count?”

## Scope and decisions

Review current protocol integration and public code links. Read public Robinhood chain data to assess v4 stock/USDG liquidity; do not implement Universal Router, change routes or trade. Compare actual-size simulated quotes with current v3 routes and distinguish initialized pools, active liquidity and executable simulations from confirmed transactions. Preserve the owner's main-branch preference and disabled Tenjin integration.

Investigate whether matching per-call contexts can resolve the pinned Ledger nested-array rejection. Keep the existing production signer, application descriptors, funded wallets, device settings and trading processes unchanged. Use only the fixed public synthetic fixtures and test metadata in isolated Speculos. Leave the owner's existing viewer on port19501 intact; use one separate owned container on loopback19502, capped at512MiB/oneCPU, inside the existing VM, then remove that exact test container.

The proposed compatibility experiment expands the fixed four router swaps and five outer account calls into explicit indexed fields. All original caller, target, native value, token, amount, spender, recipient, expiry and minimum-output fields must remain associated with their call. Indexed fields alone cannot establish complete display for other array lengths. Add an authenticated firmware-enforced array-length guard before those fields, using the pinned app's supported RAW MUST_BE binary protocol; recompute the signed field hash and test-sign only through the existing pinned public emulator converter. This is a custom binary-protocol compiler extension, not ordinary stock ERC-7730 conversion.

Test the valid router4/account5 fixtures and reject router3/router5/account4/account6 before signature. Supporting arbitrary production lengths requires compatible signed-variant selection and remains separate. Retail metadata trust, actual EIP-7702 wallet/proxy resolution and production device display remain unverified even if a synthetic batch succeeds.

## Evidence and packaging plan

The first temporary indexed router and full-account fixtures completed synthetic generic signatures with54/54 and87/87 exact ordered fields respectively, including their newly observed transaction-type section screens. Preserve original captures and the strict derived checks; do not erase earlier array rejection or old-checker unknown-screen results.

After actual positive/negative guard verification, retain a separate development-only matching compiler/context output, fixed negative fixtures, strict screen assertions, sanitized evidence and pinned source provenance. Do not overwrite standard converter output or enable matching metadata in the runtime signer. Keep development and production claims explicit in the submission wording.

Codex used bounded reviewers for runtime integration/code links, public v4 discovery, descriptor/protocol feasibility and isolated emulator execution. The coordinator independently compared public quotes, inspected code/evidence and reviewed the guard and screen-checking boundaries. Actual final test results are recorded in the development kit and AI usage log when available.

## Verified outcome

Guarded router4 and account5 fixtures completed generic signatures with54/54 and87/87 exact ordered display fields. Router3/account4 were refused during SDK context construction; router5/account6 were refused by the first signed firmware count guard before review/signature. The separate loopback19502 test container was removed, leaving the original19501 viewer intact. Development tests passed24/24, protocol tests6/6 and application-conformance/isolation tests5/5. See the emulator README/evidence and AI usage log for exact provenance and remaining production limitations.
