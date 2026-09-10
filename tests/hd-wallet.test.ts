import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { toHex } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { createHdWallet as create } from '../src/hd-wallet.js';
const createHdWallet = (root: string, request: string) => create(root, request, { platform: 'linux' });

// Public BIP-39 zero-entropy test vector. Never use this seed for a funded wallet.
const mnemonic = `${'abandon '.repeat(23)}art`;
const createdAt = '2026-09-07T00:00:00.000Z';
const request = (index: number) => index.toString(16).padStart(64, '0');
const pathFor = (index: number): `m/44'/60'/0'/0/${number}` => `m/44'/60'/0'/0/${index}`;
const account = (index: number) => mnemonicToAccount(mnemonic, { path: pathFor(index) });
const exec = promisify(execFile);
async function fixture(t: TestContext, seed = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rebalance-hd-fixture-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  if (seed) {
    await mkdir(join(root, 'hd'), { mode: 0o700 });
    await writeFile(join(root, 'hd/seed.json'), JSON.stringify({ version: 1, mnemonic, createdAt }), { mode: 0o600 });
  }
  return root;
}
async function json(path: string) { return JSON.parse(await readFile(path, 'utf8')); }
async function save(path: string, value: unknown) { await writeFile(path, JSON.stringify(value), { mode: 0o600 }); }
async function digest(path: string) { return createHash('sha256').update(await readFile(path)).digest('hex'); }
async function reserved(root: string, index = 0) {
  const records = Array.from({ length: index + 1 }, (_, i) => ({ requestKey: request(i), accountIndex: i, address: account(i).address, derivationPath: pathFor(i) }));
  await save(join(root, 'hd/accounts.json'), { version: 1, seedAddress: account(0).address, accounts: records });
  return join(root, 'wallets', account(index).address.toLowerCase());
}
async function rejectsSafely(root: string, key = request(0)) {
  await assert.rejects(createHdWallet(root, key), error => {
    assert.equal((error as Error).message, 'HD wallet setup could not be verified. Existing seed and wallet files were not replaced.');
    assert.doesNotMatch((error as Error).stack || '', /abandon|art art|0x[0-9a-f]{64}/);
    return true;
  });
}

test('one private 24-word seed is created and replay returns public metadata without replacing files', async t => {
  const root = await fixture(t, false);
  const first = await createHdWallet(root, request(0));
  assert.deepEqual(Object.keys(first).sort(), ['accountIndex', 'address', 'dataDir', 'derivationPath']);
  assert.equal(first.accountIndex, 0); assert.equal(first.derivationPath, pathFor(0));
  assert.equal(first.dataDir, join(root, 'wallets', first.address.toLowerCase()));
  const seedFile = join(root, 'hd/seed.json');
  const seed = await json(seedFile);
  assert.equal(seed.mnemonic.split(' ').length, 24, 'generated phrases contain 256 bits of entropy plus checksum');
  const before = await Promise.all([seedFile, join(root, 'hd/accounts.json'), join(first.dataDir, 'private-key'), join(first.dataDir, 'wallet.json')].map(digest));
  assert.deepEqual(await createHdWallet(root, request(0)), first);
  const after = await Promise.all([seedFile, join(root, 'hd/accounts.json'), join(first.dataDir, 'private-key'), join(first.dataDir, 'wallet.json')].map(digest));
  assert.deepEqual(after, before);
  for (const file of [seedFile, join(root, 'hd/accounts.json'), join(first.dataDir, 'private-key'), join(first.dataDir, 'wallet.json')]) assert.equal((await stat(file)).mode & 0o777, 0o600);
  for (const dir of ['hd', 'wallets', `wallets/${first.address.toLowerCase()}`]) assert.equal((await stat(join(root, dir))).mode & 0o777, 0o700);
  assert.equal(await lstat(join(first.dataDir, 'config.json')).then(() => true, () => false), false);
});

