# Ledger emulator preparation

This development workflow runs the public Ethereum app in Speculos, using its default public test seed. It never connects to physical hardware, imports Rebalance application state, changes device settings or broadcasts a transaction. Emulator startup is separate from Clear Signing verification.

The checked-in [launcher](../../scripts/ledger-clear-signing-emulator.mjs) uses only Node built-ins and Docker. Its default model is `apex_p` (Apex+/Nano Gen5); `nanox` is available for a second model. The [manifest](manifest.json) pins the public image and ELF checksums. Public upstream code retains its Apache-2.0 license.

From the repository root:

```sh
emulator_dir=$(mktemp -d /tmp/rebalance-ledger-emulator.XXXXXX)
node scripts/ledger-clear-signing-emulator.mjs prepare --work-dir "$emulator_dir" --model apex_p
node scripts/ledger-clear-signing-emulator.mjs preflight --work-dir "$emulator_dir" --model apex_p
node scripts/ledger-clear-signing-emulator.mjs smoke --work-dir "$emulator_dir" --model apex_p
```

`prepare` downloads the checksum-verified public ELF and pinned official Docker image. `preflight` checks availability. `smoke` creates a fresh container, copies only the ELF, binds the API to loopback, reads app metadata, captures its startup screen and removes that exact container in `finally`. It passes no seed or wallet/provider credentials. There are no host filesystem, USB or Docker-socket mounts. Outputs stay in the explicit temporary directory. The original Nano S is outside this workflow.

The smoke result deliberately includes `clearSigningVerified: false`. A successful startup does not establish a complete transaction display or retail-device compatibility. The actual device model, firmware, Ethereum app, production metadata, origin token and proxy support must still be verified separately.

