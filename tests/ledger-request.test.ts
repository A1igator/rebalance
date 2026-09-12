import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { validateConfig } from '../src/config.js';
import { LedgerExecution, ledgerConfigFingerprint, readLedgerRequest, readLedgerPromptState, requestLedgerRebalance } from '../src/ledger-request.js';
import { atomicWriteJson, readJson } from '../src/storage.js';

async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'rebalance-ledger-request-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let now = 1_800_000_000_000;
  const config = validateConfig({ version: 1, chainId: 4663, wallet: '0x0000000000000000000000000000000000000001',
    mode: 'ledger', rpcUrl: 'http://ledger-request-fixture.invalid', targets: { USDG: 500, AAPL: 2375, NVDA: 2375, MSFT: 2375, AMD: 2375 },
    driftThresholdBps: 500, slippageBps: 50, deadlineSeconds: 120, pollSeconds: 5 });
  const runner = { pid: 424242, token: randomUUID(), createdAt: new Date(now).toISOString() };
  const options = { dataDir, pid: runner.pid, now: () => now, isAlive: (pid: number) => pid === runner.pid };
  const path = (file: string) => join(dataDir, file);
  await atomicWriteJson(path('config.json'), config);
  await atomicWriteJson(path('run.lock'), runner);
  return { config, runner, options, path, advance: (ms: number) => { now += ms; },
    request: (id?: string) => requestLedgerRebalance(id, options),
    read: () => readLedgerRequest(options), execution: () => new LedgerExecution(options) };
}

test('request queues public runner-bound intent, without modifying execution or wallet files', async t => {
  const f = await fixture(t);
  const preserved = ['config.json', 'run.lock', 'pending.json', 'cycle.json', 'status.json', 'wallet.json'];
  for (const file of preserved.slice(2)) await atomicWriteJson(f.path(file), { fixture: file });
  const before = await Promise.all(preserved.map(file => readFile(f.path(file), 'utf8')));
  const id = randomUUID(), record = await f.request(id);
  assert.equal(record.id, id); assert.equal(record.state, 'requested');
  assert.equal(record.runnerPid, f.runner.pid); assert.equal(record.runnerToken, f.runner.token);
  assert.equal(record.configFingerprint, ledgerConfigFingerprint(f.config));
  assert.equal(record.queueExpiresAt - record.createdAt, 120_000);
  assert.equal(record.expiresAt - record.createdAt, 600_000);
  assert.deepEqual(await f.read(), record);
  assert.deepEqual(await Promise.all(preserved.map(file => readFile(f.path(file), 'utf8'))), before);
  assert.equal(await readJson(f.path('stop.json')), null);
});

test('only configured Ledger with an existing live tokenized runner and no stop can request', async t => {
  const f = await fixture(t);
  await assert.rejects(f.request('../unsafe'), /UUID/);
  await atomicWriteJson(f.path('config.json'), { ...f.config, mode: 'private-key' });
  await assert.rejects(f.request(), /does not use Ledger/);
  await atomicWriteJson(f.path('config.json'), f.config);
  await rm(f.path('run.lock'));
  await assert.rejects(f.request(), /Start this Ledger portfolio monitor/);
  await atomicWriteJson(f.path('run.lock'), { ...f.runner, pid: 111 });
  await assert.rejects(f.request(), /Start this Ledger portfolio monitor/);
  await atomicWriteJson(f.path('run.lock'), { pid: f.runner.pid });
  await assert.rejects(f.request(), /Invalid Ledger runner identity/);
  await atomicWriteJson(f.path('run.lock'), f.runner);
  await atomicWriteJson(f.path('stop.json'), { requestId: randomUUID() });
  await assert.rejects(f.request(), /stop request/);
  assert.equal(await f.read(), null);
});

test('claim is durable before permission, consumes once and supports only the same in-memory owner', async t => {
  const f = await fixture(t), execution = f.execution();
  assert.equal(execution.active, false); assert.equal(execution.expiresAt, undefined);
  await assert.rejects(execution.assertReady(f.config), /No active/);
  const request = await f.request();
  await execution.prepare(f.config);
  assert.equal((await f.read())?.state, 'consumed');
  assert.equal(execution.active, true); assert.equal(execution.expiresAt, request.expiresAt);
  await execution.assertReady(f.config);
  await execution.prepare(f.config);
  assert.equal(execution.active, true);
  await execution.finish('completed');
  assert.equal(execution.active, false);
  assert.equal((await f.read())?.outcome, 'completed');
  await execution.prepare(f.config);
  assert.equal(execution.active, false);
  await assert.rejects(f.request(request.id), /already used/);
  assert.equal((await f.read())?.state, 'finished');
});

