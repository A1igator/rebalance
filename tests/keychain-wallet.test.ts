import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { mnemonicToAccount } from 'viem/accounts';
import { createKeychainWallet, keychainAccount } from '../src/keychain-wallet.js';
import { createHdWallet } from '../src/hd-wallet.js';
import type { SeedStore } from '../src/macos-keychain.js';
import { assertTemporaryTestDirectory } from '../src/test-isolation.js';

class MemorySeeds implements SeedStore {
  values = new Map<string, string>();
  creations = 0;
  denied = false;
  async read(id: string) { if (this.denied) throw new Error('fixture denied'); return this.values.get(id) ?? null; }
  async create(id: string, value: string) {
    if (this.denied) throw new Error('fixture denied');
    if (this.values.has(id)) throw new Error('fixture duplicate');
    this.creations++; this.values.set(id, value);
  }
}
const key = (n: number) => createHash('sha256').update(`keychain-fixture-${n}`).digest('hex');
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'rebalance-keychain-fixture-'));
  assertTemporaryTestDirectory(root);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, store: new MemorySeeds() };
}
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
const save = (path: string, value: unknown) => writeFile(path, JSON.stringify(value), { mode: 0o600 });
async function contents(root: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...await contents(path)); else result.push(path);
  }
  return result;
}

test('macOS selector accounts share one Keychain seed and persist no plaintext seed or derived key', async t => {
  const { root, store } = await fixture(t);
  const a = await createHdWallet(root, key(0), { platform: 'darwin', store });
  const b = await createKeychainWallet(root, key(1), { store });
  assert.equal(store.creations, 1);
  assert.deepEqual([a.accountIndex, b.accountIndex], [0, 1]);
  assert.notEqual(a.address, b.address);
  const secret = [...store.values.values()][0];
  const mnemonic = JSON.parse(secret).mnemonic;
  const account = mnemonicToAccount(mnemonic, { path: "m/44'/60'/0'/0/1" });
  assert.equal(b.address, account.address);
  const metadata = await json(join(b.dataDir, 'wallet.json'));
  assert.equal((await keychainAccount(b.dataDir, metadata, store)).address, b.address);
  assert.deepEqual(await json(join(b.dataDir, 'keychain-wallet.json')), metadata);
  for (const path of await contents(root)) {
    assert.ok(!path.endsWith('/seed.json') && !path.endsWith('/private-key'));
    const text = await readFile(path, 'utf8');
    assert.ok(!text.includes(mnemonic));
    assert.ok(!text.includes(Buffer.from(account.getHdKey().privateKey!).toString('hex')));
  }
});

test('bootstrap and selector accounts share reservations, including retry and concurrent requests', async t => {
  const { root, store } = await fixture(t);
  const bootstrap = await createKeychainWallet(root, key(0), { bootstrap: true, store });
  assert.equal(bootstrap.dataDir, root);
  assert.equal(bootstrap.created, true);
  const replay = await createKeychainWallet(root, key(0), { bootstrap: true, store });
  assert.equal(replay.address, bootstrap.address); assert.equal(replay.created, false);
  const results = await Promise.all([1, 1, 2, 3, 2].map(n => createKeychainWallet(root, key(n), { store })));
  assert.deepEqual(results.map(r => r.accountIndex), [1, 1, 2, 3, 2]);
  assert.equal((await json(join(root, 'hd/accounts.json'))).accounts.length, 4);
  assert.equal(store.creations, 1);
});

test('missing, inaccessible or changed established seed never creates a replacement', async t => {
  const { root, store } = await fixture(t);
  const wallet = await createKeychainWallet(root, key(0), { store });
  const before = await readFile(join(root, 'hd/keychain.json'), 'utf8');
  const [id, original] = [...store.values.entries()][0];
  store.values.delete(id);
  await assert.rejects(createKeychainWallet(root, key(1), { store }), /Existing keys were not replaced/);
  await assert.rejects(keychainAccount(wallet.dataDir, await json(join(wallet.dataDir, 'wallet.json')), store), /No fallback/);
  store.values.set(id, original); store.denied = true;
  await assert.rejects(createKeychainWallet(root, key(1), { store }));
  store.denied = false;
  store.values.set(id, JSON.stringify({ version: 1, mnemonic: `${'abandon '.repeat(23)}art`, createdAt: new Date().toISOString() }));
  await assert.rejects(createKeychainWallet(root, key(1), { store }));
  assert.equal(store.creations, 1);
  assert.equal(await readFile(join(root, 'hd/keychain.json'), 'utf8'), before);
});

