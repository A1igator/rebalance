import { assertTemporaryTestDirectory } from '../src/test-isolation.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { acquireConfigLock, ConfigLockBusyError } from '../src/config-lock.js';
import { acquireLock, atomicWriteJson, isLiveLockContention, readJson } from '../src/storage.js';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'rebalance-config-lock-'));
  assertTemporaryTestDirectory(directory);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('configuration lock waits for an existing boundary and observes its last committed revision', async t => {
  const directory = await fixture(t); const first = await acquireLock(directory, 'config.lock'); t.after(first);
  const waiting = acquireConfigLock(directory, { timeoutMs: 1000 });
  assert.equal(await Promise.race([waiting.then(() => true), delay(40).then(() => false)]), false);
  await atomicWriteJson(join(directory, 'config.json'), { revision: 'latest-owner-write' });
  await first(); const release = await waiting;
  try { assert.deepEqual(await readJson(join(directory, 'config.json')), { revision: 'latest-owner-write' }); }
  finally { await release(); }
  assert.equal(await readJson(join(directory, 'config.lock')), null);
});

test('bounded configuration contention has a typed busy result and preserves the owner', async t => {
  const directory = await fixture(t); const release = await acquireLock(directory, 'config.lock'); t.after(release);
  const before = await readFile(join(directory, 'config.lock'), 'utf8');
  await assert.rejects(acquireConfigLock(directory, { timeoutMs: 25 }), error => {
    assert.ok(error instanceof ConfigLockBusyError); assert.ok(isLiveLockContention(error)); return true;
  });
  assert.equal(await readFile(join(directory, 'config.lock'), 'utf8'), before);
});

test('aborted configuration waits and malformed locks never replace another writer', async t => {
  const directory = await fixture(t); const release = await acquireLock(directory, 'config.lock'); t.after(release);
  const before = await readFile(join(directory, 'config.lock'), 'utf8');
  const abort = new AbortController();
  const waiting = acquireConfigLock(directory, { signal: abort.signal });
  const rejected = assert.rejects(waiting, { name: 'AbortError' }); abort.abort(); await rejected;
  assert.equal(await readFile(join(directory, 'config.lock'), 'utf8'), before);
  await release(); await writeFile(join(directory, 'config.lock'), '{broken');
  await assert.rejects(acquireConfigLock(directory, { timeoutMs: 25 }), ConfigLockBusyError);
  assert.equal(await readFile(join(directory, 'config.lock'), 'utf8'), '{broken');
});

test('a partially written lock is retried until its valid owner releases it', async t => {
  const directory = await fixture(t);
  const path = join(directory, 'config.lock');
  await writeFile(path, '{"pid":');
  let acquired = false;
  const waiting = acquireConfigLock(directory, { timeoutMs: 1000 }).then(release => { acquired = true; return release; });
  await delay(40);
  assert.equal(acquired, false);
  assert.equal(await readFile(path, 'utf8'), '{"pid":');
  const owner = { pid: process.pid, createdAt: new Date().toISOString(), token: 'fixture-owner' };
  await writeFile(path, JSON.stringify(owner));
  await delay(40);
  assert.equal(acquired, false);
  assert.deepEqual(await readJson(path), owner);
  await rm(path);
  const release = await waiting;
  await release();
  assert.equal(await readJson(path), null);
});