test('unexpired pending and consumed intents cannot be superseded by new IDs', async t => {
  const f = await fixture(t), execution = f.execution(), first = await f.request();
  await assert.rejects(f.request(), /already pending or active/);
  assert.equal((await f.read())?.id, first.id);
  await execution.prepare(f.config);
  await assert.rejects(f.request(), /already pending or active/);
  assert.equal((await f.read())?.id, first.id);
});

test('a reconstructed runner never resumes consumed intent, even with the same PID and token', async t => {
  const f = await fixture(t), old = f.execution();
  await f.request(); await old.prepare(f.config);
  const restarted = f.execution(); await restarted.prepare(f.config);
  assert.equal(restarted.active, false);
  assert.equal((await f.read())?.outcome, 'runner-restarted');
  await assert.rejects(old.assertReady(f.config), /changed or was already consumed/);
  assert.equal(old.active, false);
});

test('PID and runner-token changes invalidate both queued and active requests', async t => {
  for (const state of ['requested', 'consumed']) {
    for (const change of ['pid', 'token', 'other-process']) {
      const f = await fixture(t), execution = f.execution();
      await f.request(); if (state === 'consumed') await execution.prepare(f.config);
      if (change === 'pid') await atomicWriteJson(f.path('run.lock'), { ...f.runner, pid: 111 });
      if (change === 'token') await atomicWriteJson(f.path('run.lock'), { ...f.runner, token: randomUUID() });
      const target = change === 'other-process' ? new LedgerExecution({ ...f.options, pid: 222 }) : execution;
      await target.prepare(f.config);
      assert.equal(target.active, false);
      assert.equal((await f.read())?.state, 'finished');
    }
  }
});

test('queue expires after two minutes and active execution after ten minutes from request', async t => {
  const f = await fixture(t), queued = await f.request(), execution = f.execution();
  f.advance(120_000); await execution.prepare(f.config);
  assert.equal(execution.active, false); assert.equal((await f.read())?.outcome, 'expired');
  await assert.rejects(f.request(queued.id), /already used/);
  const active = await f.request(); await execution.prepare(f.config);
  f.advance(599_999); await execution.assertReady(f.config);
  f.advance(1); assert.equal(execution.active, false);
  await assert.rejects(execution.assertReady(f.config), /expired/);
  assert.equal((await f.read())?.state, 'finished');
  await assert.rejects(f.request(active.id), /already used/);
});

test('stop or changed wallet, signer, targets and saved configuration invalidate without revival', async t => {
  for (const state of ['requested', 'consumed']) {
    for (const change of ['stop', 'targets', 'wallet', 'mode', 'passed-config']) {
      const f = await fixture(t), execution = f.execution(), request = await f.request();
      if (state === 'consumed') await execution.prepare(f.config);
      let current = f.config;
      if (change === 'stop') await atomicWriteJson(f.path('stop.json'), { requestId: randomUUID() });
      if (change === 'targets') current = { ...f.config, targets: { ...f.config.targets, USDG: 600, AAPL: 2275 } };
      if (change === 'wallet') current = { ...f.config, wallet: '0x0000000000000000000000000000000000000002' };
      if (change === 'mode') current = { ...f.config, mode: 'privy' };
      if (change !== 'passed-config') await atomicWriteJson(f.path('config.json'), current);
      else current = { ...f.config, slippageBps: 51 };
      await execution.prepare(current);
      assert.equal(execution.active, false, `${state}: ${change}`);
      assert.equal((await f.read())?.state, 'finished');
      await atomicWriteJson(f.path('config.json'), f.config); await rm(f.path('stop.json'), { force: true });
      await execution.prepare(f.config); assert.equal(execution.active, false);
      await assert.rejects(f.request(request.id), /already used/);
    }
  }
});

test('canonical config fingerprints ignore ordering but bind all configured execution options', async t => {
  const { config } = await fixture(t);
  const reordered = { ...config, targets: Object.fromEntries(Object.entries(config.targets).reverse()) };
  assert.equal(ledgerConfigFingerprint(config), ledgerConfigFingerprint(reordered));
  assert.notEqual(ledgerConfigFingerprint(config), ledgerConfigFingerprint({ ...config, rpcUrl: 'http://other.invalid' }));
  assert.notEqual(ledgerConfigFingerprint(config), ledgerConfigFingerprint({ ...config, deadlineSeconds: 121 }));
});

