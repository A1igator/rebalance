import assert from 'node:assert/strict';
import { chmod, link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { providerKey, providerKeyPath, saveProviderKey, validatePaymasterConfig } from '../src/paymaster-config.js';

const fixtureKey = 'fixture_only_alchemy_key_12345';
const paymaster = '0x0000000000000000000000000000000000000011';
const configuration = { provider: 'alchemy', token: 'USDG', policyId: '11111111-2222-3333-4444-555555555555', paymaster };
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'rebalance-paymaster-credential-'));
  const previousRoot = process.env.REBALANCE_ROOT_DIR, previousKey = process.env.REBALANCE_ALCHEMY_API_KEY;
  process.env.REBALANCE_ROOT_DIR = root; delete process.env.REBALANCE_ALCHEMY_API_KEY;
  t.after(async () => {
    if (previousRoot === undefined) delete process.env.REBALANCE_ROOT_DIR; else process.env.REBALANCE_ROOT_DIR = previousRoot;
    if (previousKey === undefined) delete process.env.REBALANCE_ALCHEMY_API_KEY; else process.env.REBALANCE_ALCHEMY_API_KEY = previousKey;
    await rm(root, { recursive: true, force: true });
  });
  assert.equal(providerKeyPath(), join(root, 'alchemy-api-key'));
  return { root, path: providerKeyPath() };
}
const safeFailure = (error: unknown) => {
  assert.ok(error instanceof Error);
  assert.doesNotMatch(error.message, /fixture_only|ENOENT|EEXIST|EACCES|rebalance-paymaster-credential|https?:/);
  assert.equal(error.cause, undefined);
  return true;
};

test('configuration allows only canonical USDG, Alchemy, one policy UUID and a nonzero paymaster', () => {
  assert.deepEqual(validatePaymasterConfig(configuration), configuration);
  for (const value of [null, [], {}, { ...configuration, extra: fixtureKey }, { ...configuration, provider: 'other' },
    { ...configuration, token: 'USDC' }, { ...configuration, policyId: fixtureKey },
    { ...configuration, paymaster: `0x${'0'.repeat(40)}` }, { ...configuration, paymaster: fixtureKey }]) {
    assert.throws(() => validatePaymasterConfig(value), safeFailure);
  }
  const upper = { ...configuration, policyId: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE' };
  assert.equal(validatePaymasterConfig(upper).policyId, upper.policyId.toLowerCase());
});

test('local provider setup writes owner-only once and rejects replacement without exposing credentials', async t => {
  const f = await fixture(t);
  assert.equal(await saveProviderKey(fixtureKey), undefined);
  assert.equal(await providerKey(), fixtureKey);
  assert.equal((await stat(f.path)).mode & 0o777, 0o600);
  await assert.rejects(saveProviderKey('different_fixture_key_123456'), safeFailure);
  assert.equal(await readFile(f.path, 'utf8'), fixtureKey + '\n');
});

test('environment credential takes precedence but invalid supplied credentials never fall back to disk', async t => {
  await fixture(t); await saveProviderKey(fixtureKey);
  process.env.REBALANCE_ALCHEMY_API_KEY = 'environment_fixture_key_98765';
  assert.equal(await providerKey(), 'environment_fixture_key_98765');
  for (const value of ['', 'short', fixtureKey + '\n', 'https://fixture.invalid/' + fixtureKey, 'x'.repeat(257)]) {
    process.env.REBALANCE_ALCHEMY_API_KEY = value;
    await assert.rejects(providerKey(), safeFailure);
  }
});

test('missing, malformed, oversized, invalid UTF-8 and publicly-readable credential files fail closed', async t => {
  const f = await fixture(t);
  await assert.rejects(providerKey(), safeFailure);
  for (const bytes of ['short', 'x'.repeat(513), new Uint8Array([0xff, 0xfe])]) {
    await writeFile(f.path, bytes, { mode: 0o600 });
    await assert.rejects(providerKey(), safeFailure);
  }
  await writeFile(f.path, fixtureKey); await chmod(f.path, 0o644);
  await assert.rejects(providerKey(), safeFailure);
});

test('symlink, hardlink and non-file credential storage is refused', async t => {
  const f = await fixture(t), original = join(f.root, 'fixture-original');
  await writeFile(original, fixtureKey, { mode: 0o600 });
  await symlink(original, f.path); await assert.rejects(providerKey(), safeFailure);
  await assert.rejects(saveProviderKey(fixtureKey), safeFailure);
  await rm(f.path); await link(original, f.path); await assert.rejects(providerKey(), safeFailure);
  await rm(f.path); await mkdir(f.path, { mode: 0o700 }); await assert.rejects(providerKey(), safeFailure);
  assert.equal(await readFile(original, 'utf8'), fixtureKey);
});

test('setup refuses shared or symlinked root directories without changing existing files', async t => {
  const f = await fixture(t);
  await chmod(f.root, 0o755); await assert.rejects(saveProviderKey(fixtureKey), safeFailure);
  await chmod(f.root, 0o700);
  const actual = join(f.root, 'actual'), symbolic = join(f.root, 'symbolic');
  await mkdir(actual, { mode: 0o700 }); await symlink(actual, symbolic);
  process.env.REBALANCE_ROOT_DIR = symbolic;
  await assert.rejects(saveProviderKey(fixtureKey), safeFailure);
  await assert.rejects(stat(join(actual, 'alchemy-api-key')), { code: 'ENOENT' });
});

test('invalid setup inputs fail without creating a credential file', async t => {
  const f = await fixture(t);
  for (const value of ['', 'short', fixtureKey + '\n', 'x'.repeat(257)]) await assert.rejects(saveProviderKey(value), safeFailure);
  await assert.rejects(stat(f.path), { code: 'ENOENT' });
});