test('known shared seed derives conventional sequential browser-wallet addresses and preserves legacy funds files', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'private-key'), 'legacy-fixture-do-not-touch', { mode: 0o600 });
  await save(join(root, 'wallet.json'), { address: 'legacy-public-fixture' });
  await save(join(root, 'config.json'), { existingLegacyConfiguration: true });
  const before = await Promise.all(['private-key', 'wallet.json', 'config.json', 'hd/seed.json'].map(file => digest(join(root, file))));
  const [first, second] = [await createHdWallet(root, request(0)), await createHdWallet(root, request(1))];
  for (const [index, result] of [first, second].entries()) {
    assert.equal(result.address, account(index).address);
    assert.equal(result.derivationPath, pathFor(index));
    assert.equal((await readFile(join(result.dataDir, 'private-key'), 'utf8')).trim(), toHex(account(index).getHdKey().privateKey!));
    const metadata = await json(join(result.dataDir, 'wallet.json'));
    assert.equal(metadata.address, result.address); assert.equal(metadata.chainId, 4663);
    assert.deepEqual(metadata.hd, { version: 1, requestKey: request(index), accountIndex: index, derivationPath: pathFor(index) });
  }
  assert.notEqual(first.address, second.address);
  assert.deepEqual(await Promise.all(['private-key', 'wallet.json', 'config.json', 'hd/seed.json'].map(file => digest(join(root, file)))), before);
  const state = await json(join(root, 'hd/accounts.json'));
  assert.deepEqual(state.accounts.map((item: { accountIndex: number }) => item.accountIndex), [0, 1]);
});

test('concurrent same and distinct requests share reservations without duplicate account indexes', async t => {
  const root = await fixture(t);
  const results = await Promise.all(Array.from({ length: 12 }, (_, index) => createHdWallet(root, request(index % 4))));
  assert.equal(new Set(results.map(result => result.address)).size, 4);
  for (let index = 0; index < results.length; index++) assert.deepEqual(results[index], results[index % 4]);
  const state = await json(join(root, 'hd/accounts.json'));
  assert.equal(state.accounts.length, 4);
  assert.deepEqual(state.accounts.map((item: { accountIndex: number }) => item.accountIndex), [0, 1, 2, 3]);
});

test('separate processes serialize reservations and replay after process restart', async t => {
  const root = await fixture(t);
  const script = `const {createHdWallet}=await import(process.argv[1]);process.stdout.write(JSON.stringify(await createHdWallet(process.argv[2],process.argv[3],{platform:'linux'})));`;
  const run = (key: string) => exec(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, '--', new URL('../src/hd-wallet.ts', import.meta.url).href, root, key]);
  const results = await Promise.all([run(request(0)), run(request(0)), run(request(1))]);
  assert.deepEqual(JSON.parse(results[0].stdout), JSON.parse(results[1].stdout));
  assert.notEqual(JSON.parse(results[0].stdout).address, JSON.parse(results[2].stdout).address);
  assert.deepEqual(JSON.parse((await run(request(0))).stdout), JSON.parse(results[0].stdout));
  assert.ok(results.every(result => !result.stderr));
  assert.equal((await json(join(root, 'hd/accounts.json'))).accounts.length, 2);
});

test('an interrupted reservation or key-only provision resumes the same account and preserves registered config', async t => {
  const root = await fixture(t), dataDir = await reserved(root);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const keyPath = join(dataDir, 'private-key');
  await writeFile(keyPath, `${toHex(account(0).getHdKey().privateKey!)}\n`, { mode: 0o600 });
  const keyBefore = await digest(keyPath), reservationsBefore = await digest(join(root, 'hd/accounts.json'));
  const result = await createHdWallet(root, request(0));
  assert.equal(result.address, account(0).address); assert.equal(await digest(keyPath), keyBefore);
  assert.equal(await digest(join(root, 'hd/accounts.json')), reservationsBefore);
  await save(join(dataDir, 'config.json'), { wallet: result.address, chainId: 4663, mode: 'private-key', targets: { saved: true } });
  const configBefore = await digest(join(dataDir, 'config.json'));
  assert.deepEqual(await createHdWallet(root, request(0)), result);
  assert.equal(await digest(join(dataDir, 'config.json')), configBefore);
  const other = await createHdWallet(root, request(1));
  assert.equal(other.accountIndex, 1);
});

test('missing or malformed seeds with reservations never produce a replacement seed or another account', async t => {
  for (const damaged of [null, '{"mnemonic":', JSON.stringify({ version: 1, mnemonic: 'abandon '.repeat(24).trim(), createdAt }), JSON.stringify({ version: 1, mnemonic: 'untrusted mnemonic text', createdAt })]) {
    const root = await fixture(t); await reserved(root);
    const path = join(root, 'hd/seed.json');
    if (damaged === null) await rm(path); else await writeFile(path, damaged);
    const before = await digest(join(root, 'hd/accounts.json'));
    await rejectsSafely(root);
    assert.equal(await digest(join(root, 'hd/accounts.json')), before);
    if (damaged === null) await assert.rejects(readFile(path), { code: 'ENOENT' });
    else assert.equal(await readFile(path, 'utf8'), damaged);
    assert.deepEqual((await readdir(root)).sort(), ['hd']);
  }
});