test('all prior request IDs survive later requests and expired records', async t => {
  const f = await fixture(t), ids: string[] = [];
  for (let i = 0; i < 12; i++) {
    const request = await f.request(); ids.push(request.id);
    f.advance(120_000);
  }
  const latest = await f.request();
  for (const id of ids) await assert.rejects(f.request(id), /already used/);
  assert.equal((await f.read())?.id, latest.id);
  const journal = await readJson<{ records: unknown[] }>(f.path('ledger-request.json'));
  assert.equal(journal?.records.length, 13);
});

test('journal corruption and external record changes fail closed without signing permission', async t => {
  const f = await fixture(t), execution = f.execution();
  await f.request(); await execution.prepare(f.config);
  const original = await readFile(f.path('ledger-request.json'), 'utf8');
  await writeFile(f.path('ledger-request.json'), '{');
  await assert.rejects(execution.assertReady(f.config));
  assert.equal(execution.active, false);
  await writeFile(f.path('ledger-request.json'), original);
  await execution.prepare(f.config);
  assert.equal(execution.active, false);
  assert.equal((await f.read())?.outcome, 'runner-restarted');
  const value = JSON.parse(original); value.records[0].expiresAt += 60_000;
  await atomicWriteJson(f.path('ledger-request.json'), value);
  await assert.rejects(f.read(), /Invalid Ledger request journal/);
  await assert.rejects(f.request(), /Invalid Ledger request journal/);
});

test('concurrent queue commands create only one durable request', async t => {
  const f = await fixture(t);
  const results = await Promise.allSettled([f.request(), f.request()]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const journal = await readJson<{ records: unknown[] }>(f.path('ledger-request.json'));
  assert.equal(journal?.records.length, 1);
});

test('malformed public control files invalidate queued intent and do not leak their contents', async t => {
  for (const file of ['config.json', 'run.lock', 'stop.json']) {
    const f = await fixture(t), execution = f.execution();
    await f.request();
    const old = await readFile(f.path(file), 'utf8').catch(() => null);
    await writeFile(f.path(file), 'private-fixture-string-not-for-error-text');
    await assert.rejects(execution.prepare(f.config), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /unavailable or invalid/);
      assert.ok(!error.message.includes('private-fixture-string'));
      return true;
    });
    assert.equal(execution.active, false); assert.equal((await f.read())?.outcome, 'invalidated');
    if (old === null) await rm(f.path(file)); else await writeFile(f.path(file), old);
    await execution.prepare(f.config); assert.equal(execution.active, false);
  }
});

test('terminal persistence failure cannot leave in-memory authorization active', async t => {
  const f = await fixture(t), execution = f.execution();
  await f.request(); await execution.prepare(f.config);
  await writeFile(f.path('ledger-request.json'), 'private-fixture-string-not-for-error-text');
  await assert.rejects(execution.finish('error'), { message: 'Ledger request journal is unavailable or invalid; signing remains unavailable' });
  assert.equal(execution.active, false); assert.equal(execution.expiresAt, undefined);
  await assert.rejects(execution.assertReady(f.config), /No active/);
});

test('a request dispatched near an existing cycle end cannot renew into another cycle', async t => {
  const f = await fixture(t), execution = f.execution(), request = await f.request();
  await execution.prepare(f.config);
  const first = { wallet: f.config.wallet, startedAt: request.createdAt - 599_000, activeUntil: request.createdAt + 1_000 };
  await atomicWriteJson(f.path('cycle.json'), first);
  await execution.bindCycle({ startedAt: new Date(first.startedAt).toISOString(), activeUntil: new Date(first.activeUntil).toISOString() });
  assert.equal(execution.expiresAt, first.activeUntil);
  await execution.assertReady(f.config);
  f.advance(1_000);
  assert.equal(execution.active, false);
  await assert.rejects(execution.assertReady(f.config), /expired/);
  assert.equal((await f.read())?.state, 'finished');
  const next = { wallet: f.config.wallet, startedAt: first.activeUntil, activeUntil: first.activeUntil + 600_000 };
  await atomicWriteJson(f.path('cycle.json'), next);
  await assert.rejects(execution.bindCycle({ startedAt: new Date(next.startedAt).toISOString(), activeUntil: new Date(next.activeUntil).toISOString() }), /No active/);
  await execution.prepare(f.config);
  assert.equal(execution.active, false);
  await assert.rejects(f.request(request.id), /already used/);
});

