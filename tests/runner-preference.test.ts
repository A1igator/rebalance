import { assertTemporaryTestDirectory } from '../src/test-isolation.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { acquireLock, atomicWriteJson, readJson } from '../src/storage.js';
import { captureAppEntryInputs, type RunnerInput } from '../scripts/app-entry-inputs.mjs';
import { captureRunnerPreference, readRunnerPreference, RUNNER_GENERATION, runnerPreferenceMatches,
  withRunnerControl, writeRunnerPreference } from '../src/runner-preference.js';

const wallet = '0x00000000000000000000000000000000000000ab';
const otherWallet = '0x00000000000000000000000000000000000000cd';
const config = { version: 1, chainId: 4663, wallet, mode: 'ledger', rpcUrl: 'http://runner-fixture.invalid',
  targets: { USDG: 2000, TSLA: 2000, AAPL: 2000, NVDA: 2000, AMZN: 2000 },
  driftThresholdBps: 500, slippageBps: 50, deadlineSeconds: 120, pollSeconds: 5 };
const status = { app: 'Rebalance', chain: { id: 4663 }, wallet, mode: 'ledger', armed: true };
const lock = { pid: 321, createdAt: '2026-09-12T00:00:00.000Z', token: randomUUID() };
const preferenceFile = 'runner-preference.json';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'rebalance-runner-preference-'));
  assertTemporaryTestDirectory(directory);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
async function legacy(directory: string) {
  await Promise.all([
    atomicWriteJson(join(directory, 'run.lock'), lock), atomicWriteJson(join(directory, 'status.json'), status),
    atomicWriteJson(join(directory, 'config.json'), config),
  ]);
}
const record = (directory: string, enabled: boolean) => withRunnerControl(directory, () => writeRunnerPreference(directory, wallet, enabled));

test('unknown and never-started portfolios are ineligible without creating a preference', async t => {
  const directory = await fixture(t);
  assert.equal(await readRunnerPreference(directory, wallet), null);
  assert.deepEqual(await captureRunnerPreference(directory, wallet, { alive: () => true }),
    { preference: null, expectedStop: 'none', eligible: false });
  await atomicWriteJson(join(directory, 'config.json'), config);
  assert.equal((await captureRunnerPreference(directory, wallet, { alive: () => true })).eligible, false);
  assert.equal(await readJson(join(directory, preferenceFile)), null);
});

test('one bounded public record persists intent; repeat running preserves generation and Stop changes it', async t => {
  const directory = await fixture(t);
  const first = await record(directory, true);
  assert.deepEqual(Object.keys(first).sort(), ['chainId', 'enabled', 'generation', 'version', 'wallet']);
  assert.match(first.generation, RUNNER_GENERATION);
  assert.equal(first.wallet, wallet);
  assert.deepEqual(await record(directory, true), first);
  const stopped = await record(directory, false);
  assert.equal(stopped.enabled, false); assert.notEqual(stopped.generation, first.generation);
  const restarted = await record(directory, true);
  assert.equal(restarted.enabled, true); assert.notEqual(restarted.generation, stopped.generation);
  assert.equal(await withRunnerControl(directory, () => runnerPreferenceMatches(directory, wallet, first.generation, 'none')), false);
});

test('unexpected process exit preserves enabled intent for a future explicit invocation', async t => {
  const directory = await fixture(t);
  const release = await acquireLock(directory, 'run.lock');
  const running = await record(directory, true);
  await release();
  await atomicWriteJson(join(directory, 'status.json'), { ...status, armed: false });
  const snapshot = await captureRunnerPreference(directory, wallet, { alive: () => false });
  assert.equal(snapshot.eligible, true); assert.deepEqual(snapshot.preference, running);
  assert.equal(await readJson(join(directory, 'run.lock')), null);
});

