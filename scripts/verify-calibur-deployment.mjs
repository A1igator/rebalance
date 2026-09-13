// Reproduce public Calibur deployment and fixture bytecode. No wallet, signer,
// project state, broadcast, deployment, environment credential or fork is used.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { keccak256, toHex } from 'viem';

const evidence = JSON.parse(await readFile(new URL('../docs/evidence/calibur-deployment.json', import.meta.url), 'utf8'));
const fixture = JSON.parse(await readFile(new URL('../tests/fixtures/calibur-mocks.json', import.meta.url), 'utf8'));
const fixtureSource = await readFile(new URL('../tests/fixtures/CaliburMocks.sol', import.meta.url), 'utf8');
const json = async url => { const response = await fetch(url, { signal: AbortSignal.timeout(30_000) }); assert.equal(response.status, 200, url); return response.json(); };
const digest = (algorithm, body) => createHash(algorithm).update(body).digest('hex');
const onlyFixtures = process.argv.slice(2).join(' ') === '--fixtures-only';
assert.ok(onlyFixtures || process.argv.length === 2, 'Usage: node scripts/verify-calibur-deployment.mjs [--fixtures-only]');
const temp = await mkdtemp('/tmp/rebalance-calibur-verify-');
try {
  const compilerResponse = await fetch(evidence.compiler.url, { signal: AbortSignal.timeout(30_000) });
  assert.equal(compilerResponse.status, 200);
  const compilerBytes = Buffer.from(await compilerResponse.arrayBuffer());
  assert.equal('0x' + digest('sha256', compilerBytes), evidence.compiler.sha256, 'official compiler checksum');
  const compilerPath = join(temp, 'soljson.cjs'); await writeFile(compilerPath, compilerBytes);
  const compiler = createRequire(import.meta.url)(compilerPath);
  assert.ok(compiler.cwrap('solidity_version', 'string', [])().startsWith(evidence.compiler.version));
  const compile = input => {
    const result = JSON.parse(compiler.cwrap('solidity_compile', 'string', ['string', 'number', 'number'])(JSON.stringify(input), 0, 0));
    assert.deepEqual((result.errors ?? []).filter(error => error.severity === 'error'), []);
    return result;
  };
  assert.equal(digest('sha256', fixtureSource), fixture.sourceSha256);
  const fixtureBuild = compile({ language: 'Solidity', sources: { [fixture.source]: { content: fixtureSource } }, settings: fixture.settings });
  for (const [name, expected] of Object.entries(fixture.contracts)) {
    const actual = fixtureBuild.contracts[fixture.source][name];
    assert.equal('0x' + actual.evm.deployedBytecode.object, expected.runtimeBytecode, `${name} fixture runtime`);
    assert.deepEqual(actual.abi, expected.abi, `${name} fixture ABI`);
  }
  if (!onlyFixtures) {
    const tag = await json(evidence.sources.releaseTag);
    assert.equal(tag.object.sha, evidence.sourceCommit, 'release tag commit');
    const verified = await json(evidence.sources.verifiedCompilerInput);
    assert.equal(verified.is_verified, true);
    const sources = Object.fromEntries([{ file_path: verified.file_path, source_code: verified.source_code }, ...verified.additional_sources]
      .map(source => [source.file_path, { content: source.source_code }]));
    assert.equal(Object.keys(sources).length, evidence.sourceManifest.length);
    assert.deepEqual(verified.compiler_settings, evidence.compiler.settings);
    // Every source must match an immutable upstream Git tree, including gitlink
    // commits for dependencies. Verified explorer content alone is insufficient.
    const prefixes = {
      'Uniswap/calibur': '',
      'OpenZeppelin/openzeppelin-contracts': 'lib/openzeppelin-contracts/',
      'Vectorized/solady': 'lib/solady/',
      'eth-infinitism/account-abstraction': 'lib/account-abstraction/',
      'base/webauthn-sol': 'lib/webauthn-sol/',
      'rdubois-crypto/FreshCryptoLib': 'lib/webauthn-sol/lib/FreshCryptoLib/',
    };
    const references = [...new Map(evidence.sourceManifest.map(source => [source.repository, source.commit]))];
    const trees = new Map();
    for (const [repository, commit] of references) {
      const tree = await json(`https://api.github.com/repos/${repository}/git/trees/${commit}?recursive=1`);
      assert.equal(tree.truncated, false, `complete Git tree for ${repository}`);
      trees.set(repository, new Map(tree.tree.map(entry => [entry.path, entry])));
    }
    for (const [repository, commit] of references) {
      if (repository === 'Uniswap/calibur') continue;
      const nested = repository === 'rdubois-crypto/FreshCryptoLib';
      const parent = nested ? 'base/webauthn-sol' : 'Uniswap/calibur';
      const path = nested ? 'lib/FreshCryptoLib' : prefixes[repository].slice(0, -1);
      const gitlink = trees.get(parent).get(path);
      assert.equal(gitlink?.type, 'commit', `dependency gitlink ${path}`);
      assert.equal(gitlink.sha, commit, `pinned dependency ${repository}`);
    }
    for (const source of evidence.sourceManifest) {
      const content = sources[source.path]?.content;
      assert.equal(typeof content, 'string', source.path);
      const blob = digest('sha1', Buffer.concat([Buffer.from(`blob ${Buffer.byteLength(content)}\0`), Buffer.from(content)]));
      const prefix = prefixes[source.repository]; assert.notEqual(prefix, undefined);
      assert.ok(source.path.startsWith(prefix));
      assert.equal(blob, trees.get(source.repository).get(source.path.slice(prefix.length))?.sha, source.path);
      assert.equal(blob, source.gitBlobSha, `retained source manifest ${source.path}`);
    }
    const output = compile({ language: 'Solidity', sources, settings: evidence.compiler.settings });
    const entry = output.contracts['src/CaliburEntry.sol'].CaliburEntry;
    const declarations = new Map();
    const visit = node => {
      if (!node || typeof node !== 'object') return;
      if (node.nodeType === 'VariableDeclaration') declarations.set(String(node.id), node.name);
      for (const value of Object.values(node)) if (value && typeof value === 'object') {
        if (Array.isArray(value)) value.forEach(visit); else visit(value);
      }
    };
    Object.values(output.sources).forEach(source => visit(source.ast));
    const values = {
      _cachedNameHash: keccak256(toHex('Calibur')),
      _cachedVersionHash: keccak256(toHex('1.0.0')),
      _cachedImplementation: '0x' + evidence.address.slice(2).toLowerCase().padStart(64, '0'),
    };
    let runtime = entry.evm.deployedBytecode.object;
    const immutables = Object.entries(entry.evm.deployedBytecode.immutableReferences).map(([id, locations]) => ({ name: declarations.get(id), locations }));
    assert.deepEqual(immutables.map(item => item.name).sort(), Object.keys(values).sort());
    for (const { name, locations } of immutables) {
      const retained = evidence.verification.constructorImmutables.find(item => item.name === name);
      assert.deepEqual(locations, retained.locations, `compiler-declared immutable ${name}`);
      assert.equal(values[name].toLowerCase(), retained.value.toLowerCase());
      for (const { start, length } of locations) {
        assert.equal(length, 32);
        assert.equal(runtime.slice(start * 2, (start + length) * 2), '0'.repeat(64), 'only empty immutable slots are patched');
        runtime = runtime.slice(0, start * 2) + values[name].slice(2) + runtime.slice((start + length) * 2);
      }
    }
    runtime = '0x' + runtime;
    assert.equal(runtime.toLowerCase(), evidence.runtimeBytecode.toLowerCase(), 'complete reproduced runtime');
    assert.equal(keccak256(runtime), evidence.runtimeCodeHash);
    const rpc = async (method, params) => {
      const response = await fetch(evidence.sources.robinhoodRpc, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30_000) });
      assert.equal(response.status, 200); const result = await response.json(); assert.equal(result.error, undefined); return result.result;
    };
    assert.equal(await rpc('eth_chainId', []), '0x1237');
    const liveCode = await rpc('eth_getCode', [evidence.address, 'latest']);
    assert.equal(liveCode.toLowerCase(), runtime.toLowerCase(), 'current Robinhood implementation runtime');
    console.log(JSON.stringify({ verifiedAt: new Date().toISOString(), sourceCommit: evidence.sourceCommit, sourceFiles: evidence.sourceManifest.length,
      entryContract: evidence.entryContract, runtimeBytes: (runtime.length - 2) / 2, runtimeCodeHash: keccak256(runtime), exactMatch: true }));
  }
  console.log('Both isolated mock contract runtimes and ABIs reproduce exactly.');
} finally { await rm(temp, { recursive: true, force: true }); }