test('interrupted immutable seed insertion and public metadata publication resume the same identity', async t => {
  const { root, store } = await fixture(t);
  const create = store.create.bind(store);
  store.create = async (id, value) => { await create(id, value); throw new Error('fixture lost insertion response'); };
  const wallet = await createKeychainWallet(root, key(0), { store });
  const metadata = await json(join(wallet.dataDir, 'wallet.json'));
  await rm(join(wallet.dataDir, 'wallet.json'));
  const resumed = await createKeychainWallet(root, key(0), { store });
  assert.equal(resumed.address, wallet.address);
  assert.deepEqual(await json(join(wallet.dataDir, 'wallet.json')), metadata);
  assert.equal(store.creations, 1);
  assert.equal((await json(join(root, 'hd/accounts.json'))).accounts.length, 1);
});

test('corrupt or mismatched public anchors block reuse and signing without writing a key', async t => {
  const { root, store } = await fixture(t);
  const wallet = await createKeychainWallet(root, key(0), { store });
  const metadata = await json(join(wallet.dataDir, 'wallet.json'));
  const anchor = join(wallet.dataDir, 'keychain-wallet.json');
  for (const bad of [null, {}, { ...metadata, address: `0x${'1'.repeat(40)}` },
    { ...metadata, hd: { ...metadata.hd, accountIndex: 999 } }]) {
    await save(anchor, bad);
    await assert.rejects(keychainAccount(wallet.dataDir, metadata, store));
    await assert.rejects(createKeychainWallet(root, key(0), { store }));
  }
  await save(anchor, metadata);
  await rm(anchor);
  await assert.rejects(keychainAccount(wallet.dataDir, metadata, store));
  await assert.rejects(createKeychainWallet(root, key(0), { store }));
  assert.equal(store.creations, 1);
});

test('legacy HD seed is retained and requires migration rather than producing another key', async t => {
  const { root, store } = await fixture(t);
  await mkdir(join(root, 'hd'), { mode: 0o700 });
  const file = join(root, 'hd/seed.json');
  await writeFile(file, 'legacy-fixture-never-read', { mode: 0o600 });
  await assert.rejects(createKeychainWallet(root, key(0), { store }));
  assert.equal(await readFile(file, 'utf8'), 'legacy-fixture-never-read');
  assert.equal(store.creations, 0);
});

test('symlinked public seed reference and wallet anchor are rejected', async t => {
  const { root, store } = await fixture(t);
  const wallet = await createKeychainWallet(root, key(0), { store });
  const metadata = await json(join(wallet.dataDir, 'wallet.json'));
  const anchor = join(wallet.dataDir, 'keychain-wallet.json');
  const marker = join(root, 'marker'); await writeFile(marker, '{}', { mode: 0o600 });
  await rm(anchor); await symlink(marker, anchor);
  await assert.rejects(keychainAccount(wallet.dataDir, metadata, store));
  const vault = join(root, 'hd/keychain.json'); await rm(vault); await symlink(marker, vault);
  await assert.rejects(createKeychainWallet(root, key(1), { store }));
  assert.equal(await readFile(marker, 'utf8'), '{}'); assert.equal(store.creations, 1);
});


test('bootstrap collisions leave existing files intact before creating a Keychain seed', async t => {
  for (const filename of ['private-key', 'wallet.json', 'config.json']) {
    const { root, store } = await fixture(t);
    const file = join(root, filename);
    await writeFile(file, 'existing-public-fixture-marker', { mode: 0o600 });
    await assert.rejects(createKeychainWallet(root, key(0), { bootstrap: true, store }));
    assert.equal(store.creations, 0);
    assert.equal(await readFile(file, 'utf8'), 'existing-public-fixture-marker');
    await assert.rejects(readFile(join(root, 'hd/keychain.json')), { code: 'ENOENT' });
  }
});


test('surviving wallet references prevent replacing lost shared Keychain records', async t => {
  for (const bootstrap of [false, true]) {
    for (const files of [['keychain.json', 'accounts.json'], ['accounts.json']]) {
      const { root, store } = await fixture(t);
      const wallet = await createKeychainWallet(root, key(0), { bootstrap, store });
      const before = await readFile(join(wallet.dataDir, 'keychain-wallet.json'), 'utf8');
      for (const file of files) await rm(join(root, 'hd', file));
      await assert.rejects(createKeychainWallet(root, key(1), { store }));
      assert.equal(store.creations, 1);
      assert.equal(await readFile(join(wallet.dataDir, 'keychain-wallet.json'), 'utf8'), before);
      for (const file of files) await assert.rejects(readFile(join(root, 'hd', file)), { code: 'ENOENT' });
    }
  }
});

test('surviving wallet metadata alone prevents a fresh shared seed after root records are lost', async t => {
  const { root, store } = await fixture(t);
  const wallet = await createKeychainWallet(root, key(0), { store });
  await rm(join(root, 'hd/keychain.json')); await rm(join(root, 'hd/accounts.json'));
  await rm(join(wallet.dataDir, 'keychain-wallet.json'));
  await assert.rejects(createKeychainWallet(root, key(1), { store }));
  assert.equal(store.creations, 1);
});
