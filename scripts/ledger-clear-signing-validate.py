#!/usr/bin/env python3
"""Offline development validation; does not certify descriptors or contact a signer.

Install the pinned requirements into an isolated Python 3.12 environment and run
this file from any directory. Node and the repository's installed viem are needed
only to read the ABIs used by the current application. No application module loads.
"""
import contextlib
import hashlib
import importlib.metadata
import io
import json
from pathlib import Path
import subprocess
import sys

EXPECTED_VERSION = '1.0.10'
SCHEMA_SHA256 = '999c1e7366d58cb10d207a7396331e990a0d9f40f0b8b269c6bab4df78682dc1'
ROOT = Path(__file__).resolve().parent.parent
DESCRIPTORS = ROOT / 'clear-signing' / 'descriptors'

# Only source text and viem's pure ABI utilities are loaded. These are the three
# exact function surfaces used by Rebalance, not an assertion of full-contract ABI
# coverage or fresh on-chain implementation/metadata verification.
ABI_READER = r'''
import { readFileSync } from 'node:fs';
import { parseAbi, erc20Abi } from 'viem';
const source = path => readFileSync(path, 'utf8');
const find = (text, pattern) => {
  const match = text.match(pattern);
  if (!match) throw new Error('Application ABI source was not found');
  return Array.from(match[1].matchAll(/["'](function [^"']+)["']/g), m => m[1]);
};
console.log(JSON.stringify({
 Simple7702Account: parseAbi(find(source('src/simple7702.ts'), /SIMPLE7702_ABI = parseAbi\(\[([^]*?)\]\)/)),
 SwapRouter02: parseAbi(find(source('src/chain.ts'), /const ROUTER_ABI = parseAbi\(\[([^]*?)\]\)/)),
 RebalanceERC20: erc20Abi.filter(x => x.type === 'function' && x.name === 'approve'),
}));
'''


def require_self_contained(value):
    """Reject includes and external references before upstream resolution."""
    if isinstance(value, dict):
        if 'includes' in value:
            raise ValueError('This offline kit does not resolve descriptor includes')
        reference = value.get('$ref')
        if reference is not None and (not isinstance(reference, str) or
                                      not reference.startswith(('#', '$.'))):
            raise ValueError('External descriptor references are forbidden in this offline kit')
        for child in value.values():
            require_self_contained(child)
    elif isinstance(value, list):
        for child in value:
            require_self_contained(child)