test('a valid but changed seed or corrupted reservation identity cannot redirect an existing request', async t => {
  const root = await fixture(t); await reserved(root);
  const file = join(root, 'hd/accounts.json'), original = await json(file);
  for (const corrupt of [
    { ...original, seedAddress: account(1).address },
    { ...original, accounts: [{ ...original.accounts[0], accountIndex: 1, derivationPath: pathFor(1) }] },
    { ...original, accounts: [{ ...original.accounts[0], address: account(1).address }] },
    { ...original, accounts: [...original.accounts, { ...original.accounts[0], accountIndex: 1, derivationPath: pathFor(1) }] },
  ]) {
    await save(file, corrupt); const before = await digest(file); await rejectsSafely(root); assert.equal(await digest(file), before);
  }
  await save(file, original);
  // A second public 24-word BIP-39 test vector has a valid checksum but another root key.
  await save(join(root, 'hd/seed.json'), { version: 1, mnemonic: `${'zoo '.repeat(23)}vote`, createdAt });
  const before = await digest(join(root, 'hd/seed.json')); await rejectsSafely(root);
  assert.equal(await digest(join(root, 'hd/seed.json')), before);
});

test('fresh address collisions and reserved key/config collisions never overwrite unrelated files', async t => {
  for (const kind of ['fresh', 'key', 'metadata', 'config', 'missing-key']) {
    const root = await fixture(t);
    const dataDir = kind === 'fresh' ? join(root, 'wallets', account(0).address.toLowerCase()) : await reserved(root);
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const name = kind === 'metadata' || kind === 'missing-key' ? 'wallet.json' : kind === 'config' ? 'config.json' : 'private-key';
    const value = kind === 'missing-key' ? JSON.stringify({ address: account(0).address, chainId: 4663, createdAt,
      hd: { version: 1, requestKey: request(0), accountIndex: 0, derivationPath: pathFor(0) } }) : 'unrelated-fixture';
    await writeFile(join(dataDir, name), value, { mode: 0o600 });
    const before = await digest(join(dataDir, name)); await rejectsSafely(root);
    assert.equal(await digest(join(dataDir, name)), before);
    assert.deepEqual(await readdir(dataDir), [name]);
  }
});

test('root, ancestor, managed-directory, seed, reservation, key and metadata symlinks are rejected', async t => {
  for (const kind of ['root', 'ancestor', 'hd', 'wallets', 'wallet-dir', 'seed', 'accounts', 'key', 'metadata', 'lock']) {
    const root = await fixture(t), outside = await fixture(t, false);
    const marker = join(outside, 'marker'); await writeFile(marker, 'outside-fixture', { mode: 0o600 });
    let selected = root;
    if (kind === 'root') { selected = join(outside, 'root-link'); await symlink(root, selected); }
    else if (kind === 'ancestor') { await symlink(root, join(outside, 'parent')); selected = join(outside, 'parent', 'child'); }
    else if (kind === 'hd') { await rm(join(root, 'hd'), { recursive: true }); await symlink(outside, join(root, 'hd')); }
    else if (kind === 'seed') { await rm(join(root, 'hd/seed.json')); await symlink(marker, join(root, 'hd/seed.json')); }
    else if (kind === 'accounts') await symlink(marker, join(root, 'hd/accounts.json'));
    else if (kind === 'lock') await symlink(marker, join(root, 'hd-wallet.lock'));
    else if (kind === 'wallets') await symlink(outside, join(root, 'wallets'));
    else {
      const dataDir = await reserved(root); await mkdir(join(root, 'wallets'), { mode: 0o700 });
      if (kind === 'wallet-dir') await symlink(outside, dataDir);
      else { await mkdir(dataDir, { mode: 0o700 }); await symlink(marker, join(dataDir, kind === 'key' ? 'private-key' : 'wallet.json')); }
    }
    const before = await digest(marker); await rejectsSafely(selected);
    assert.equal(await digest(marker), before);
    assert.equal((await stat(marker)).mode & 0o777, 0o600);
  }
});

test('broad seed permissions, malformed journals and invalid request keys fail with sanitized errors', async t => {
  const root = await fixture(t), file = join(root, 'hd/seed.json');
  await chmod(file, 0o644); const before = await digest(file); await rejectsSafely(root);
  assert.equal(await digest(file), before); assert.equal((await stat(file)).mode & 0o777, 0o644);
  await chmod(file, 0o600);
  await writeFile(join(root, 'hd/accounts.json'), 'incomplete', { mode: 0o600 });
  await rejectsSafely(root); assert.equal(await readFile(join(root, 'hd/accounts.json'), 'utf8'), 'incomplete');
  for (const key of ['', '../private-key', 'z'.repeat(64), 'a'.repeat(63)]) await rejectsSafely(root, key);
  await rejectsSafely('relative-root');
});
