"""Compile fixed synthetic matching-context metadata; never use in the live signer.

This development adapter expands the four-swap/five-call fixtures and adds
firmware-enforced ABI array-count guards using documented binary instructions.
It leaves the canonical ERC-7730 descriptors and upstream compiler unchanged.
"""
import argparse
import copy
import hashlib
import importlib.metadata
import importlib.util
import json
from pathlib import Path
import subprocess

SDK_REVISION = '21debb71425117964b8c7001070a6ca8d1a9b2da'
APP_REVISION = 'bc637f8986b3b1ec7e044daf7ecb3e832f24258b'
CONVERTER_VERSION = '1.0.10'
CONVERTER_SHA256 = 'e406c78a39a95410e03d51e1391ef38dce698521fe920c35ec8e6fb2565bb139'
PROTOCOL = 'rebalance-fixed-array-context-v1'
ROUTER_ADDRESS = '0xcaf681a66d020601342297493863e78c959e5cb2'
ACCOUNT_ADDRESS = '0x4cd241e8d1510e30b2076397afc7508ae59c66c9'
ROUTER_SIGNATURE = 'multicall(uint256 deadline,bytes[] data)'
ACCOUNT_SIGNATURE = 'executeBatch((address target,uint256 value,bytes data)[] calls)'


def require(condition, message):
    if not condition:
        raise ValueError(message)


def self_contained(value):
    if isinstance(value, dict):
        require('includes' not in value and '$ref' not in value,
                'Matching fixtures must be self-contained; includes/references are forbidden')
        for item in value.values():
            self_contained(item)
    elif isinstance(value, list):
        for item in value:
            self_contained(item)


def indexed_descriptor(source, kind):
    """Unroll only the known fixture arrays; preserve every display field."""
    require(kind in ('router', 'account'), 'Unknown matching fixture')
    self_contained(source)
    result = copy.deepcopy(source)
    expected_address = ROUTER_ADDRESS if kind == 'router' else ACCOUNT_ADDRESS
    bindings = result['context']['contract']['deployments']
    require(len(bindings) == 1 and bindings[0]['chainId'] == 4663 and
            bindings[0]['address'].lower() == expected_address, 'Unexpected fixture deployment')
    signature = ROUTER_SIGNATURE if kind == 'router' else ACCOUNT_SIGNATURE
    fields = result['display']['formats'][signature]['fields']
    if kind == 'router':
        require(len(fields) == 5 and [f.get('path') for f in fields] ==
                ['@.to', '@.from', '@.value', 'deadline', 'data.[]'], 'Unexpected router fields')
        nested = fields[-1]
        require(nested.get('format') == 'calldata' and nested.get('params') ==
                {'calleePath': '@.to', 'amountPath': '@.value', 'spenderPath': '@.from'},
                'Router context associations changed')
        expanded = []
        for index in range(4):
            item = copy.deepcopy(nested)
            item['path'] = f'data.[{index}]'
            expanded.append(item)
        fields[-1:] = expanded
    else:
        require(len(fields) == 3 and [f.get('path') for f in fields] ==
                ['@.to', '@.value', 'calls.[]'], 'Unexpected account fields')
        group = fields[-1]
        children = group['fields']
        require(group.get('iteration') == 'bundled' and [f.get('path') for f in children] ==
                ['target', 'value', 'data'], 'Account call fields changed')
        require(children[-1].get('format') == 'calldata' and children[-1].get('params') ==
                {'calleePath': 'target', 'amountPath': 'value', 'spenderPath': '@.to'},
                'Account context associations changed')
        expanded = []
        for index in range(5):
            prefix = f'calls.[{index}].'
            for child in children:
                item = copy.deepcopy(child)
                item['path'] = prefix + item['path']
                if item.get('format') == 'calldata':
                    item['params']['calleePath'] = prefix + 'target'
                    item['params']['amountPath'] = prefix + 'value'
                expanded.append(item)
        fields[-1:] = expanded
    return result


def tlv(tag, value):
    """The guard uses only one-byte tags/lengths; refuse any larger value."""
    if isinstance(value, str):
        value = value.encode('ascii')
    require(0 <= tag < 256 and len(value) < 128, 'Guard TLV exceeds its fixed encoding')
    return bytes([tag, len(value)]) + value


def count_guard(kind):
    require(kind in ('router', 'account'), 'Unknown matching fixture')
    head_slot, count = (1, 4) if kind == 'router' else (0, 5)
    # TUPLE selects the dynamic argument's ABI head. REF follows its encoded
    # offset from argument start. STATIC_LEAF reads the array's uint256 length.
    path = tlv(0, b'\x01') + tlv(1, head_slot.to_bytes(2, 'big')) + tlv(3, b'') + tlv(4, b'\x03')
    value = tlv(0, b'\x01') + tlv(1, b'\x01') + tlv(2, b'\x20') + tlv(3, path)
    param = tlv(0, b'\x01') + tlv(1, value)
    name = 'Exact array count'
    # FIELD RAW0; visibility MUST_BE1; integer constraint. These binary fields
    # are supported by the pinned firmware but absent from converter 1.0.10.
    wire = tlv(0, b'\x01') + tlv(1, name) + tlv(2, b'\x00') + tlv(3, param)
    wire += tlv(4, b'\x01') + tlv(5, count.to_bytes(32, 'big'))
    return {'version': 1, 'name': name, 'descriptor': wire.hex(), 'param': {
        'version': 1, 'type': 'RAW', 'value': {
            'version': 1, 'type': 'path', 'type_family': 'UINT', 'type_size': 32,
            'binary_path': {'version': 1, 'type': 'DATA', 'elements': [
                {'type': 'TUPLE', 'offset': head_slot}, {'type': 'REF'},
                {'type': 'LEAF', 'leaf_type': 'STATIC_LEAF'}]}}}}