test('strict preference parsing rejects malformed versions, identities, flags, generations and extra fields', async t => {
  const directory = await fixture(t);
  await legacy(directory);
  const valid = { version: 1, wallet, chainId: 4663, enabled: true, generation: randomUUID() };
  const invalid = [null, [], {}, { ...valid, version: 2 }, { ...valid, wallet: otherWallet },
    { ...valid, wallet: wallet.toUpperCase() }, { ...valid, chainId: 1 }, { ...valid, enabled: 1 },
    { ...valid, generation: 'old' }, { ...valid, generation: '00000000-0000-0000-0000-000000000000' },
    { ...valid, secret: 'must-not-be-accepted' }];
  for (const value of invalid) {
    await atomicWriteJson(join(directory, preferenceFile), value);
    await assert.rejects(readRunnerPreference(directory, wallet), /Invalid runner preference/);
    await assert.rejects(captureRunnerPreference(directory, wallet, { alive: () => true }), /Invalid runner preference/);
    assert.deepEqual(await readJson(join(directory, preferenceFile)), value);
  }
  await writeFile(join(directory, preferenceFile), '{broken');
  await assert.rejects(readRunnerPreference(directory, wallet), SyntaxError);
  await assert.rejects(readRunnerPreference(directory, '../other'), /Invalid runner preference wallet/);
});

test('an explicit disabled record safely replaces corrupt preference data', async t => {
  const directory = await fixture(t);
  await writeFile(join(directory, preferenceFile), '{broken');
  const stopped = await record(directory, false);
  assert.equal(stopped.enabled, false);
  assert.deepEqual(await readRunnerPreference(directory, wallet), stopped);
});

test('Stop wins over an enabled preference, including a present null marker', async t => {
  const directory = await fixture(t);
  const running = await record(directory, true);
  assert.equal((await captureRunnerPreference(directory, wallet)).eligible, true);
  for (const stop of [{ requestId: randomUUID() }, null]) {
    await atomicWriteJson(join(directory, 'stop.json'), stop);
    const snapshot = await captureRunnerPreference(directory, wallet);
    assert.equal(snapshot.eligible, false); assert.notEqual(snapshot.expectedStop, 'none');
    assert.deepEqual(snapshot.preference, running);
    assert.equal(await withRunnerControl(directory, () => runnerPreferenceMatches(directory, wallet, running.generation, 'none')), false);
    assert.equal(await withRunnerControl(directory, () => runnerPreferenceMatches(directory, wallet, running.generation, snapshot.expectedStop)), false);
  }
});

test('a currently live owned legacy runner with matching public identity is adopted once', async t => {
  const directory = await fixture(t); await legacy(directory);
  const preserved = ['run.lock', 'status.json', 'config.json', 'cycle.json', 'pending.json'];
  await atomicWriteJson(join(directory, 'cycle.json'), { startedAt: 'saved-cycle' });
  await atomicWriteJson(join(directory, 'pending.json'), { hash: 'saved-pending' });
  const before = await Promise.all(preserved.map(file => readFile(join(directory, file), 'utf8')));
  const snapshot = await captureRunnerPreference(directory, wallet, { alive: pid => { assert.equal(pid, lock.pid); return true; } });
  assert.equal(snapshot.eligible, true); assert.equal(snapshot.preference?.enabled, true);
  assert.deepEqual(await captureRunnerPreference(directory, wallet, { alive: () => { throw new Error('already persisted'); } }), snapshot);
  assert.deepEqual(await Promise.all(preserved.map(file => readFile(join(directory, file), 'utf8'))), before);
});