test('changed cycle identity, shortened deadline or removed cycle invalidates the bound request', async t => {
  for (const change of ['startedAt', 'activeUntil', 'wallet', 'removed']) {
    const f = await fixture(t), execution = f.execution(), request = await f.request();
    await execution.prepare(f.config);
    const cycle = { wallet: f.config.wallet, startedAt: request.createdAt, activeUntil: request.createdAt + 600_000 };
    const publicCycle = { startedAt: new Date(cycle.startedAt).toISOString(), activeUntil: new Date(cycle.activeUntil).toISOString() };
    await atomicWriteJson(f.path('cycle.json'), cycle);
    await execution.bindCycle(publicCycle); await execution.bindCycle(publicCycle);
    if (change === 'removed') await rm(f.path('cycle.json'));
    else await atomicWriteJson(f.path('cycle.json'), { ...cycle, [change]: change === 'wallet' ? '0x0000000000000000000000000000000000000002' : cycle[change as 'startedAt' | 'activeUntil'] + (change === 'activeUntil' ? -1 : 1) });
    await assert.rejects(execution.assertReady(f.config), /cycle changed/);
    assert.equal(execution.active, false); assert.equal((await f.read())?.state, 'finished');
  }
});

test('cycle binding rejects invalid timestamps and never extends the request deadline', async t => {
  for (const cycle of [
    { startedAt: 'invalid', activeUntil: 'invalid' },
    { startedAt: '2027-01-15T08:00:00.000Z', activeUntil: 'Infinity' },
    { startedAt: '2027-01-15T08:00:00.000Z', activeUntil: '2027-01-15T07:59:59.000Z' },
  ]) {
    const f = await fixture(t), execution = f.execution();
    await f.request(); await execution.prepare(f.config);
    await assert.rejects(execution.bindCycle(cycle), /Invalid or expired/);
    assert.equal(execution.active, false); assert.equal((await f.read())?.outcome, 'cycle-invalidated');
  }
  const f = await fixture(t), execution = f.execution(), request = await f.request();
  await execution.prepare(f.config); f.advance(10_000);
  const cycle = { wallet: f.config.wallet, startedAt: request.createdAt + 10_000, activeUntil: request.createdAt + 610_000 };
  await atomicWriteJson(f.path('cycle.json'), cycle);
  await execution.bindCycle({ startedAt: new Date(cycle.startedAt).toISOString(), activeUntil: new Date(cycle.activeUntil).toISOString() });
  assert.equal(execution.expiresAt, request.expiresAt);
  await execution.assertReady(f.config);
});

test('finish racing an in-flight assertion cannot return signing permission', async t => {
  const f = await fixture(t);
  let interrupt = false, finished: Promise<void> | undefined;
  const execution = new LedgerExecution({ ...f.options, isAlive: pid => {
    if (interrupt) { interrupt = false; finished = execution.finish('stopped'); }
    return pid === f.runner.pid;
  } });
  await f.request(); await execution.prepare(f.config);
  interrupt = true;
  await assert.rejects(execution.assertReady(f.config), /ended during validation/);
  await finished;
  assert.equal(execution.active, false); assert.equal((await f.read())?.outcome, 'stopped');
});

test('finish racing a durable claim cannot establish in-memory signing permission', async t => {
  const f = await fixture(t);
  let interrupted = false;
  const execution = new LedgerExecution({ ...f.options, isAlive: pid => {
    if (!interrupted) { interrupted = true; void execution.finish('stopped'); }
    return pid === f.runner.pid;
  } });
  await f.request(); await execution.prepare(f.config);
  assert.equal(execution.active, false); assert.equal((await f.read())?.outcome, 'invalidated');
});

test('queue expiration during claim persistence and expiry during assertion remain fail-closed', async t => {
  const f = await fixture(t), request = await f.request();
  let reads = 0;
  const claiming = new LedgerExecution({ ...f.options, now: () => ++reads >= 3 ? request.queueExpiresAt : request.createdAt });
  await claiming.prepare(f.config);
  assert.equal(claiming.active, false); assert.equal((await f.read())?.outcome, 'expired');
  const next = await f.request();
  let expire = false;
  const execution = new LedgerExecution({ ...f.options, isAlive: pid => {
    if (expire) { expire = false; f.advance(600_000); }
    return pid === f.runner.pid;
  } });
  await execution.prepare(f.config);
  assert.equal(execution.expiresAt, next.expiresAt);
  expire = true;
  await assert.rejects(execution.assertReady(f.config), /expired/);
  assert.equal(execution.active, false); assert.equal((await f.read())?.state, 'finished');
});


test('connected backend creates one bounded runner-owned execution without an explicit request', async t => {
  const f = await fixture(t), execution = f.execution();
  assert.equal(await execution.prepareAutomatic(f.config), false);
  await execution.observePresence(true);
  assert.equal(await execution.prepareAutomatic(f.config), true);
  const first = await f.read();
  assert.equal(first?.state, 'consumed');
  assert.equal(first?.runnerToken, f.runner.token);
  await execution.assertReady(f.config);
  assert.equal(await execution.prepareAutomatic(f.config), true);
  assert.equal((await f.read())?.id, first?.id);
  await execution.finish('on-target');
  assert.equal(await execution.prepareAutomatic(f.config), true);
  assert.notEqual((await f.read())?.id, first?.id, 'a later successful cycle gets fresh bounded execution');
});