def main():
    version = importlib.metadata.version('erc7730')
    if version != EXPECTED_VERSION:
        raise ValueError(f'Expected erc7730 {EXPECTED_VERSION}, found {version}')
    from jsonschema import Draft202012Validator
    from pydantic import TypeAdapter
    from erc7730.common import client
    from erc7730.common.abi import function_to_selector
    from erc7730.common.output import ListOutputAdder
    from erc7730.convert.calldata.convert_erc7730_v2_input_to_calldata import erc7730_v2_descriptor_to_calldata_descriptors
    from erc7730.lint.v2.lint import lint_all
    from erc7730.model.abi import ABI
    from erc7730.model.input.v2.descriptor import InputERC7730Descriptor

    schema_bytes = (ROOT / 'clear-signing/schema/erc7730-v2.schema.json').read_bytes()
    if hashlib.sha256(schema_bytes).hexdigest() != SCHEMA_SHA256:
        raise ValueError('Pinned ERC-7730 schema checksum mismatch')
    validator = Draft202012Validator(json.loads(schema_bytes))
    result = subprocess.run(['node', '--input-type=module', '-e', ABI_READER], cwd=ROOT,
                            check=True, capture_output=True, text=True)
    source_abis = json.loads(result.stdout)
    by_address = {}
    by_file = {}
    paths = []
    for name, abi in source_abis.items():
        path = DESCRIPTORS / f'calldata-{name}.json'
        descriptor = json.loads(path.read_text())
        require_self_contained(descriptor)
        validator.validate(descriptor)
        # The upstream model requires output names; viem's standard approve ABI
        # omits its unused bool output name. This does not modify inputs/selectors.
        for entry in abi:
            for output in entry.get('outputs', []):
                output.setdefault('name', '')
        parsed = TypeAdapter(list[ABI]).validate_python(abi, strict=False)
        by_file[path] = (descriptor, {str(function_to_selector(f)) for f in parsed})
        for d in descriptor['context']['contract']['deployments']:
            if d['chainId'] != 4663:
                raise ValueError(f'Unexpected descriptor chain: {d["chainId"]}')
            key = (4663, d['address'].lower())
            if key in by_address:
                raise ValueError(f'Duplicate descriptor binding: {key}')
            by_address[key] = parsed
        paths.append(path)

    def local_abi(chain_id, address):
        key = (chain_id, str(address).lower())
        if key not in by_address:
            raise ValueError(f'No local application ABI for {key}')
        return by_address[key]

    # Upstream v2 lint has no offline flag: --skip-abi-validation is forwarded
    # only to its v1 branch in 1.0.10. Supply explicit local ABI reference data,
    # rather than silently dropping ABI validation or triggering a network fetch.
    client.get_contract_abis = local_abi
    client.get_contract_explorer_url = lambda *_: 'local application ABI (no chain lookup)'
    sink = ListOutputAdder()
    with contextlib.redirect_stdout(io.StringIO()):
        count = lint_all(paths, sink)
    known_warning = ('No display field is defined for path `#.calls.[]` in function '
                     '0x34fcd5be (see local application ABI (no chain lookup)).')
    warnings = [item for item in sink.outputs if item.level == item.Level.WARNING]
    known = [item for item in warnings
             if item.file == DESCRIPTORS / 'calldata-Simple7702Account.json'
             and item.title == 'Missing display field' and item.message == known_warning]
    # The pinned linter counts the tuple-array container as an ABI leaf, while
    # its field collector ignores the group's path and retains only its three
    # visible children. Keep the diagnostic; do not add a hidden/excluded field
    # or claim an ordinary lint pass. Any other diagnostic remains a failure.
    if count != len(paths) or sink.has_errors or len(known) != 1 or len(warnings) != 1:
        for item in sink.outputs:
            print(item.model_dump_json(), file=sys.stderr)
        raise ValueError('Unexpected official v2 lint diagnostics against the application ABI surfaces')

    summaries = []
    for path, (descriptor, selectors) in by_file.items():
        captured = io.StringIO()
        with contextlib.redirect_stdout(captured):
            records = erc7730_v2_descriptor_to_calldata_descriptors(InputERC7730Descriptor.load(path), chain_id=4663)
        if captured.getvalue().strip():
            raise ValueError(f'Ledger conversion emitted diagnostic output for {path.name}: {captured.getvalue()}')
        expected = {(d['address'].lower(), s) for d in descriptor['context']['contract']['deployments'] for s in selectors}
        observed = {(r.address.lower(), str(r.selector)) for r in records}
        if observed != expected or len(records) != len(expected):
            raise ValueError(f'Ledger conversion omitted/duplicated a binding or selector in {path.name}')
        def leaf_labels(fields):
            return [label for field in fields for label in (
                leaf_labels(field['fields']) if 'fields' in field else [field['label']])]
        from erc7730.common.abi import parse_signature
        expected_labels = {str(function_to_selector(parse_signature(signature))): leaf_labels(fmt['fields'])
                           for signature, fmt in descriptor['display']['formats'].items()}
        for record in records:
            if [field.name for field in record.fields] != expected_labels[str(record.selector)]:
                raise ValueError(f'Ledger conversion omitted or reordered fields for {record.selector}')
            for field in record.fields:
                if field.param.type == 'CALLDATA' and any(getattr(field.param, p) is None for p in ('callee', 'amount', 'spender')):
                    raise ValueError('Ledger conversion omitted nested call context')
            if record.chain_id != 4663 or record.network != 'robinhood':
                raise ValueError('Ledger conversion changed the Robinhood binding')
        summaries.append({'file': path.name, 'deployments': len(descriptor['context']['contract']['deployments']),
                          'selectors': sorted(selectors), 'ledgerRecords': len(records)})
    print(json.dumps({'status': 'passed_with_documented_linter_warning', 'knownLinterWarnings': [known_warning], 'erc7730': version, 'schemaSha256': SCHEMA_SHA256,
                      'abiReference': 'Current local application function surfaces; no remote ABI/deployment lookup',
                      'deviceTested': False, 'productionCertified': False, 'descriptors': summaries}, indent=2))


if __name__ == '__main__':
    main()
