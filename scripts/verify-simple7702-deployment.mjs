// Reproduce the pinned public Simple7702Account artifact and simulate its
// CREATE2 deployment. Read-only public RPC only: no signer, wallet, broadcast,
// application configuration, credentials or portfolio data are loaded.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { getContractAddress, keccak256, toHex } from 'viem';

assert.equal(process.argv.length, 2, 'Usage: node scripts/verify-simple7702-deployment.mjs');
const artifact = JSON.parse(await readFile(new URL('../src/artifacts/simple7702.json', import.meta.url), 'utf8'));
const evidence = JSON.parse(await readFile(new URL('../docs/evidence/simple7702-deployment.json', import.meta.url), 'utf8'));
const digest = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('hex');
const download = async url => {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  assert.equal(response.status, 200, url);
  return Buffer.from(await response.arrayBuffer());
};
const temp = await mkdtemp('/tmp/rebalance-simple7702-verify-');
try {
  const source = artifact.source;
  const bytes = await download(`https://raw.githubusercontent.com/${source.repository}/${source.commit}/${source.artifactPath}`);
  const gitBlob = digest('sha1', Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]));
  assert.equal(gitBlob, source.gitBlobSha, 'pinned official deployment artifact Git blob');
  const upstream = JSON.parse(bytes.toString('utf8'));
  assert.equal(upstream.address, artifact.address);
  assert.equal(upstream.receipt.to.toLowerCase(), artifact.factoryAddress.toLowerCase());
  assert.deepEqual(upstream.args, [], 'canonical deployment takes no constructor arguments');
  assert.equal(upstream.bytecode, artifact.initCode);
  assert.equal(upstream.deployedBytecode, artifact.runtimeBytecode);
  const metadata = JSON.parse(upstream.metadata);
  const sources = {};
  for (const [path, entry] of Object.entries(metadata.sources)) {
    assert.equal(typeof entry.content, 'string', `literal source ${path}`);
    assert.equal(entry.license, 'MIT');
    assert.equal(keccak256(toHex(entry.content)), entry.keccak256, path);
    const retained = evidence.sourceManifest.find(item => item.path === path);
    assert.equal(retained?.keccak256, entry.keccak256, `retained source ${path}`);
    sources[path] = { content: entry.content };
  }
  assert.equal(Object.keys(sources).length, 20);
  assert.equal(metadata.compiler.version, evidence.compiler.version);
  assert.deepEqual(metadata.settings, evidence.compiler.settings);
  const compilerBytes = await download(evidence.compiler.url);
  assert.equal('0x' + digest('sha256', compilerBytes), evidence.compiler.sha256, 'official compiler checksum');
  const compilerPath = join(temp, 'soljson.cjs');
  await writeFile(compilerPath, compilerBytes);
  const compiler = createRequire(import.meta.url)(compilerPath);
  assert.ok(compiler.cwrap('solidity_version', 'string', [])().startsWith(evidence.compiler.version));
  const { compilationTarget, ...settings } = metadata.settings;
  settings.outputSelection = { '*': { '*': ['abi', 'evm.bytecode', 'evm.deployedBytecode', 'storageLayout'] } };
  const output = JSON.parse(compiler.cwrap('solidity_compile', 'string', ['string', 'number', 'number'])(
    JSON.stringify({ language: 'Solidity', sources, settings }), 0, 0));
  assert.deepEqual((output.errors ?? []).filter(error => error.severity === 'error'), []);
  const [[path, name]] = Object.entries(compilationTarget);
  const compiled = output.contracts[path][name];
  assert.equal('0x' + compiled.evm.bytecode.object, artifact.initCode, 'complete reproduced initcode');
  assert.equal('0x' + compiled.evm.deployedBytecode.object, artifact.runtimeBytecode, 'complete reproduced runtime');
  assert.deepEqual(compiled.abi, upstream.abi);
  assert.deepEqual(compiled.evm.deployedBytecode.immutableReferences, {});
  assert.deepEqual(compiled.storageLayout.storage, []);
  assert.equal(keccak256(artifact.runtimeBytecode), artifact.runtimeCodeHash);
  assert.equal((artifact.runtimeBytecode.length - 2) / 2, artifact.runtimeSize);
  assert.equal(keccak256(artifact.initCode), artifact.initCodeHash);
  assert.equal(artifact.salt, '0x' + '00'.repeat(32));
  assert.equal(artifact.deploymentCalldata, artifact.salt + artifact.initCode.slice(2));
  assert.equal(getContractAddress({ from: artifact.factoryAddress, opcode: 'CREATE2', salt: artifact.salt,
    bytecode: artifact.initCode }).toLowerCase(), artifact.address.toLowerCase());
  const rpcUrl = evidence.robinhoodObservation.rpcUrl;
  const rpc = async (method, params) => {
    assert.ok(['eth_chainId', 'eth_blockNumber', 'eth_getCode', 'eth_call', 'eth_estimateGas'].includes(method), 'read-only RPC method');
    const response = await fetch(rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30_000) });
    assert.equal(response.status, 200);
    const result = await response.json(); assert.equal(result.error, undefined);
    return result.result;
  };
  assert.equal(await rpc('eth_chainId', []), '0x1237');
  const block = await rpc('eth_blockNumber', []);
  const [factoryCode, accountCode] = await Promise.all([
    rpc('eth_getCode', [artifact.factoryAddress, block]), rpc('eth_getCode', [artifact.address, block]),
  ]);
  assert.equal(factoryCode, artifact.factoryRuntimeBytecode, 'complete Robinhood factory runtime');
  assert.equal(keccak256(factoryCode), artifact.factoryRuntimeCodeHash);
  let simulation = null;
  if (accountCode === '0x') {
    const from = '0x000000000000000000000000000000000000bEEF';
    const tx = { from, to: artifact.factoryAddress, value: '0x0', data: artifact.deploymentCalldata };
    const overrides = { [from]: { balance: '0xde0b6b3a7640000' } };
    const [result, gas] = await Promise.all([
      rpc('eth_call', [tx, block, overrides]), rpc('eth_estimateGas', [tx, block, overrides]),
    ]);
    assert.equal(result.toLowerCase(), artifact.address.toLowerCase());
    simulation = { from, fixtureBalanceOverride: overrides[from].balance, result, gas, broadcast: false };
  } else {
    assert.equal(accountCode, artifact.runtimeBytecode, 'already deployed implementation must match exactly');
  }
  console.log(JSON.stringify({ verifiedAt: new Date().toISOString(), sourceCommit: source.commit, sourceFiles: 20,
    compiler: evidence.compiler.version, exactCompilation: true, address: artifact.address, runtimeCodeHash: artifact.runtimeCodeHash,
    runtimeSize: artifact.runtimeSize, factoryCodeHash: artifact.factoryRuntimeCodeHash, block,
    alreadyDeployed: accountCode !== '0x', simulation }, null, 2));
} finally { await rm(temp, { recursive: true, force: true }); }
