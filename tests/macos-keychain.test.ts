import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { assertMacosKeychainEnvironment, macosSeedStore, seedStoreWithCommand, type KeychainCommand } from '../src/macos-keychain.js';

const id = '926b69c1-ac2f-467a-b512-8d99e6d0b000';
const secret = 'fixture mnemonic never echoed into errors';
function memoryProcess() {
  const values = new Map<string, string>();
  const calls: Record<string, string>[] = [];
  const command: KeychainCommand = async input => {
    const request = JSON.parse(input); calls.push(request);
    if (request.operation === 'read') return JSON.stringify({ ok: true, value: values.get(request.id) ?? null });
    if (values.has(request.id)) return JSON.stringify({ ok: false, error: 'duplicate' });
    values.set(request.id, request.value); return JSON.stringify({ ok: true });
  };
  return { store: seedStoreWithCommand(command), values, calls };
}

test('insert and exact-ID read use the bounded private protocol', async () => {
  const { store, calls } = memoryProcess();
  assert.equal(await store.read(id), null);
  await store.create(id, secret);
  assert.equal(await store.read(id), secret);
  assert.equal(await store.read(randomUUID()), null);
  assert.deepEqual(calls[1], { operation: 'create', id, value: secret });
  assert.deepEqual(calls[2], { operation: 'read', id });
});

test('duplicate seed insertion never overwrites existing material', async () => {
  const { store, calls } = memoryProcess();
  await store.create(id, secret);
  await assert.rejects(store.create(id, 'replacement'), /already exists; it was not replaced/);
  assert.equal(await store.read(id), secret);
  assert.deepEqual(calls.map(call => call.operation), ['create', 'create', 'read']);
});

test('missing and denied reads are distinct and neither generates a seed', async () => {
  const { store, calls } = memoryProcess();
  assert.equal(await store.read(id), null);
  assert.deepEqual(calls, [{ operation: 'read', id }]);
  const denied = seedStoreWithCommand(async () => JSON.stringify({ ok: false, error: 'denied' }));
  await assert.rejects(denied.read(id), /access was denied or the keychain is locked/);
});

test('command failures expose no subprocess output, input, stack cause or credential', async () => {
  const store = seedStoreWithCommand(async () => { throw Object.assign(new Error(secret), { stdout: secret, stderr: secret }); });
  try { await store.create(id, secret); assert.fail(); }
  catch (error) {
    assert.ok(error instanceof Error);
    assert.match(error.message, /unavailable or timed out/);
    assert.ok(!error.message.includes(secret));
    assert.equal(error.cause, undefined);
    assert.equal((error as Error & { stderr?: string }).stderr, undefined);
  }
});

for (const invalidId of ['', '../private-key', id.toUpperCase(), `${id}\n`, id.slice(1), '1'.repeat(1000)]) {
  test(`rejects malformed ID before calling a process (${invalidId.length} bytes)`, async () => {
    let calls = 0;
    const store = seedStoreWithCommand(async () => { calls++; return '{}'; });
    await assert.rejects(store.create(invalidId, secret), /could not be verified/);
    await assert.rejects(store.read(invalidId), /could not be verified/);
    assert.equal(calls, 0);
  });
}

for (const value of ['', 'a'.repeat(4097), 'é'.repeat(2049), 'a\0b']) {
  test(`rejects malformed or oversized secret before calling a process (${Buffer.byteLength(value)} bytes)`, async () => {
    let calls = 0;
    const store = seedStoreWithCommand(async () => { calls++; return '{}'; });
    await assert.rejects(store.create(id, value), /could not be verified/);
    assert.equal(calls, 0);
  });
}

test('secret size is bounded by UTF-8 bytes and the limit is accepted', async () => {
  const { store } = memoryProcess();
  const value = 'é'.repeat(2048);
  await store.create(id, value);
  assert.equal(await store.read(id), value);
});

for (const response of ['', secret, '{', 'null', '[]', '{"ok":true}', JSON.stringify({ ok: true, value: '' }),
  JSON.stringify({ ok: true, value: secret, extra: secret }), JSON.stringify({ ok: true, value: 'x'.repeat(4097) }),
  JSON.stringify({ ok: false, error: secret }), JSON.stringify({ ok: false, error: 'denied', detail: secret }), 'x'.repeat(32769)]) {
  test(`malformed read response is sanitized (${response.length} bytes)`, async () => {
    const store = seedStoreWithCommand(async () => response);
    await assert.rejects(store.read(id), error => error instanceof Error &&
      error.message.includes('could not be verified') && !error.message.includes(secret));
  });
}

test('create success cannot carry secret material or unspecified fields', async () => {
  const store = seedStoreWithCommand(async () => JSON.stringify({ ok: true, value: secret }));
  await assert.rejects(store.create(id, secret), /could not be verified/);
});

test('unsupported native error category cannot be reflected into an error', async () => {
  const store = seedStoreWithCommand(async () => JSON.stringify({ ok: false, error: secret }));
  await assert.rejects(store.create(id, secret), error => error instanceof Error && !error.message.includes(secret));
});

test('production entry point is unavailable in Node test workers before any native operation', () => {
  assert.ok(process.env.NODE_TEST_CONTEXT);
  assert.throws(() => macosSeedStore(), /disabled for tests/);
});

test('test sentinel cannot be cleared by an empty string value', () => {
  assert.throws(() => assertMacosKeychainEnvironment({ NODE_TEST_CONTEXT: '' }, 'darwin', '/Users/example/project'), /disabled for tests/);
});

for (const directory of ['/tmp/rebalance-fixture', '/private/tmp/rebalance-fixture', '/var/tmp/rebalance-fixture',
  '/private/var/folders/ab/test-user/T/rebalance-fixture']) {
  test(`native guard refuses temporary ROOT and DATA independently (${directory})`, () => {
    for (const name of ['REBALANCE_ROOT_DIR', 'REBALANCE_DATA_DIR']) {
      assert.throws(() => assertMacosKeychainEnvironment({ [name]: directory }, 'darwin', '/Users/example/project'), /disabled for tests/);
    }
  });
}

test('relative fixture data under a temporary working directory is rejected', () => {
  assert.throws(() => assertMacosKeychainEnvironment({ REBALANCE_ROOT_DIR: './store', REBALANCE_DATA_DIR: './store/wallets' }, 'darwin', '/tmp/fixture'), /disabled for tests/);
});

test('temporary paths through aliases or missing descendants are refused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rebalance-keychain-guard-'));
  try {
    await mkdir(join(root, 'actual'));
    await symlink(join(root, 'actual'), join(root, 'alias'));
    assert.throws(() => assertMacosKeychainEnvironment({ REBALANCE_ROOT_DIR: resolve(root, 'alias', 'not-created') }, 'darwin', '/Users/example/project'), /disabled for tests/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('normal public app path only passes on macOS; this check performs no native calls', () => {
  const environment = { REBALANCE_ROOT_DIR: '/Users/example/rebalance/.local', REBALANCE_DATA_DIR: '/Users/example/rebalance/.local/wallets/example' };
  assert.doesNotThrow(() => assertMacosKeychainEnvironment(environment, 'darwin', '/Users/example/rebalance'));
  assert.throws(() => assertMacosKeychainEnvironment(environment, 'linux', '/Users/example/rebalance'), /require macOS Keychain/);
});