For descriptor display tests, Ledger's [official tester](https://github.com/LedgerHQ/device-sdk-ts/tree/21debb71425117964b8c7001070a6ca8d1a9b2da/apps/clear-signing-tester) uses `--erc7730-files` and test CAL mode. At this source revision its CLI provisions remote Speculinho infrastructure; it is not a local Docker runner. The same repository's [local sample converter](https://github.com/LedgerHQ/device-sdk-ts/blob/21debb71425117964b8c7001070a6ca8d1a9b2da/apps/sample/api/index.py) can compile these JSON descriptors and create emulator-only test signatures/certificates. Never feed those test signatures to the production signer.

The Simple7702 descriptor binds to the implementation address. Rebalance's real transaction targets the delegated wallet itself. A direct implementation-target fixture can test the nested parser, but it cannot prove Ledger's signed EIP-7702 proxy resolution on Robinhood. A copied or locally aliased descriptor must always be labelled as a fixture; it is not production delegation proof.

## View and screenshot the emulator

Speculos provides its own browser interface at the mapped API origin, for example `http://127.0.0.1:19501/`. It displays the actual emulated device screen and left/both/right buttons. `http://127.0.0.1:19501/screenshot` returns the current device PNG without browser controls. This native view was opened and visually checked with the pinned Nano X app; no custom or reconstructed device UI is used. See the [official WebUI/API documentation](https://speculos.ledger.com/user/api.html).

For a still review, run the fixed fixture with `--manual-review` and use the browser buttons at your own pace. That mode sends no automatic button presses and expires after ten minutes. Caption screenshots or footage **“Speculos emulator · development test metadata”**. They do not show the physical Ledger, production-trusted metadata, a funded portfolio or an on-chain transaction.

Keep one container at a time. The resumed local screenshot session used a 2 GiB Colima VM and a container limited to 512 MiB RAM/one CPU; the container measured approximately 107 MiB after startup. These are one measured setup, not a general resource guarantee. Stop only the exact owned container when finished; an existing VM may host unrelated work and must not be stopped merely because it also hosted this emulator.

## Reproduce a synthetic descriptor test

The development [compiler](compile.py) and [Nano X injector](inject.cjs) preserve the local test path. The compiler verifies the pinned upstream checkout, rejects modifications to the imported converter, and creates test-signed contract, token and chain-4663 network context. The injector accepts only the fixed [fixtures](../fixtures.mjs), validates the exact labeled container/image and loopback mapping, and refuses basic/blind-signing APDUs before sending them. It never accepts a raw transaction, private key or real wallet argument.

The injector currently supports Nano X. Apex+/Nano Gen5 startup was verified with Ethereum 1.22.3 ([result](evidence/apex_p-smoke.json), [screen](evidence/apex_p-startup.png)); transaction display on that model remains unverified. Have the project's pinned `viem@2.56.3` installed before importing its pure fixture module. The isolated Node [package lock](package-lock.json) and Python [requirements lock](requirements.lock) pin the additional development dependencies.

```sh
emulator_dir=$(mktemp -d /tmp/rebalance-ledger-injection.XXXXXX)
cp clear-signing/emulator/package.json clear-signing/emulator/package-lock.json "$emulator_dir/"
npm ci --prefix "$emulator_dir" --ignore-scripts --no-audit --no-fund
python3.12 -m venv "$emulator_dir/python"
"$emulator_dir/python/bin/pip" install -r clear-signing/emulator/requirements.lock
git clone --filter=blob:none https://github.com/LedgerHQ/device-sdk-ts.git "$emulator_dir/device-sdk-ts"
git -C "$emulator_dir/device-sdk-ts" checkout --detach 21debb71425117964b8c7001070a6ca8d1a9b2da
"$emulator_dir/python/bin/python" clear-signing/emulator/compile.py "$emulator_dir/device-sdk-ts" "$emulator_dir"
node scripts/ledger-clear-signing-emulator.mjs prepare --work-dir "$emulator_dir" --model nanox

container_id=$(docker create --label rebalance.emulator=public-test-only \
  --cap-drop ALL --security-opt no-new-privileges --memory 512m --cpus 1 \
  --publish 127.0.0.1:19501:5000 \
  ghcr.io/ledgerhq/speculos@sha256:6ed9eefd51cddd862b746719af4cd7a3265fe43d0588c388359753cab8d46d11 \
  --display headless --api-port 5000 --model nanox /speculos/rebalance-app.elf)
trap 'docker rm --force "$container_id" >/dev/null' EXIT
docker cp "$emulator_dir/app-1.22.3-nanox.elf" "$container_id:/speculos/rebalance-app.elf"
docker start "$container_id"
node clear-signing/emulator/inject.cjs --work-dir "$emulator_dir" \
  --container-id "$container_id" --speculos-url http://127.0.0.1:19501 --fixture approval
```

Choose `approval`, `swap`, `router` or `batch`; each run saves screen text, screenshot PNGs, protocol status words and its outcome to a newly created temporary result directory. Keep only one emulator container running at a time. Restart that exact container between cases and wait for startup before injecting again, so each review begins with fresh device state. A completed signature is recorded separately from exact ordered screen assertions. The checker compares every displayed contract, token, amount, recipient, spender, fee, deadline and other descriptor field against the fixed fixture. Failures, missing or out-of-order fields, and incomplete runs exit nonzero. The synthetic batch targets the implementation directly, so it cannot establish actual EIP-7702 account/proxy support.

The initial [Nano X diagnostic](evidence/nanox-approval-diagnostic.json) records a failed fixture before network context was included: generic transaction info and its PKI certificate were accepted, while token info returned `6a80` and the dependent amount field returned `6980`. The app rejects token metadata for an unrecognized chain before signature validation; chain 4663 required the added dynamic-network fixture. The old prototype cancelled fallback late enough for a second, rejected basic-signing APDU to appear in that historical trace. The preserved injector blocks that command before dispatch. No signature or production compatibility was established by that initial attempt.

For an interactive screenshot session, append `--manual-review` to the injector invocation. This mode captures screens but never presses an emulator button automatically. Use the loopback Speculos viewer to navigate the public synthetic fixture. Review expires after ten minutes, or press Ctrl-C to cancel sooner; automatic tests have a four-minute limit. Cancellation and incomplete manual reviews exit nonzero and retain their captured evidence. Never enable blind signing to bypass a failed fixture.

## Original array-descriptor results

With Ethereum 1.22.3 on the pinned Nano X emulator, the synthetic USDG approval completed generic signing and passed all six ordered fields. The direct AAPL-to-USDG swap completed generic signing and passed all thirteen ordered fields. These checks used the emulator’s public default seed and locally test-signed metadata, including Robinhood network metadata; they establish synthetic device display behavior only. The saved swap capture was rechecked after teaching the validator the exact “Swap exact input” introduction screen.

Actual screenshots: [8 USDG approval](evidence/nanox-approval-amount.png), [0.01 AAPL swap input](evidence/nanox-swap-input.png), and [2 USDG minimum received](evidence/nanox-swap-minimum.png). Sanitized [approval evidence](evidence/nanox-approval.json) and [swap evidence](evidence/nanox-swap.json) retain ordered screen checks and protocol status words, without signature payloads.

The four-swap router multicall did not reach review or produce a signature. Its nested calldata field returned `6a80`, generic review start returned `6980`, and the harness refused blind-signing fallback. See the [actual failure evidence](evidence/nanox-router-failure.json) and [source-level nested-array limitation](evidence/nested-array-limitation.md). The full Simple7702 batch was not tested with that original array-descriptor variant. The separate matching-context experiment below subsequently verified a guarded fixed-count variant. Production metadata trust, retail-device display, and actual EIP-7702 wallet/proxy resolution remain unverified; no runtime Clear Signing capability is enabled by these results.

## Verified fixed matching-context experiment

The user's matching-context proposal resolved the nested cardinality failure for the fixed public fixture. A separate [development compiler](compile-matching.py) emits one context per indexed call, then adds a signed binary `MUST_BE` guard requiring exactly four router swaps and five outer account calls. Every original target, value, caller, amount, minimum, fee, recipient and expiry field remains. This is a custom compiler extension using the pinned app's existing protocol; the original ERC-7730 descriptors and production signer stay unchanged. See [protocol details, pins and limitations](MATCHING_CONTEXT.md).

Actual Nano X results with the public default seed and test certificates:

| Fixed fixture | Observed outcome |
| --- | --- |
| Router, four swaps | Generic signature completed; all **54** ordered fields and transaction-type sections verified |
| Simple7702, five calls including that router | Both count guards accepted; generic signature completed; all **87** ordered fields and sections verified |
| Router, three swaps; account, four calls | Rejected during SDK context construction, before transaction context was sent; no review or signature |
| Router, five swaps; account, six calls | First signed count-guard field rejected by device (`6a80`); generic start rejected (`6980`), blind fallback refused; no review or signature |

The [guarded router capture](evidence/matching-guarded-router.json), [guarded batch capture](evidence/matching-guarded-batch.json), and [four negative captures](evidence/matching-count-refusals.json) preserve actual screen text and APDU headers/statuses, without raw transaction or signature payloads. Actual batch PNGs show [the batch introduction](evidence/matching-batch-intro.png), [8 USDG approval](evidence/matching-batch-usdg-approval.png), [implementation caller](evidence/matching-batch-router-caller.png), and [0.04 AMD minimum](evidence/matching-batch-amd-minimum.png). The prior unguarded indexed captures retain their original checker failures; [separate derived checks](evidence/matching-indexed-checks.json) verify the newly observed transaction-type sections without rewriting that history.

After the ordinary compiler has created `compiled-test-context.json`, use the same isolated work directory and exact owned Nano X container:

```sh
"$emulator_dir/python/bin/python" clear-signing/emulator/compile-matching.py \
  "$emulator_dir/device-sdk-ts" "$emulator_dir"
node clear-signing/emulator/inject.cjs --work-dir "$emulator_dir" \
  --container-id "$container_id" --speculos-url http://127.0.0.1:19501 \
  --fixture batch --matching-context
```

Restart only that exact container between cases. Positive fixture names are `router` and `batch`; negative fixture names are `router-missing-call`, `router-extra-call`, `batch-missing-call`, and `batch-extra-call`. Negatives require `--matching-context`, use only fixed synthetic calldata, and cannot use manual review. Their exit code is zero only when the expected rejection boundary is observed with no review or signature; the result retains its refusal status and distinguishes SDK rejection from device guard enforcement. A successful generic signing APDU can never count as a passed negative test. Positive/manual runs retain the usual signature and complete-display requirements.

Run the offline regressions with `node --test clear-signing/test/*.test.mjs` and `python3 clear-signing/emulator/test_matching.py`. These include replay of both actual guarded positive captures, all four negative captures, altered/reordered section checks and independent ABI/count-guard tests.

Only the fixed four-swap/five-call variants are packaged. General batch-length variant selection, authenticated EIP-7702 resolution, Ledger production metadata approval/distribution, and physical-device display remain unverified. The batch addresses the implementation directly; its displayed implementation caller must not be presented as proof of a real delegated-wallet path. No runtime Clear Signing feature is enabled.