def add_guard(descriptor, kind, sign_payload):
    from erc7730.model.calldata.v1.instruction import CalldataDescriptorInstructionTransactionInfoV1
    result = copy.deepcopy(descriptor)
    expected_count = 4 if kind == 'router' else 5
    require(len(result['fields']) == (8 if kind == 'router' else 17) and
            sum(f['param']['type'] == 'CALLDATA' for f in result['fields']) == expected_count,
            'Unexpected indexed descriptor cardinality')
    result['fields'].insert(0, count_guard(kind))
    info = result['transaction_info']
    info['hash'] = hashlib.sha3_256(b''.join(bytes.fromhex(f['descriptor']) for f in result['fields'])).hexdigest()
    unsigned = CalldataDescriptorInstructionTransactionInfoV1.model_validate(
        {key: value for key, value in info.items() if key != 'descriptor'})
    info['descriptor'] = sign_payload(unsigned.descriptor)
    return result


def checked_paths(sdk_text, work_text):
    require(Path(sdk_text).is_absolute() and Path(work_text).is_absolute(), 'Paths must be absolute')
    sdk, work = Path(sdk_text).resolve(), Path(work_text).resolve()
    temporary = Path('/tmp').resolve()
    require(work.is_dir() and work != temporary and work.is_relative_to(temporary),
            'Use an existing isolated work directory inside /tmp')
    require(not (work / 'matching-test-context.json').exists(), 'Matching output already exists')
    require(subprocess.check_output(['git', '-C', str(sdk), 'rev-parse', 'HEAD'], text=True).strip()
            == SDK_REVISION, 'SDK source pin mismatch')
    subprocess.run(['git', '-C', str(sdk), 'diff', '--exit-code', 'HEAD', '--', 'apps/sample/api/index.py'],
                   check=True, stdout=subprocess.DEVNULL)
    return sdk, work


def build(sdk, work, here):
    require(importlib.metadata.version('erc7730') == CONVERTER_VERSION, 'ERC-7730 version mismatch')
    import erc7730.convert.calldata.convert_erc7730_v2_input_to_calldata as converter
    require(hashlib.sha256(Path(converter.__file__).read_bytes()).hexdigest() == CONVERTER_SHA256,
            'ERC-7730 converter checksum mismatch')
    spec = importlib.util.spec_from_file_location('rebalance_matching_test_converter', sdk/'apps/sample/api/index.py')
    api = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(api)
    # Reuse already prepared public test certificates/token/network fixtures.
    # Do not call /api/certificates: that upstream endpoint fetches remote CAL.
    baseline = work/'compiled-test-context.json'
    require(baseline.resolve().parent == work and baseline.stat().st_size <= 4_194_304,
            'Baseline must be a bounded local synthetic context in this work directory')
    base = json.loads(baseline.read_text())
    require(base.get('scope') == 'emulator-only; test signatures; no production trust' and
            all(isinstance(base.get(k), dict) for k in ('descriptors', 'certificates', 'tokens', 'networks')),
            'Prepare the canonical synthetic test context first')
    summaries = []
    with api.app.test_client() as client:
        for kind, name, address, selector in [
            ('router', 'SwapRouter02', ROUTER_ADDRESS, '0x5ae401dc'),
            ('account', 'Simple7702Account', ACCOUNT_ADDRESS, '0x34fcd5be')]:
            path = here.parent/'descriptors'/f'calldata-{name}.json'
            source = json.loads(path.read_text())
            indexed = indexed_descriptor(source, kind)
            response = client.post('/api/process-erc7730-descriptor', json=indexed)
            require(response.status_code == 200, 'Indexed descriptor conversion failed')
            key = '4663:' + address
            converted = response.get_json()['descriptors']
            require(set(converted) == {key}, 'Converter changed fixture deployment')
            records = converted[key]
            require(len(records) == 1, 'Unexpected converted descriptor collection')
            selectors = records[0]['descriptors_calldata'][address]
            require(set(selectors) == ({selector, '0x04e45aaf'} if kind == 'router' else {selector}),
                    'Converter changed fixture selectors')
            guarded = add_guard(selectors[selector], kind, api.sign_payload)
            selectors[selector] = guarded
            base['descriptors'][key] = records
            summaries.append({'contract': name, 'selector': selector, 'count': 4 if kind == 'router' else 5,
                              'fieldCount': len(guarded['fields']), 'fieldHash': guarded['transaction_info']['hash'],
                              'sourceSha256': hashlib.sha256(path.read_bytes()).hexdigest()})
    base['scope'] = 'emulator-only; fixed matching-context fixtures; public test signatures; no production trust'
    base['matchingContext'] = {'version': 1, 'routerCallCount': 4, 'accountCallCount': 5,
                               'guardType': 'abi-array-length-must-be-v1',
                               'protocol': PROTOCOL, 'sdkRevision': SDK_REVISION, 'appRevision': APP_REVISION,
                               'erc7730Version': CONVERTER_VERSION, 'converterSha256': CONVERTER_SHA256,
                               'routerCount': 4, 'accountCount': 5, 'fixtures': summaries}
    output = work/'matching-test-context.json'
    with output.open('x') as handle:
        json.dump(base, handle)
    return {'output': str(output), 'matchingContext': base['matchingContext']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('sdk', help='Absolute pinned public device-sdk-ts checkout')
    parser.add_argument('work_dir', help='Existing isolated absolute /tmp directory')
    args = parser.parse_args()
    sdk, work = checked_paths(args.sdk, args.work_dir)
    print(json.dumps(build(sdk, work, Path(__file__).resolve().parent)))


if __name__ == '__main__':
    main()