test('cached armed state, dead or unowned locks, and mismatched public identity never adopt legacy intent', async t => {
  const cases: { name: string; file?: string; value?: unknown; alive?: boolean }[] = [
    { name: 'dead process', alive: false }, { name: 'no lock', file: 'run.lock' },
    { name: 'no ownership token', file: 'run.lock', value: { pid: 321, createdAt: lock.createdAt } },
    { name: 'empty token', file: 'run.lock', value: { ...lock, token: '' } },
    { name: 'invalid pid', file: 'run.lock', value: { ...lock, pid: -1 } },
    { name: 'invalid creation time', file: 'run.lock', value: { ...lock, createdAt: 'unknown' } },
    { name: 'not armed', file: 'status.json', value: { ...status, armed: false } },
    { name: 'wrong status wallet', file: 'status.json', value: { ...status, wallet: otherWallet } },
    { name: 'wrong status chain', file: 'status.json', value: { ...status, chain: { id: 1 } } },
    { name: 'wrong application', file: 'status.json', value: { ...status, app: 'Other' } },
    { name: 'wrong config wallet', file: 'config.json', value: { ...config, wallet: otherWallet } },
    { name: 'mismatched mode', file: 'status.json', value: { ...status, mode: 'private-key' } },
    { name: 'no public config', file: 'config.json' },
    { name: 'Stop present', file: 'stop.json', value: { requestId: randomUUID() } },
  ];
  for (const item of cases) await t.test(item.name, async sub => {
    const directory = await fixture(sub); await legacy(directory);
    if (item.file) {
      if (item.value === undefined) await rm(join(directory, item.file), { force: true });
      else await atomicWriteJson(join(directory, item.file), item.value);
    }
    const snapshot = await captureRunnerPreference(directory, wallet, { alive: () => item.alive ?? true });
    assert.equal(snapshot.eligible, false); assert.equal(snapshot.preference, null);
    assert.equal(await readJson(join(directory, preferenceFile)), null);
  });
});

test('a disabled preference is never replaced by live legacy evidence', async t => {
  const directory = await fixture(t); await legacy(directory);
  const stopped = await record(directory, false);
  const snapshot = await captureRunnerPreference(directory, wallet, { alive: () => true });
  assert.equal(snapshot.eligible, false); assert.deepEqual(snapshot.preference, stopped);
});

test('snapshot waits for the same control boundary and observes a completed Stop', async t => {
  const directory = await fixture(t); await record(directory, true);
  const release = await acquireLock(directory, 'control.lock'); t.after(release);
  const snapshot = captureRunnerPreference(directory, wallet);
  assert.equal(await Promise.race([snapshot.then(() => true), delay(40).then(() => false)]), false);
  await atomicWriteJson(join(directory, 'stop.json'), { requestId: randomUUID() });
  const disabled = await writeRunnerPreference(directory, wallet, false);
  await release();
  const captured = await snapshot;
  assert.equal(captured.eligible, false); assert.deepEqual(captured.preference, disabled);
});

test('a newer Stop invalidates the frozen snapshot even before its preference write', async t => {
  const directory = await fixture(t); const enabled = await record(directory, true);
  const snapshot = await captureRunnerPreference(directory, wallet);
  assert.equal(await withRunnerControl(directory, () => runnerPreferenceMatches(directory, wallet, enabled.generation, snapshot.expectedStop)), true);
  await withRunnerControl(directory, () => atomicWriteJson(join(directory, 'stop.json'), { requestId: randomUUID() }));
  assert.equal(await withRunnerControl(directory, () => runnerPreferenceMatches(directory, wallet, enabled.generation, snapshot.expectedStop)), false);
  assert.deepEqual(await readRunnerPreference(directory, wallet), enabled);
});

test('malformed legacy lock or config fails closed without manufacturing a preference', async t => {
  const directory = await fixture(t); await legacy(directory);
  await writeFile(join(directory, 'run.lock'), '{broken');
  await assert.rejects(captureRunnerPreference(directory, wallet, { alive: () => true }), SyntaxError);
  assert.equal(await readJson(join(directory, preferenceFile)), null);
  await atomicWriteJson(join(directory, 'run.lock'), lock);
  await atomicWriteJson(join(directory, 'config.json'), { ...config, chainId: 1 });
  await assert.rejects(captureRunnerPreference(directory, wallet, { alive: () => true }), /Only Robinhood/);
  assert.equal(await readJson(join(directory, preferenceFile)), null);
});

