import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { acquireLock, atomicWriteJson, readJson } from '../src/storage.js';

const executeFile = promisify(execFile);
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const repository = fileURLToPath(new URL('..', import.meta.url));
const targets = { USDG: 2000, TSLA: 2000, AAPL: 2000, NVDA: 2000, AMZN: 2000 };
const config = { version: 1, chainId: 4663, wallet: '0x0000000000000000000000000000000000000001',
  mode: 'ledger', rpcUrl: 'http://cli-fixture.invalid', targets,
  driftThresholdBps: 500, slippageBps: 50, deadlineSeconds: 120, pollSeconds: 5 };

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'rebalance-cli-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await atomicWriteJson(join(directory, 'config.json'), config);
  const preload = join(directory, 'fixture.mjs');
  await writeFile(preload, `
    import { existsSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { setTimeout as delay } from 'node:timers/promises';
    const directory = process.env.REBALANCE_DATA_DIR;
    globalThis.fetch = async () => {
      writeFileSync(join(directory, 'unexpected-network'), 'blocked');
      throw new Error('CLI test transport is disabled');
    };
    if (process.env.REBALANCE_TEST_GATE === '1' && process.argv.includes('start') && !process.argv.includes('--background')) {
      writeFileSync(join(directory, 'child-waiting'), 'ready');
      while (!existsSync(join(directory, 'release-child'))) await delay(10);
    }
  `);
  const env: NodeJS.ProcessEnv = { ...process.env, REBALANCE_DATA_DIR: directory,
    NODE_OPTIONS: `--import=${preload}` };
  delete env.REBALANCE_PRIVATE_KEY;
  async function command(args: string[], extra: NodeJS.ProcessEnv = {}) {
    return executeFile(process.execPath, ['--import', 'tsx', cli, ...args], {
      cwd: repository, env: { ...env, ...extra }, timeout: 10_000,
    });
  }
  return { directory, command };
}

async function until(condition: () => boolean | Promise<boolean>, message: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await delay(20);
  }
  assert.fail(message);
}

test('stop after background start is retained when the delayed child begins', { timeout: 15_000 }, async t => {
  const { directory, command } = await fixture(t);
  const olderStop = { requestedAt: '2026-01-01T00:00:00Z' };
  await atomicWriteJson(join(directory, 'stop.json'), olderStop);
  const token = createHash('sha256').update(JSON.stringify(olderStop)).digest('hex');
  const launched = await command(['start', '--background', '--expected-stop', token], { REBALANCE_TEST_GATE: '1' });
  const started = JSON.parse(launched.stdout) as { status: string; pid: number };
  assert.equal(started.status, 'starting');
  assert.ok(Number.isSafeInteger(started.pid));
  t.after(() => { try { process.kill(started.pid, 'SIGKILL'); } catch {} });
  await until(() => existsSync(join(directory, 'child-waiting')), 'background child must reach its startup gate');
  assert.equal(existsSync(join(directory, 'stop.json')), false, 'explicit start clears only the older stop');
  assert.equal(JSON.parse((await command(['stop'])).stdout).status, 'stop-requested');
  const requested = await readJson(join(directory, 'stop.json'));
  await writeFile(join(directory, 'release-child'), 'go');
  await until(async () => {
    const current = await readJson<{ armed?: boolean }>(join(directory, 'status.json'));
    return current?.armed === false && !existsSync(join(directory, 'run.lock'));
  }, 'stopped child should finish and release its run lock');
  assert.deepEqual(await readJson(join(directory, 'stop.json')), requested);
  assert.equal(existsSync(join(directory, 'unexpected-network')), false, 'stop must prevent even the first observation');
  assert.equal(existsSync(join(directory, 'pending.json')), false);
  assert.equal(existsSync(join(directory, 'private-key')), false);
});

test('another start/check cannot take the runner lock or erase its stop request', async t => {
  const { directory, command } = await fixture(t);
  const release = await acquireLock(directory);
  t.after(release);
  const request = { requestedAt: '2026-09-04T20:00:00Z' };
  await atomicWriteJson(join(directory, 'stop.json'), request);
  for (const args of [['start'], ['start', '--background'], ['check']]) {
    await assert.rejects(command(args), (error: unknown) => {
      const result = error as { code: number; stderr: string };
      assert.equal(result.code, 1);
      assert.match(result.stderr, /lock|running/i);
      return true;
    });
    assert.deepEqual(await readJson(join(directory, 'stop.json')), request);
  }
  assert.equal(existsSync(join(directory, 'start.log')), false);
  assert.equal(existsSync(join(directory, 'unexpected-network')), false);
});

