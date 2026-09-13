"""Isolated Speculos metadata preparation using Ledger's public test converter."""
import importlib.util
import json
import pathlib
import sys
import subprocess

if len(sys.argv) != 3:
    raise SystemExit('Usage: compile.py /absolute/pinned/device-sdk-checkout /absolute/tmp/work-dir')
if not all(pathlib.Path(value).is_absolute() for value in sys.argv[1:]):
    raise SystemExit('Checkout and work directory must be explicit absolute paths')
sdk = pathlib.Path(sys.argv[1]).resolve()
root = pathlib.Path(__file__).resolve().parents[1]
out = pathlib.Path(sys.argv[2]).resolve()
if not out.is_relative_to(pathlib.Path('/tmp').resolve()) or out == pathlib.Path('/tmp').resolve():
    raise SystemExit('Use an explicit isolated work directory inside /tmp')
commit = subprocess.check_output(['git','-C',str(sdk),'rev-parse','HEAD'], text=True).strip()
if commit != '21debb71425117964b8c7001070a6ca8d1a9b2da':
    raise SystemExit('The official tester checkout does not match the pinned revision')
subprocess.check_call(['git','-C',str(sdk),'diff','--exit-code','HEAD','--','apps/sample/api/index.py'], stdout=subprocess.DEVNULL)
spec = importlib.util.spec_from_file_location('ledger_sample_converter', sdk / 'apps/sample/api/index.py')
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)
descriptors = {}
with api.app.test_client() as client:
    for path in sorted((root / 'descriptors').glob('*.json')):
        result = client.post('/api/process-erc7730-descriptor', json=json.loads(path.read_text()))
        if result.status_code != 200:
            print(json.dumps({'file': path.name, 'status': result.status_code, 'error': result.get_json()}))
            sys.exit(1)
        for key, value in result.get_json()['descriptors'].items():
            descriptors[key] = value
    result = client.get('/api/certificates')
    if result.status_code != 200:
        print(json.dumps({'stage':'certificates','status':result.status_code,'error':result.get_json()}))
        sys.exit(1)
    certificates = result.get_json()
tokens = {}
for symbol, address, decimals in [
    ('USDG','5fc5360d0400a0fd4f2af552add042d716f1d168',6),
    ('AAPL','af3d76f1834a1d425780943c99ea8a608f8a93f9',18),
    ('NVDA','d0601ce157db5bdc3162bbaC2a2c8af5320d9eec',18),
    ('MSFT','e93237c50d904957cf27e7b1133b510c669c2e74',18),
    ('AMD','86923f96303d656e4aa86d9d42d1e57ad2023fdc',18),
]:
    data = symbol.encode().hex() + address.lower() + decimals.to_bytes(4,'big').hex() + (4663).to_bytes(4,'big').hex()
    tokens['0x'+address.lower()] = [{'descriptor':api.sign_payload(data)}]
# app-ethereum network TLV: type08, version01, EVM01, chainId u64, name, ticker.
# Independently checked against the pinned app-ethereum parser; emulator signatures only.
network_data = '01010802010151010123080000000000001237520f526f62696e686f6f6420436861696e2403455448'
network_descriptor = {'descriptorType':'network','descriptorVersion':'v1',**api.sign_payload(network_data)}
networks = {'4663':[{'id':'robinhood-chain-4663-emulator-fixture','descriptors':{'nanox':network_descriptor,'apexp':network_descriptor}}]}
target = out / 'compiled-test-context.json'
with target.open('x') as output:
    output.write(json.dumps({'scope':'emulator-only; test signatures; no production trust', 'descriptors':descriptors,'certificates':certificates,'tokens':tokens,'networks':networks}))
print(json.dumps({'compiledContracts':len(descriptors),'certificateCount':len(certificates),'tokens':len(tokens),'output':str(target)}))
