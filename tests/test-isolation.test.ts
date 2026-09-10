import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { assertTemporaryTestDirectory } from '../src/test-isolation.js';

const execute = promisify(execFile);
const configUrl = new URL('../src/config.ts', import.meta.url).href;
const lockUrl = new URL('../src/config-lock.ts', import.meta.url).href;
const loader = import.meta.resolve('tsx');
const launcher = fileURLToPath(new URL('../scripts/run-tests.mjs', import.meta.url));

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'rebalance-isolation-'));
  assertTemporaryTestDirectory(directory);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('test directory checks reject defaults, non-temporary paths and symlink escapes without creating paths', async t => {
  const directory = await fixture(t);
  const child = join(directory, 'not-created', 'data');
  assert.doesNotThrow(() => assertTemporaryTestDirectory(child));
  for (const path of [undefined, '', '.local', 'relative/data', '/tmp', '/private/tmp', '/rebalance-not-temporary/data']) {
    assert.throws(() => assertTemporaryTestDirectory(path), /Unsafe test storage/);
  }
  const link = join(directory, 'outside');
  await symlink('/', link, 'dir');
  assert.throws(() => assertTemporaryTestDirectory(join(link, 'rebalance-not-temporary')), /Unsafe test storage/);
  const originalTmp = process.env.TMPDIR;
  try {
    process.env.TMPDIR = '/';
    assert.throws(() => assertTemporaryTestDirectory('/rebalance-not-temporary/data'), /Unsafe test storage/);
  } finally {
    if (originalTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmp;
  }
  assert.equal(existsSync(child), false);
  const dangling = join(directory, 'dangling');
  await symlink('/rebalance-not-temporary/missing', dangling, 'dir');
  assert.throws(() => assertTemporaryTestDirectory(join(dangling, 'data')), /Unsafe test storage/);
  assert.deepEqual((await readdir(directory)).sort(), ['dangling', 'outside']);
});

test('an actual test process rejects unsafe app imports before filesystem writes; lock helper does not capture config', async t => {
  const directory = await fixture(t);
  const script = join(directory, 'guard.test.mjs');
  await writeFile(script, `
import assert from 'node:assert/strict';
import filesystem from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
test('guard imports', async t => {
  assert.ok(process.env.NODE_TEST_CONTEXT);
  const writes = [];
  for (const method of ['writeFile', 'appendFile', 'mkdir', 'rename', 'rm', 'unlink', 'chmod']) {
    t.mock.method(filesystem, method, (...args) => { writes.push(method); throw new Error('Unexpected app write'); });
  }
  const open = filesystem.open;
  t.mock.method(filesystem, 'open', (...args) => {
    if (args[1] !== 'r' && args[1] !== 0) { writes.push('open'); throw new Error('Unexpected app write'); }
    return open(...args);
  });
  syncBuiltinESMExports();
  const cases = [undefined, '.local', '/rebalance-not-temporary/data'];
  for (const [index, value] of cases.entries()) {
    if (value === undefined) delete process.env.REBALANCE_DATA_DIR;
    else process.env.REBALANCE_DATA_DIR = value;
    await assert.rejects(import(${JSON.stringify(configUrl)} + '?unsafe=' + index), /Unsafe test storage/);
  }
  process.env.REBALANCE_DATA_DIR = ${JSON.stringify(directory)};
  process.env.REBALANCE_ROOT_DIR = '/rebalance-not-temporary/root';
  await assert.rejects(import(${JSON.stringify(configUrl)} + '?unsafe=root'), /Unsafe test storage/);
  process.env.REBALANCE_DATA_DIR = '/rebalance-not-temporary/data';
  const { acquireConfigLock } = await import(${JSON.stringify(lockUrl)});
  assert.equal(typeof acquireConfigLock, 'function');
  assert.deepEqual(writes, []);
});`);
  const result = await execute(process.execPath, ['--import', loader, '--test', '--test-reporter=tap', script], {
    cwd: directory, env: { ...process.env, REBALANCE_ROOT_DIR: directory, REBALANCE_DATA_DIR: directory, NODE_OPTIONS: '', NODE_TEST_CONTEXT: undefined, TSX_DISABLE_CACHE: '1' }, timeout: 20_000,
  });
  assert.match(result.stdout, /# pass 1/);
  assert.deepEqual(await readdir(directory), ['guard.test.mjs']);
});

test('npm test launcher installs temporary paths before static app imports, forwards a file and cleans its root', async t => {
  const directory = await fixture(t);
  const script = join(directory, 'forwarded.test.mjs');
  const marker = join(directory, 'selected-path.json');
  // NODE_TEST_CONTEXT is assigned by Node, and this static import runs before
  // the test callback can repair a missing or unsafe environment.
  await writeFile(script, `
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { DATA, CONFIG_PATH } from ${JSON.stringify(configUrl)};
test('forwarded fixture only', () => {
  assert.ok(process.env.NODE_TEST_CONTEXT);
  assert.equal(DATA, process.env.REBALANCE_ROOT_DIR);
  assert.equal(DATA, process.env.REBALANCE_DATA_DIR);
  assert.equal(process.env.REBALANCE_PRIVATE_KEY, undefined);
  assert.equal(process.env.REBALANCE_PROFILE_WALLET, undefined);
  writeFileSync(${JSON.stringify(marker)}, JSON.stringify({data: DATA, config: CONFIG_PATH}));
});`);
  const result = await execute(process.execPath, [launcher, '--test-reporter=tap', script], {
    cwd: directory, env: { ...process.env, REBALANCE_ROOT_DIR: directory, REBALANCE_DATA_DIR: directory,
      REBALANCE_PRIVATE_KEY: 'public-test-sentinel', REBALANCE_PROFILE_WALLET: 'public-test-sentinel', NODE_OPTIONS: '' }, timeout: 20_000,
  });
  assert.match(result.stdout, /# tests 1/);
  const { readFile } = await import('node:fs/promises');
  const selected = JSON.parse(await readFile(marker, 'utf8'));
  assertTemporaryTestDirectory(selected.data);
  assert.notEqual(selected.data, directory);
  assert.equal(selected.config, resolve(selected.data, 'config.json'));
  assert.equal(existsSync(selected.data), false, 'launcher removes only its own temporary directory');
  assert.equal(existsSync(directory), true);
});