for (const outcome of ['rejected', 'timeout', 'unavailable', 'unsupported', 'invalid-signature', 'failed']) {
  test(`automatic ${outcome} suspension survives restart and clears only after observed reconnect or explicit retry`, async t => {
    const f = await fixture(t), first = f.execution();
    await first.observePresence(true); await first.prepareAutomatic(f.config); await first.finish(outcome);
    assert.deepEqual(await readLedgerPromptState(f.options), { suspended: true, outcome });
    const restarted = f.execution();
    await restarted.observePresence(true);
    assert.equal(await restarted.prepareAutomatic(f.config), false, 'a fresh process observing connected is not a reconnect');
    await restarted.observePresence(false);
    const again = f.execution();
    await again.observePresence(true);
    assert.equal(await again.prepareAutomatic(f.config), true, 'the actual disconnect edge survives a process restart');
    await again.finish(outcome);
    const retry = await f.request();
    assert.deepEqual(await readLedgerPromptState(f.options), { suspended: false });
    await again.prepare(f.config);
    assert.equal(again.active, true); assert.equal((await f.read())?.id, retry.id);
  });
}

test('an interrupted automatic execution suspends instead of silently replacing the consumed request', async t => {
  const f = await fixture(t), first = f.execution();
  await first.observePresence(true); await first.prepareAutomatic(f.config);
  const id = (await f.read())!.id;
  const restarted = f.execution(); await restarted.observePresence(true); await restarted.prepare(f.config);
  assert.equal(await restarted.prepareAutomatic(f.config), false);
  assert.equal((await f.read())?.id, id);
  assert.deepEqual(await readLedgerPromptState(f.options), { suspended: true, outcome: 'runner-restarted' });
});

test('automatic creation preserves stop, pending request and wrong runner/config boundaries', async t => {
  for (const change of ['stop', 'owner', 'config', 'explicit']) {
    const f = await fixture(t), execution = f.execution();
    await execution.observePresence(true);
    if (change === 'stop') await atomicWriteJson(f.path('stop.json'), { requestedAt: 'fixture' });
    if (change === 'owner') await atomicWriteJson(f.path('run.lock'), { ...f.runner, pid: 111 });
    if (change === 'config') await atomicWriteJson(f.path('config.json'), { ...f.config, slippageBps: 51 });
    if (change === 'explicit') {
      const pending = await f.request();
      assert.equal(await execution.prepareAutomatic(f.config), true);
      assert.equal((await f.read())?.id, pending.id);
    } else {
      assert.equal(await execution.prepareAutomatic(f.config), false);
      assert.equal(await f.read(), null);
    }
  }
});

test('legacy failed journal upgrade stays suspended until explicit retry or genuine reconnection', async t => {
  const f = await fixture(t), execution = f.execution();
  await f.request(); await execution.prepare(f.config); await execution.finish('unavailable');
  const journal = await readJson<Record<string, unknown>>(f.path('ledger-request.json'));
  delete journal!.suspension;
  await atomicWriteJson(f.path('ledger-request.json'), journal);
  await execution.observePresence(true);
  assert.equal(await execution.prepareAutomatic(f.config), false);
  await execution.observePresence(false); await execution.observePresence(true);
  assert.equal(await execution.prepareAutomatic(f.config), true);
});


test('a genuine disconnect observed before restart invalidation still permits the subsequent reconnect', async t => {
  const f = await fixture(t), original = f.execution();
  await original.observePresence(true); await original.prepareAutomatic(f.config);
  const restarted = f.execution();
  await restarted.observePresence(false); await restarted.prepare(f.config);
  assert.equal((await readLedgerPromptState(f.options)).suspended, true);
  await restarted.observePresence(true);
  assert.equal(await restarted.prepareAutomatic(f.config), true);
});

test('stop invalidation racing automatic request creation cannot establish an execution', async t => {
  const f = await fixture(t);
  let invalidate = false;
  const execution = new LedgerExecution({ ...f.options, isAlive: pid => {
    if (invalidate) { invalidate = false; void execution.finish('stopped'); }
    return pid === f.runner.pid;
  } });
  await execution.observePresence(true); invalidate = true;
  assert.equal(await execution.prepareAutomatic(f.config), false);
  assert.equal(execution.active, false); assert.equal(await f.read(), null);
});