async function freezeInput(directory: string): Promise<RunnerInput> {
  await atomicWriteJson(join(directory, 'config.json'), config);
  const journal = await captureAppEntryInputs(directory, randomUUID(), 'runner-input-fixture');
  assert.equal(journal.entries.length, 1);
  assert.ok(journal.entries[0]!.input);
  return journal.entries[0]!.input;
}

test('an enabled preference frozen before bootstrap remains eligible after a process exit', async t => {
  const directory = await fixture(t);
  const enabled = await record(directory, true);
  const expectedInput = await freezeInput(directory);
  await atomicWriteJson(join(directory, 'status.json'), { ...status, armed: false });
  const captured = await captureRunnerPreference(directory, wallet, { expectedInput, alive: () => false });
  assert.equal(captured.eligible, true); assert.deepEqual(captured.preference, enabled);
});

test('a preference first enabled during bootstrap cannot join the earlier invocation', async t => {
  const directory = await fixture(t);
  const expectedInput = await freezeInput(directory);
  const enabled = await record(directory, true);
  assert.deepEqual(await captureRunnerPreference(directory, wallet, { expectedInput }),
    { preference: null, expectedStop: 'none', eligible: false });
  assert.deepEqual(await readRunnerPreference(directory, wallet), enabled);
});

test('Stop followed by Start during bootstrap invalidates the frozen input even after Stop is cleared', async t => {
  const directory = await fixture(t); await record(directory, true);
  const expectedInput = await freezeInput(directory);
  await withRunnerControl(directory, async () => {
    await atomicWriteJson(join(directory, 'stop.json'), { requestId: randomUUID() });
    await writeRunnerPreference(directory, wallet, false);
  });
  const restarted = await withRunnerControl(directory, async () => {
    await rm(join(directory, 'stop.json'));
    return writeRunnerPreference(directory, wallet, true);
  });
  assert.deepEqual(await captureRunnerPreference(directory, wallet, { expectedInput }),
    { preference: null, expectedStop: 'none', eligible: false });
  assert.deepEqual(await readRunnerPreference(directory, wallet), restarted);
});

test('frozen input comparison waits for control.lock and rejects changes before preference parsing', async t => {
  const directory = await fixture(t); await record(directory, true);
  const expectedInput = await freezeInput(directory);
  const release = await acquireLock(directory, 'control.lock'); t.after(release);
  const captured = captureRunnerPreference(directory, wallet, { expectedInput });
  assert.equal(await Promise.race([captured.then(() => true), delay(40).then(() => false)]), false);
  await writeFile(join(directory, preferenceFile), '{broken');
  await release();
  assert.deepEqual(await captured, { preference: null, expectedStop: 'none', eligible: false });
  assert.equal(await readFile(join(directory, preferenceFile), 'utf8'), '{broken');
});

test('a replaced legacy runner cannot be adopted from an earlier bootstrap snapshot', async t => {
  const directory = await fixture(t); await legacy(directory);
  const expectedInput = await freezeInput(directory);
  const replacement = { ...lock, token: randomUUID() };
  await atomicWriteJson(join(directory, 'run.lock'), replacement);
  const captured = await captureRunnerPreference(directory, wallet, { expectedInput,
    alive: () => { throw new Error('changed legacy evidence must be rejected before adoption'); } });
  assert.deepEqual(captured, { preference: null, expectedStop: 'none', eligible: false });
  assert.equal(await readRunnerPreference(directory, wallet), null);
  assert.deepEqual(await readJson(join(directory, 'run.lock')), replacement);
});

test('ordinary live legacy portfolio refreshes preserve frozen adoption evidence', async t => {
  const directory = await fixture(t); await legacy(directory);
  const expectedInput = await freezeInput(directory);
  await atomicWriteJson(join(directory, 'status.json'), { ...status, updatedAt: new Date().toISOString(),
    portfolio: { fixture: 'new balances' }, graph: { node: 'wait' } });
  const captured = await captureRunnerPreference(directory, wallet, { expectedInput, alive: () => true });
  assert.equal(captured.eligible, true); assert.equal(captured.preference?.enabled, true);
});
