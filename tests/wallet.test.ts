import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { privateKeyToAccount } from 'viem/accounts';

// Public, disposable fixtures. These accounts must never receive real funds.
const fixtureKey = `0x${'1'.padStart(64, '0')}` as const;
const overrideKey = `0x${'2'.padStart(64, '0')}` as const;
const fixtureAddress = privateKeyToAccount(fixtureKey).address;
const overrideAddress = privateKeyToAccount(overrideKey).address;
const execFileAsync = promisify(execFile);

async function directory(t: TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'rebalance-wallet-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

async function run(path: string, action = 'create', override?: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, REBALANCE_DATA_DIR: path };
  delete env.REBALANCE_PRIVATE_KEY;
  if (override !== undefined) env.REBALANCE_PRIVATE_KEY = override;
  const script = `
    const config = await import(process.argv[1]);
    try {
      const result = process.argv[2] === 'account'
        ? { address: (await config.localAccount()).address }
        : await config.createWallet();
      process.stdout.write(JSON.stringify(result));
    } catch (error) {
      process.stdout.write(JSON.stringify({ error: error.message }));
    }
  `;
  const result = await execFileAsync(process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', script, '--', new URL('../src/config.ts', import.meta.url).href, action],
    { env });
  assert.equal(result.stderr, '');
  // No key material may be emitted, even on a failing operation.
  assert.equal(result.stdout.includes(fixtureKey), false);
  assert.equal(result.stdout.includes(overrideKey), false);
  assert.equal(/0x[0-9a-fA-F]{64}/.test(result.stdout), false);
  return JSON.parse(result.stdout) as { address?: string; created?: boolean; error?: string };
}

test('new wallet is private on disk, public in output, and repeatable', async (t) => {
  const path = await directory(t);
  const first = await run(path);
  assert.equal(first.created, true);
  assert.match(first.address!, /^0x[0-9a-fA-F]{40}$/);
  const second = await run(path);
  assert.deepEqual(second, { address: first.address, created: false });
  assert.equal((await stat(path)).mode & 0o777, 0o700);
  assert.equal((await stat(join(path, 'private-key'))).mode & 0o777, 0o600);
  const metadata = JSON.parse(await readFile(join(path, 'wallet.json'), 'utf8'));
  assert.deepEqual(Object.keys(metadata).sort(), ['address', 'chainId', 'createdAt']);
  assert.equal(metadata.address, first.address);
  assert.equal(metadata.chainId, 4663);
});

test('existing file wallet ignores env override; explicit localAccount override remains available', async (t) => {
  const path = await directory(t);
  await writeFile(join(path, 'private-key'), `${fixtureKey}\n`, { mode: 0o644 });
  await chmod(path, 0o755);
  assert.deepEqual(await run(path, 'create', overrideKey), { address: fixtureAddress, created: false });
  assert.deepEqual(await run(path, 'account', overrideKey), { address: overrideAddress });
  assert.deepEqual(await run(path, 'account'), { address: fixtureAddress });
  assert.equal((await stat(path)).mode & 0o777, 0o700);
  assert.equal((await stat(join(path, 'private-key'))).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(join(path, 'wallet.json'), 'utf8')).address, fixtureAddress);
});

test('missing metadata is rebuilt without rotating an existing key', async (t) => {
  const path = await directory(t);
  await writeFile(join(path, 'private-key'), `${fixtureKey}\n`, { mode: 0o600 });
  assert.deepEqual(await run(path), { address: fixtureAddress, created: false });
  await rm(join(path, 'wallet.json'));
  assert.deepEqual(await run(path), { address: fixtureAddress, created: false });
  assert.equal(JSON.parse(await readFile(join(path, 'wallet.json'), 'utf8')).address, fixtureAddress);
});

test('missing key with existing metadata and mismatched metadata cannot silently replace a wallet', async (t) => {
  const path = await directory(t);
  const metadata = { address: fixtureAddress, chainId: 4663, createdAt: new Date().toISOString() };
  await writeFile(join(path, 'wallet.json'), JSON.stringify(metadata));
  assert.match((await run(path)).error!, /private key is missing/);
  await assert.rejects(stat(join(path, 'private-key')), { code: 'ENOENT' });
  await writeFile(join(path, 'private-key'), `${overrideKey}\n`, { mode: 0o600 });
  assert.match((await run(path)).error!, /does not match/);
  assert.equal(JSON.parse(await readFile(join(path, 'wallet.json'), 'utf8')).address, fixtureAddress);
});

test('invalid key files and symlinks are not replaced or followed', async (t) => {
  const path = await directory(t);
  const keyPath = join(path, 'private-key');
  await writeFile(keyPath, 'invalid-local-fixture', { mode: 0o600 });
  assert.match((await run(path)).error!, /invalid/);
  assert.equal(await readFile(keyPath, 'utf8'), 'invalid-local-fixture');
  await rm(keyPath);
  const external = join(path, 'external-fixture');
  await writeFile(external, fixtureKey, { mode: 0o644 });
  await symlink(external, keyPath);
  assert.ok((await run(path)).error);
  assert.ok((await run(path, 'account')).error);
  assert.equal((await stat(external)).mode & 0o777, 0o644);
});

test('concurrent creators never publish different wallets', async (t) => {
  const path = await directory(t);
  const attempts = await Promise.all(Array.from({ length: 5 }, () => run(path)));
  const successes = attempts.filter((result) => result.address !== undefined);
  assert.ok(successes.length >= 1);
  assert.equal(successes.filter((result) => result.created).length, 1);
  assert.equal(new Set(successes.map((result) => result.address)).size, 1);
  assert.deepEqual(await run(path), { address: successes[0]!.address, created: false });
});
