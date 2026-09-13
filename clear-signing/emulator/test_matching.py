"""Offline protocol regressions: Python stdlib plus the project's pure viem ABI encoder.

Run: python3 clear-signing/emulator/test_matching.py
No application module, wallet, emulator, RPC or metadata server is loaded.
"""
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
spec = importlib.util.spec_from_file_location('matching_compiler', HERE/'compile-matching.py')
compiler = importlib.util.module_from_spec(spec)
spec.loader.exec_module(compiler)


def decode_tlv(raw):
    result = []
    offset = 0
    while offset < len(raw):
        if offset + 2 > len(raw):
            raise ValueError('Truncated TLV header')
        tag, length = raw[offset:offset+2]
        if length >= 128 or offset + 2 + length > len(raw):
            raise ValueError('Truncated or unsupported TLV value')
        result.append((tag, raw[offset+2:offset+2+length]))
        offset += length + 2
    return result


def evaluate_guard(guard, calldata):
    """Decode wire bytes independently and evaluate against actual ABI calldata."""
    outer = dict(decode_tlv(bytes.fromhex(guard['descriptor'])))
    if outer[0] != b'\x01' or outer[2] != b'\x00' or outer[4] != b'\x01':
        raise ValueError('Not a mandatory RAW guard')
    value = dict(decode_tlv(dict(decode_tlv(outer[3]))[1]))
    if value[1] != b'\x01' or value[2] != b'\x20':
        raise ValueError('Not uint256')
    payload = bytes.fromhex(calldata[10:])
    offset = base = 0
    actual = None
    def read_word(index):
        chunk = payload[index*32:(index+1)*32]
        if len(chunk) != 32:
            raise ValueError('ABI path out of bounds')
        return int.from_bytes(chunk, 'big')
    for tag, item in decode_tlv(value[3]):
        if tag == 0:
            if item != b'\x01':
                raise ValueError('Unknown path version')
        elif tag == 1:
            base = offset
            offset += int.from_bytes(item, 'big')
        elif tag == 3:
            pointer = read_word(offset)
            if pointer > 65535 or pointer % 32:
                raise ValueError('Invalid ABI pointer')
            offset = base + pointer//32
        elif tag == 4 and item == b'\x03':
            actual = read_word(offset)
        else:
            raise ValueError('Unexpected path instruction')
    if actual is None:
        raise ValueError('Missing length word')
    return actual, actual == int.from_bytes(outer[5], 'big')


class MatchingContextTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = {kind: json.loads((HERE.parent/'descriptors'/f'calldata-{name}.json').read_text())
                      for kind, name in [('router','SwapRouter02'),('account','Simple7702Account')]}
        code = """
import {calls,batch,routerCall,swapParams} from './clear-signing/fixtures.mjs';
const rows=[];
for(let n=0;n<=6;n++) {
 rows.push({kind:'router',count:n,data:routerCall(Array.from({length:n},(_,i)=>swapParams[i%4])).data});
 rows.push({kind:'account',count:n,data:batch(Array.from({length:n},(_,i)=>calls[i%5])).data});
}
process.stdout.write(JSON.stringify(rows));
"""
        with tempfile.TemporaryDirectory(prefix='rebalance-matching-abi-',dir='/tmp') as temporary:
            environment = {**os.environ, 'REBALANCE_ROOT_DIR': temporary, 'REBALANCE_DATA_DIR': temporary,
                           'TMPDIR': temporary, 'TMP': temporary, 'TEMP': temporary}
            for name in ['REBALANCE_PRIVATE_KEY','REBALANCE_ALCHEMY_API_KEY','LEDGER_ORIGIN_TOKEN',
                         'REBALANCE_PROFILE_WALLET','REBALANCE_PROFILE_PINNED','REBALANCE_CHART_PORT',
                         'REBALANCE_SESSION_ID','CODEX_THREAD_ID','CLAUDE_CODE_SESSION_ID','NODE_OPTIONS','NODE_TEST_CONTEXT']:
                environment.pop(name,None)
            cls.cases = json.loads(subprocess.check_output(['node','--input-type=module','-e',code],
                                                          cwd=ROOT,text=True,env=environment))

    def test_actual_abi_lengths_require_exact_count(self):
        for case in self.cases:
            with self.subTest(kind=case['kind'],count=case['count']):
                expected = 4 if case['kind']=='router' else 5
                actual, accepted = evaluate_guard(compiler.count_guard(case['kind']),case['data'])
                self.assertEqual(actual,case['count'])
                self.assertEqual(accepted,case['count']==expected)

    def test_length_comes_from_signed_calldata_not_host_metadata(self):
        for kind, count, slot in [('router',4,1),('account',5,0)]:
            case = next(c for c in self.cases if c['kind']==kind and c['count']==count)
            raw = bytearray.fromhex(case['data'][10:])
            length_offset = int.from_bytes(raw[slot*32:(slot+1)*32],'big')
            raw[length_offset:length_offset+32] = (count+1).to_bytes(32,'big')
            guard = compiler.count_guard(kind)
            guard['param']['value']['value'] = count  # unrelated host data must not override wire
            actual, accepted = evaluate_guard(guard,case['data'][:10]+raw.hex())
            self.assertEqual(actual,count+1)
            self.assertFalse(accepted)

    def test_malformed_or_truncated_abi_pointer_rejected(self):
        for kind,count,slot in [('router',4,1),('account',5,0)]:
            case = next(c for c in self.cases if c['kind']==kind and c['count']==count)
            for pointer in [1,65536,65504]:
                raw=bytearray.fromhex(case['data'][10:])
                raw[slot*32:(slot+1)*32]=pointer.to_bytes(32,'big')
                with self.subTest(kind=kind,pointer=pointer), self.assertRaises(ValueError):
                    evaluate_guard(compiler.count_guard(kind),case['data'][:10]+raw.hex())
            with self.assertRaises(ValueError):
                evaluate_guard(compiler.count_guard(kind),case['data'][:10])

    def test_indexing_preserves_every_field_and_context_association(self):
        for kind,signature,count in [('router',compiler.ROUTER_SIGNATURE,4),('account',compiler.ACCOUNT_SIGNATURE,5)]:
            original=copy.deepcopy(self.source[kind])
            result=compiler.indexed_descriptor(self.source[kind],kind)
            self.assertEqual(self.source[kind],original)
            before=original['display']['formats'][signature]['fields']
            after=result['display']['formats'][signature]['fields']
            self.assertEqual(after[:len(before)-1],before[:-1])
            if kind=='router':
                for i,field in enumerate(after[4:]):
                    expected=copy.deepcopy(before[-1]);expected['path']=f'data.[{i}]'
                    self.assertEqual(field,expected)
                self.assertEqual(len(after),8)
                for method,form in original['display']['formats'].items():
                    if method!=signature:
                        self.assertEqual(result['display']['formats'][method],form)
            else:
                for i in range(count):
                    for j,child in enumerate(before[-1]['fields']):
                        expected=copy.deepcopy(child);expected['path']=f'calls.[{i}].'+child['path']
                        if j==2:
                            expected['params']['calleePath']=f'calls.[{i}].target'
                            expected['params']['amountPath']=f'calls.[{i}].value'
                        self.assertEqual(after[2+i*3+j],expected)
                self.assertEqual(len(after),17)

    def test_changed_associations_or_external_references_fail_closed(self):
        changed=copy.deepcopy(self.source['router'])
        changed['display']['formats'][compiler.ROUTER_SIGNATURE]['fields'][-1]['params']['spenderPath']='@.to'
        with self.assertRaises(ValueError): compiler.indexed_descriptor(changed,'router')
        changed=copy.deepcopy(self.source['account'])
        changed['display']['formats'][compiler.ACCOUNT_SIGNATURE]['fields'][-1]['fields'].pop(1)
        with self.assertRaises(ValueError): compiler.indexed_descriptor(changed,'account')
        changed=copy.deepcopy(self.source['router']);changed['includes']='https://example.com/descriptor.json'
        with self.assertRaises(ValueError): compiler.indexed_descriptor(changed,'router')
        with self.assertRaises(ValueError): compiler.count_guard('unknown')

    def test_output_boundaries_reject_unsafe_or_existing_paths(self):
        with self.assertRaises(ValueError): compiler.checked_paths('relative','/tmp')
        with self.assertRaises(ValueError): compiler.checked_paths('/tmp','/tmp')
        with tempfile.TemporaryDirectory(prefix='rebalance-matching-test-',dir='/tmp') as temporary:
            output=Path(temporary)/'matching-test-context.json';output.write_text('retain existing')
            with self.assertRaises(ValueError): compiler.checked_paths('/tmp',temporary)
            self.assertEqual(output.read_text(),'retain existing')


if __name__=='__main__':
    unittest.main()
