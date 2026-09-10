import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function run(t: TestContext, body: string) {
  const path = await mkdtemp(join(tmpdir(), 'rebalance-keychain-config-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = { ...process.env, REBALANCE_DATA_DIR: path, REBALANCE_ROOT_DIR: path };
  delete env.REBALANCE_PRIVATE_KEY;
  // The fake store never crosses process boundaries or prints secret values.
  const script = `
    import assert from 'node:assert/strict';
    import * as fs from 'node:fs/promises';
    import { join } from 'node:path';
    const { privateKeyToAccount } = await import('viem/accounts');
    const config = await import(process.argv[1]);
    const directory = process.env.REBALANCE_DATA_DIR;
    const values = new Map();
    let creates = 0;
    const store = {
      async create(id, value) {
        assert.equal(values.has(id), false);
        creates++;
        values.set(id, value);
      },
      async read(id) { return values.get(id) ?? null; },
    };
    const options = { platform: 'darwin', seedStore: store };
    const fixtureKey = '0x' + '1'.padStart(64, '0');
    const fixtureAddress = privateKeyToAccount(fixtureKey).address;
    const walletPath = join(directory, 'wallet.json');
    const anchorPath = join(directory, 'keychain-wallet.json');
    const readMetadata = async () => JSON.parse(await fs.readFile(walletPath, 'utf8'));
    const writeMetadata = (metadata) => fs.writeFile(walletPath, JSON.stringify(metadata));
    const absent = async (name) => assert.rejects(fs.stat(join(directory, name)), { code: 'ENOENT' });
    ${body}
    process.stdout.write('verified');
  `;
  const result = await execFileAsync(process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', script, '--', new URL('../src/config.ts', import.meta.url).href],
    { env });
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, 'verified');
}

test('macOS bootstrap creates one Keychain identity without a plaintext key and reuses it', async t => {
  await run(t, `
    const first = await config.createWallet(options);
    assert.equal(first.created, true);
    const second = await config.createWallet(options);
    assert.deepEqual(second, { address: first.address, created: false });
    assert.equal((await config.localAccount(options)).address, first.address);
    assert.equal(creates, 1);
    const metadata = await readMetadata();
    assert.equal(metadata.address, first.address);
    assert.equal(metadata.keychain.version, 1);
    assert.equal(metadata.hd.accountIndex, 0);
    await absent('private-key');
    await absent('hd/seed.json');
  `);
});

test('a Keychain wallet takes precedence over env and unrelated plaintext keys', async t => {
  await run(t, `
    const wallet = await config.createWallet(options);
    process.env.REBALANCE_PRIVATE_KEY = fixtureKey;
    await fs.writeFile(join(directory, 'private-key'), fixtureKey);
    assert.equal((await config.localAccount(options)).address, wallet.address);
    assert.deepEqual(await config.createWallet(options), { address: wallet.address, created: false });
    assert.notEqual(wallet.address, fixtureAddress);
    assert.equal(creates, 1);
  `);
});

test('missing Keychain seed never regenerates or falls back to env/file keys', async t => {
  await run(t, `
    await config.createWallet(options);
    values.clear();
    process.env.REBALANCE_PRIVATE_KEY = fixtureKey;
    await fs.writeFile(join(directory, 'private-key'), fixtureKey);
    await assert.rejects(config.localAccount(options));
    await assert.rejects(config.createWallet(options));
    assert.equal(creates, 1);
  `);
});

test('denied Keychain access propagates without trying a different signing key', async t => {
  await run(t, `
    await config.createWallet(options);
    process.env.REBALANCE_PRIVATE_KEY = fixtureKey;
    const denied = { ...options, seedStore: { ...store, async read() { throw new Error('Keychain access denied'); } } };
    await assert.rejects(config.localAccount(denied));
    await assert.rejects(config.createWallet(denied));
    assert.equal(creates, 1);
  `);
});

test('invalid Keychain metadata remains authoritative even on a non-macOS host', async t => {
  await run(t, `
    await config.createWallet(options);
    const metadata = await readMetadata();
    await writeMetadata({ ...metadata, keychain: null });
    process.env.REBALANCE_PRIVATE_KEY = fixtureKey;
    await fs.writeFile(join(directory, 'private-key'), fixtureKey);
    await assert.rejects(config.localAccount({ platform: 'linux', seedStore: store }));
    await assert.rejects(config.createWallet({ platform: 'linux', seedStore: store }));
    assert.equal(creates, 1);
  `);
});

test('an anchor prevents fallback when wallet metadata is deleted', async t => {
  await run(t, `
    await config.createWallet(options);
    await fs.rm(walletPath);
    process.env.REBALANCE_PRIVATE_KEY = fixtureKey;
    await fs.writeFile(join(directory, 'private-key'), fixtureKey);
    await assert.rejects(config.localAccount(options));
    await assert.rejects(config.createWallet(options));
    assert.equal(creates, 1);
  `);
});

test('missing or corrupt anchors fail closed even when an env key is set', async t => {
  await run(t, `
    await config.createWallet(options);
    process.env.REBALANCE_PRIVATE_KEY = fixtureKey;
    await fs.rm(anchorPath);
    await assert.rejects(config.localAccount(options));
    await assert.rejects(config.createWallet(options));
    await fs.writeFile(anchorPath, 'null');
    await assert.rejects(config.localAccount(options));
    await assert.rejects(config.createWallet(options));
    assert.equal(creates, 1);
  `);
});

test('a surviving public vault blocks localAccount fallback after both wallet references are lost', async t => {
  await run(t, `
    await config.createWallet(options);
    await fs.rm(walletPath);
    await fs.rm(anchorPath);
    process.env.REBALANCE_PRIVATE_KEY = fixtureKey;
    await fs.writeFile(join(directory, 'private-key'), fixtureKey);
    await assert.rejects(config.localAccount(options), /Keychain wallet metadata/);
    await assert.rejects(config.createWallet(options));
    assert.equal(creates, 1);
  `);
});

test('existing standalone legacy wallets are reused on macOS without touching Keychain', async t => {
  await run(t, `
    await fs.writeFile(join(directory, 'private-key'), fixtureKey);
    assert.deepEqual(await config.createWallet(options), { address: fixtureAddress, created: false });
    assert.equal((await config.localAccount(options)).address, fixtureAddress);
    assert.equal(creates, 0);
    await absent('keychain-wallet.json');
  `);
});

test('a legacy root wallet still works when sibling Keychain portfolios add a public vault', async t => {
  await run(t, `
    await fs.writeFile(join(directory, 'private-key'), fixtureKey);
    assert.deepEqual(await config.createWallet(options), { address: fixtureAddress, created: false });
    await fs.mkdir(join(directory, 'hd'));
    await fs.writeFile(join(directory, 'hd', 'keychain.json'), '{}');
    assert.deepEqual(await config.createWallet(options), { address: fixtureAddress, created: false });
    assert.equal((await config.localAccount(options)).address, fixtureAddress);
    assert.equal(creates, 0);
  `);
});

test('selector reservations prevent env/file fallback when both child references are missing', async t => {
  await run(t, `
    const { createHdWallet } = await import(new URL('./hd-wallet.ts', process.argv[1]).href);
    const wallet = await createHdWallet(directory, 'a'.repeat(64), { platform: 'darwin', store });
    await fs.rm(join(wallet.dataDir, 'wallet.json'));
    await fs.rm(join(wallet.dataDir, 'keychain-wallet.json'));
    process.env.REBALANCE_DATA_DIR = wallet.dataDir;
    process.env.REBALANCE_PRIVATE_KEY = fixtureKey;
    const selected = await import(process.argv[1] + '?selected');
    assert.equal(selected.DATA, wallet.dataDir);
    await fs.writeFile(join(wallet.dataDir, 'private-key'), fixtureKey);
    await assert.rejects(selected.localAccount(options), /Keychain wallet metadata/);
    await assert.rejects(selected.createWallet(options), /Keychain wallet metadata/);
    await fs.rm(join(wallet.dataDir, 'private-key'));
    await assert.rejects(selected.createWallet({ platform: 'linux', seedStore: store }), /Keychain wallet metadata/);
    await assert.rejects(fs.stat(join(wallet.dataDir, 'private-key')), { code: 'ENOENT' });
    assert.equal(creates, 1);
  `);
});

test('known selector identity cannot be disguised as a legacy wallet and does not rely on ROOT env', async t => {
  await run(t, `
    const { createHdWallet } = await import(new URL('./hd-wallet.ts', process.argv[1]).href);
    const wallet = await createHdWallet(directory, 'b'.repeat(64), { platform: 'darwin', store });
    await fs.rm(join(wallet.dataDir, 'keychain-wallet.json'));
    await fs.writeFile(join(wallet.dataDir, 'wallet.json'), JSON.stringify({ address: fixtureAddress, chainId: 4663 }));
    await fs.writeFile(join(wallet.dataDir, 'private-key'), fixtureKey);
    process.env.REBALANCE_DATA_DIR = wallet.dataDir;
    process.env.REBALANCE_PRIVATE_KEY = fixtureKey;
    delete process.env.REBALANCE_ROOT_DIR;
    const selected = await import(process.argv[1] + '?selected');
    await assert.rejects(selected.localAccount(options), /Keychain wallet metadata/);
    await assert.rejects(selected.createWallet(options), /Keychain wallet metadata/);
    assert.equal(creates, 1);
  `);
});

test('orphan root reservations preserve child identity when the master marker also disappears', async t => {
  await run(t, `
    const { createHdWallet } = await import(new URL('./hd-wallet.ts', process.argv[1]).href);
    const wallet = await createHdWallet(directory, 'c'.repeat(64), { platform: 'darwin', store });
    await fs.rm(join(wallet.dataDir, 'wallet.json'));
    await fs.rm(join(wallet.dataDir, 'keychain-wallet.json'));
    await fs.rm(join(directory, 'hd', 'keychain.json'));
    process.env.REBALANCE_DATA_DIR = wallet.dataDir;
    process.env.REBALANCE_PRIVATE_KEY = fixtureKey;
    const selected = await import(process.argv[1] + '?selected');
    await assert.rejects(selected.localAccount(options), /Keychain wallet metadata/);
    await assert.rejects(selected.createWallet(options), /Keychain wallet metadata/);
    assert.equal(creates, 1);
  `);
});

test('corrupt public metadata never exposes parser input or bypasses identity checks', async t => {
  await run(t, `
    process.env.REBALANCE_PRIVATE_KEY = fixtureKey;
    await fs.writeFile(join(directory, 'private-key'), fixtureKey);
    for (const contents of ['fixture-sensitive-metadata-detail', 'null', '{}'.repeat(10000)]) {
      await fs.writeFile(walletPath, contents);
      for (const invoke of [() => config.localAccount(options), () => config.createWallet(options)]) {
        await assert.rejects(invoke(), error => {
          assert.equal(error.message, 'Wallet public metadata is invalid or unavailable; no key was selected.');
          assert.equal(error.message.includes('fixture-sensitive-metadata-detail'), false);
          assert.equal(error.message.includes(fixtureKey), false);
          return true;
        });
      }
    }
    assert.equal(creates, 0);
  `);
});

test('public wallet metadata symlinks are rejected without changing the target', async t => {
  await run(t, `
    const external = join(directory, 'external-fixture.json');
    await fs.writeFile(external, 'fixture-sensitive-metadata-detail', { mode: 0o644 });
    await fs.symlink(external, walletPath);
    process.env.REBALANCE_PRIVATE_KEY = fixtureKey;
    for (const invoke of [() => config.localAccount(options), () => config.createWallet(options)]) {
      await assert.rejects(invoke(), { message: 'Wallet public metadata is invalid or unavailable; no key was selected.' });
    }
    assert.equal((await fs.stat(external)).mode & 0o777, 0o644);
    assert.equal(await fs.readFile(external, 'utf8'), 'fixture-sensitive-metadata-detail');
    assert.equal(creates, 0);
  `);
});

test('corrupt surviving Keychain reservations fail closed without exposing parser input', async t => {
  await run(t, `
    const { createHdWallet } = await import(new URL('./hd-wallet.ts', process.argv[1]).href);
    const wallet = await createHdWallet(directory, 'd'.repeat(64), { platform: 'darwin', store });
    await fs.rm(join(wallet.dataDir, 'wallet.json'));
    await fs.rm(join(wallet.dataDir, 'keychain-wallet.json'));
    await fs.writeFile(join(directory, 'hd', 'accounts.json'), 'fixture-sensitive-reservations-detail');
    process.env.REBALANCE_DATA_DIR = wallet.dataDir;
    process.env.REBALANCE_PRIVATE_KEY = fixtureKey;
    const selected = await import(process.argv[1] + '?selected');
    for (const invoke of [() => selected.localAccount(options), () => selected.createWallet(options)]) {
      await assert.rejects(invoke(), { message: 'Wallet public metadata is invalid or unavailable; no key was selected.' });
    }
    assert.equal(creates, 1);
  `);
});
