# Clear Signing development kit

Development descriptors for Rebalance's **Simple7702Account → exact ERC20 approvals → Uniswap SwapRouter02 deadline multicall → ordered exact-input swaps** on Robinhood chain 4663. These files do not enable production Clear Signing or change the running application. They prepare the metadata and reproducible checks needed for a future Ledger integration review.

Three descriptors cover the current app's function surfaces. The token descriptor lists the nine public asset addresses already in `src/assets.ts`. The account descriptor binds the canonical Simple7702 implementation, **never a user's wallet**. Calibur remains a separate execution option; it is not an inner contract call and has no descriptor in this kit.

## Run the offline display checks

From the repository root, with the main project's locked dependencies installed:

```sh
npm --prefix clear-signing ci --ignore-scripts --no-audit --no-fund
npm --prefix clear-signing test
npm --prefix clear-signing run preview
npm test -- tests/clear-signing-artifacts.test.ts
```

Installation needs network access; rendering and tests run offline. The isolated package pins `@ethereum-sourcify/clear-signing` **0.2.2** (MIT) and viem **2.56.3** (MIT); its lockfile pins transitive dependencies. These are development dependencies in a separate package, not additions to the live signer or chart.

`fixtures.mjs` uses actual public contract identities with an invented wallet, amounts, fees and expiry. It reads no local portfolio state, device or keys. `preview` prints a labelled software rendering, not a signed transaction or a device screenshot. Tests verify four approvals and four ordered swaps, exact decimal amounts, minimum outputs, recipients, spender, pool fee, expiry, native values and price limit. Unknown contracts/selectors/chains and missing token metadata remain warnings even below a readable outer wrapper.

The generic renderer does not resolve EIP-7702 delegation. The full-batch test explicitly adds a synthetic account binding **in memory only**, preserving the actual transaction recipient in the display. Without this modelling option, lookup of the synthetic EOA correctly returns `NO_DESCRIPTOR`. This models formatting after resolution; it does not prove authenticated proxy resolution in Ledger. The published descriptor stays bound only to the implementation. Mock token names/decimals are labelled fixture data, not Ledger-certified metadata.

## Validate schema, application ABI and Ledger conversion

Use Python 3.12 in a disposable environment, independent of the funded app:

```sh
python3.12 -m venv /tmp/rebalance-clear-signing-python
/tmp/rebalance-clear-signing-python/bin/pip install -r clear-signing/requirements-ledger.txt
/tmp/rebalance-clear-signing-python/bin/python scripts/ledger-clear-signing-validate.py
```

The validator uses the vendored, checksummed ERC-7730 v2 schema and `erc7730` **1.0.10**. It checks the current source ABI surfaces using pure viem parsing, runs the official v2 linter against those explicit local ABIs, and converts all deployments/selectors to Ledger's metadata representation. No on-chain deployment, explorer ABI or device trust is inferred from these checks.

There is one retained upstream linter warning for the tuple-array container `#.calls.[]`: the pinned linter includes that container in ABI coverage but ignores the group's root path while collecting its displayed children. Target, value and data are all displayed. The script requires that exact warning and rejects any others; it reports `passed_with_documented_linter_warning`, not an ordinary clean lint pass. Schema validation and conversion are separate results. See [descriptor provenance](descriptors/PROVENANCE.md).

## Emulator and production boundaries

See [the emulator workflow](emulator/README.md) for exact prerequisites and the observed result. Test-certificate rendering in Speculos is development evidence. It does not mirror the physical Ledger and must not be presented as footage of a real device approving these transactions.

Production remains gated on reviewed metadata, authenticated EIP-7702 implementation resolution, token metadata and service coverage for Robinhood, the integration's originToken, and a successful physical-device display check of the complete nested batch. The ordinary application already supplies an optional local `LEDGER_ORIGIN_TOKEN` to its Context Module. This kit never injects test metadata into that live context, bypasses warnings, changes physical-device trust, requests physical signatures or broadcasts. Its isolated emulator signs only fixed synthetic transactions with the public test seed. See [Ledger execution](../docs/LEDGER_EXECUTION.md).

The descriptors intentionally expose Uniswap's special input/recipient semantics: input zero may consume the router's token balance; recipient `1` means sender and `2` means router. Current Rebalance transactions use positive input amounts and a full wallet recipient. These special encodings are still described truthfully rather than hidden if tested independently.