test('actual CLI target edits appear immediately in status and graph includes the saved path', async t => {
  const { directory, command } = await fixture(t);
  await atomicWriteJson(join(directory, 'status.json'), {
    app: 'Rebalance', chain: { id: 4663, name: 'Robinhood' }, mode: 'ledger', wallet: config.wallet,
    config: { targets }, portfolio: null, operation: null, updatedAt: null, error: null,
    armed: false, graph: { node: 'wait', trace: ['config', 'observe', 'plan', 'wait'] },
  });
  const changed = JSON.parse((await command(['targets', 'set', 'TSLA', '30'])).stdout);
  assert.deepEqual(changed.targets, { USDG: 1750, TSLA: 3000, AAPL: 1750, NVDA: 1750, AMZN: 1750 });
  const current = JSON.parse((await command(['status'])).stdout);
  assert.deepEqual(current.config.targets, changed.targets);
  assert.equal(current.armed, false);
  const graph = JSON.parse((await command(['graph'])).stdout);
  assert.deepEqual(graph.state, { node: 'wait', trace: ['config', 'observe', 'plan', 'wait'] });
  assert.ok(graph.edges.execute.includes('receipt'));
  assert.equal(existsSync(join(directory, 'unexpected-network')), false);
  assert.equal(existsSync(join(directory, 'private-key')), false);
  assert.equal(JSON.parse(await readFile(join(directory, 'config.json'), 'utf8')).wallet, config.wallet);
});

test('CLI configures the cycle interval without replacing targets, resetting cadence or starting a runner', async t => {
  const { directory, command } = await fixture(t);
  const cycle = { startedAt: Date.parse('2026-09-05T06:00:00Z'), activeUntil: Date.parse('2026-09-05T06:10:00Z'),
    nextEligibleAt: Date.parse('2026-09-05T07:00:00Z'), wallet: config.wallet };
  await atomicWriteJson(join(directory, 'cycle.json'), cycle);
  const configured = JSON.parse((await command(['configure', '--rebalance-interval-seconds', '7200'])).stdout);
  assert.equal(configured.rebalanceIntervalSeconds, 7200);
  assert.deepEqual(configured.targets, targets);
  assert.equal((await readJson<{ rebalanceIntervalSeconds: number }>(join(directory, 'config.json')))!.rebalanceIntervalSeconds, 7200);
  assert.deepEqual(await readJson(join(directory, 'cycle.json')), cycle);
  assert.equal(existsSync(join(directory, 'run.lock')), false);
  assert.equal(existsSync(join(directory, 'unexpected-network')), false);
  assert.equal(existsSync(join(directory, 'private-key')), false);
  await assert.rejects(command(['configure', '--rebalance-interval-seconds', 'NaN']));
  assert.equal((await readJson<{ rebalanceIntervalSeconds: number }>(join(directory, 'config.json')))!.rebalanceIntervalSeconds, 7200);
});

test('conditional launch start preserves a stop that arrived after preflight', async t => {
  const { directory, command } = await fixture(t);
  const before = { requestedAt: '2026-09-05T06:00:00Z', requestId: 'older-stop' };
  const latest = { ...before, requestId: 'newer-stop' };
  await atomicWriteJson(join(directory, 'stop.json'), latest);
  for (const token of ['none', createHash('sha256').update(JSON.stringify(before)).digest('hex')]) {
    await assert.rejects(command(['start', '--background', '--expected-stop', token]), (error: unknown) => {
      assert.match((error as { stderr: string }).stderr, /newer stop/);
      return true;
    });
    assert.deepEqual(await readJson(join(directory, 'stop.json')), latest);
    assert.equal(existsSync(join(directory, 'start.log')), false);
  }
  assert.equal(existsSync(join(directory, 'unexpected-network')), false);
});

test('stop waits for the short start/stop control lock then persists a distinct generation', async t => {
  const { directory, command } = await fixture(t);
  const release = await acquireLock(directory, 'control.lock');
  t.after(release);
  const stopping = command(['stop']);
  await delay(80);
  assert.equal(existsSync(join(directory, 'stop.json')), false);
  await release();
  assert.equal(JSON.parse((await stopping).stdout).status, 'stop-requested');
  const first = await readJson<{ requestId: string }>(join(directory, 'stop.json'));
  await command(['stop']);
  const second = await readJson<{ requestId: string }>(join(directory, 'stop.json'));
  assert.ok(first?.requestId && second?.requestId);
  assert.notEqual(first.requestId, second.requestId);
  assert.equal(existsSync(join(directory, 'unexpected-network')), false);
});

test('actual launch command reports missing initial targets without creating keys or starting services', async t => {
  const { directory, command } = await fixture(t);
  await rm(join(directory, 'config.json'));
  const result = JSON.parse((await command(['launch'])).stdout);
  assert.equal(result.outcome, 'needs-input');
  assert.equal(result.status.armed, false);
  for (const file of ['private-key', 'start.log', 'chart.log', 'pending.json', 'unexpected-network']) {
    assert.equal(existsSync(join(directory, file)), false);
  }
  await assert.rejects(command(['status', '--setup-only']));
});
