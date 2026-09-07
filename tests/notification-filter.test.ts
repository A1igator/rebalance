import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { RebalanceEvent } from '../src/events.js';
import { createNotificationFilter, readSuppressedEventIds } from '../src/notification-filter.js';
import { atomicWriteJson } from '../src/storage.js';

const epoch = Date.parse('2026-09-06T12:00:00Z');
const wallet = `0x${'a'.repeat(40)}`;
const message = 'Rebalance needs attention: Fresh portfolio holdings or prices could not be read. No completion is confirmed by this alert. Review the current agent status before recovery.';
const iso = (at: number) => new Date(at).toISOString();
const failure = (id: string, at = epoch): RebalanceEvent => ({ id, type: 'rebalance-attention', createdAt: iso(at), message });
const critical = (id = 'critical'): RebalanceEvent => ({ id, type: 'rebalance-completed', createdAt: iso(epoch), message: 'Completion retained.' });

async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'rebalance-notification-filter-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let now = epoch;
  const factory = (persist?: (path: string, value: unknown) => Promise<void>) => createNotificationFilter({ dataDir, now: () => now, persist });
  const status = async (kind: 'failure' | 'healthy' | 'intermediate', at = now, otherWallet = wallet) => atomicWriteJson(join(dataDir, 'status.json'), {
    wallet: otherWallet, error: kind === 'failure' ? 'Read unavailable.' : null,
    portfolio: { totalUsdE8: '100', positions: [{ id: 'USDG', balance: '100', priceUsdE8: '1', valueUsdE8: '100', weightBps: 10_000, targetBps: 10_000 }] },
    updatedAt: iso(at), graph: kind === 'failure' ? { node: 'error', trace: ['config', 'observe', 'error'] }
      : kind === 'healthy' ? { node: 'wait', trace: ['config', 'observe', 'plan', 'wait'] }
        : { node: 'observe', trace: ['config', 'observe'] },
  });
  return { dataDir, factory, status, setTime: (at: number) => { now = at; },
    suppressed: () => readSuppressedEventIds(dataDir),
    saved: async () => JSON.parse(await readFile(join(dataDir, 'read-notification-state.json'), 'utf8')) };
}

test('persistent failure becomes eligible at exactly two minutes and survives filter restart', async t => {
  const f = await fixture(t); await f.status('failure');
  const queue = [failure('read-1')];
  const initial = await f.factory().select(queue);
  assert.deepEqual(initial.events, []); assert.equal(initial.nextAt, epoch + 120_000);
  f.setTime(epoch + 119_999);
  assert.deepEqual((await f.factory().select(queue)).events, []);
  f.setTime(epoch + 120_000);
  assert.deepEqual((await f.factory().select(queue)).events, queue);
  assert.deepEqual((await f.factory().select(queue)).events, queue, 'same representative is retained for transport deduplication');
  queue.push(failure('read-2', epoch + 120_000));
  assert.deepEqual((await f.factory().select(queue)).events, [queue[0]]);
  assert.ok((await f.suppressed()).has('read-2'));
  assert.equal(queue[1].acknowledgedAt, undefined);
});

test('a fresh brief success suppresses an unreported failure and restarts the next failure timer', async t => {
  const f = await fixture(t); const first = failure('short-1');
  await f.status('failure'); await f.factory().select([first]);
  f.setTime(epoch + 30_000); await f.status('healthy', epoch + 30_000);
  assert.deepEqual((await f.factory().select([first])).events, []);
  assert.ok((await f.suppressed()).has(first.id));
  f.setTime(epoch + 40_000); await f.status('failure', epoch + 30_000);
  const second = failure('short-2', epoch + 40_000);
  const pending = await f.factory().select([first, second]);
  assert.equal(pending.nextAt, epoch + 160_000);
  f.setTime(epoch + 159_999);
  assert.deepEqual((await f.factory().select([first, second])).events, []);
});

test('a new failure UUID resets the unreported timer even if the brief successful status was missed', async t => {
  const f = await fixture(t); const first = failure('missed-1');
  await f.status('failure'); await f.factory().select([first]);
  f.setTime(epoch + 110_000);
  const result = await f.factory().select([first, failure('missed-2', epoch + 110_000)]);
  assert.deepEqual(result.events, []); assert.equal(result.nextAt, epoch + 230_000);
  assert.ok((await f.suppressed()).has(first.id));
});

test('intermediate and stale snapshots cannot clear an incident or manufacture recovery', async t => {
  const f = await fixture(t); const queue = [failure('stale')];
  await f.status('failure'); await f.factory().select(queue);
  f.setTime(epoch + 10_000); await f.status('intermediate', epoch + 5_000);
  await f.factory().select(queue); assert.notEqual((await f.saved()).incident, null);
  await f.status('healthy', epoch); await f.factory().select(queue);
  assert.notEqual((await f.saved()).incident, null, 'retained timestamp does not prove a successful read');
  f.setTime(epoch + 120_000); await f.status('failure'); await f.factory().select(queue);
  f.setTime(epoch + 130_000); await f.status('healthy'); await f.factory().select(queue);
  f.setTime(epoch + 190_000); await f.factory().select(queue);
  assert.notEqual((await f.saved()).incident, null, 'rereading one healthy snapshot after a minute is insufficient');
  await f.status('healthy', epoch + 190_000);
  assert.deepEqual((await f.factory().select(queue)).events, []);
  assert.equal((await f.saved()).incident, null);
  assert.ok((await f.suppressed()).has(queue[0].id));
});

test('reported incident survives short healthy gaps, then resets silently after advancing success for a minute', async t => {
  const f = await fixture(t); const queue = [failure('reported')];
  await f.status('failure'); await f.factory().select(queue);
  f.setTime(epoch + 120_000); await f.factory().select(queue);
  queue[0].acknowledgedAt = iso(epoch + 120_000);
  f.setTime(epoch + 125_000); await f.status('healthy'); await f.factory().select(queue);
  f.setTime(epoch + 150_000); await f.status('failure', epoch + 125_000);
  queue.push(failure('same-incident', epoch + 150_000));
  assert.deepEqual((await f.factory().select(queue)).events, []);
  f.setTime(epoch + 155_000); await f.status('healthy'); await f.factory().select(queue);
  f.setTime(epoch + 214_999); await f.status('healthy'); await f.factory().select(queue);
  assert.notEqual((await f.saved()).incident, null);
  f.setTime(epoch + 215_000); await f.status('healthy');
  assert.deepEqual((await f.factory().select(queue)).events, []);
  assert.equal((await f.saved()).incident, null, 'there is no synthetic recovery event');
  f.setTime(epoch + 216_000); await f.status('failure', epoch + 215_000);
  queue.push(failure('next-incident', epoch + 216_000));
  assert.equal((await f.factory().select(queue)).nextAt, epoch + 336_000);
});

test('historical failures and deterministic transaction recoveries stay retained but quiet', async t => {
  const f = await fixture(t); f.setTime(epoch + 200_000); await f.status('healthy');
  const queue = [failure('historical'), { ...critical('automatic'), type: 'rebalance-recovered' as const }, critical()];
  const before = JSON.stringify(queue);
  assert.deepEqual((await f.factory().select(queue)).events, [queue[2]]);
  assert.deepEqual(await f.suppressed(), new Set(['automatic', 'historical']));
  assert.equal(JSON.stringify(queue), before);
  const noStatus = await fixture(t);
  assert.deepEqual((await noStatus.factory().select([queue[1]])).events, []);
  assert.ok((await noStatus.suppressed()).has('automatic'), 'automatic recovery needs no portfolio read to be suppressed');
});

test('critical events and nonmatching attention pass through corrupt or missing status/state', async t => {
  const f = await fixture(t);
  const direct = [critical(), { ...critical('ledger'), type: 'ledger-rebalance-needed' as const },
    { ...failure('other-phase'), message: 'Rebalance needs attention: transaction outcome unknown.' },
    { ...failure('hashed-attention'), hash: `0x${'a'.repeat(64)}` }];
  assert.deepEqual((await f.factory().select(direct)).events, direct);
  const queue = [failure('deferred'), ...direct];
  for (const content of [null, '{corrupt', JSON.stringify({ wallet, error: null, updatedAt: null })]) {
    if (content !== null) await writeFile(join(f.dataDir, 'status.json'), content);
    const result = await f.factory().select(queue);
    assert.deepEqual(result.events, direct); assert.equal(result.error, 'filter-unavailable');
    assert.equal(result.nextAt, epoch + 30_000);
  }
  await f.status('failure'); await writeFile(join(f.dataDir, 'read-notification-state.json'), '{corrupt');
  assert.deepEqual((await f.factory().select(queue)).events, direct);
});

test('save failure defers a matured read alert without losing critical alerts or claiming suppression', async t => {
  const f = await fixture(t); await f.status('failure');
  const queue = [failure('persist'), critical()]; await f.factory().select(queue);
  const before = await readFile(join(f.dataDir, 'read-notification-state.json'), 'utf8');
  f.setTime(epoch + 120_000);
  const failed = await f.factory(async () => { throw new Error('fixture save failure'); }).select(queue);
  assert.deepEqual(failed.events, [queue[1]]); assert.equal(failed.error, 'filter-unavailable');
  assert.equal(await readFile(join(f.dataDir, 'read-notification-state.json'), 'utf8'), before);
  assert.deepEqual((await f.factory().select(queue)).events, [queue[1], queue[0]]);
});

test('bootstrap never promotes old acknowledged history or failures predating a retained successful read', async t => {
  const f = await fixture(t); f.setTime(epoch + 600_000);
  await f.status('failure', epoch + 500_000);
  const acknowledged = { ...failure('old-ack'), acknowledgedAt: iso(epoch + 10_000) };
  const old = failure('old-unreported');
  const history = await f.factory().select([acknowledged, old]);
  assert.deepEqual(history.events, []); assert.equal(history.nextAt, null);
  assert.equal((await f.saved()).incident, null);
  assert.ok((await f.suppressed()).has(old.id));
  const latest = failure('new-failure', epoch + 600_000);
  const started = await f.factory().select([acknowledged, old, latest]);
  assert.equal(started.nextAt, epoch + 720_000);
  f.setTime(epoch + 720_000);
  assert.deepEqual((await f.factory().select([acknowledged, old, latest])).events, [latest]);
});

test('a completed graph and advancing timestamps without portfolio data cannot prove successful reads', async t => {
  const f = await fixture(t); const queue = [failure('missing-portfolio')];
  await f.status('failure'); await f.factory().select(queue);
  f.setTime(epoch + 30_000); await f.status('healthy');
  const path = join(f.dataDir, 'status.json');
  const saved = JSON.parse(await readFile(path, 'utf8'));
  for (const portfolio of [null, {}, { totalUsdE8: '100', positions: [] }, { totalUsdE8: '100', positions: [{ id: 'USDG' }] }]) {
    await atomicWriteJson(path, { ...saved, portfolio });
    await f.factory().select(queue);
    assert.notEqual((await f.saved()).incident, null);
  }
});

test('future timestamps, clock rollback and a different wallet cannot establish recovery', async t => {
  const f = await fixture(t); await f.status('failure');
  assert.equal((await f.factory().select([failure('future', epoch + 1)])).error, 'filter-unavailable');
  const queue = [failure('clock')]; await f.factory().select(queue);
  f.setTime(epoch + 120_000); await f.factory().select(queue);
  f.setTime(epoch + 119_999);
  assert.equal((await f.factory().select(queue)).error, 'filter-unavailable');
  f.setTime(epoch + 130_000); await f.status('healthy', epoch + 130_001);
  assert.equal((await f.factory().select(queue)).error, 'filter-unavailable');
  await f.status('healthy', epoch + 130_000, `0x${'b'.repeat(40)}`);
  assert.deepEqual((await f.factory().select(queue)).events, []);
  assert.ok((await f.suppressed()).has('clock'));
  assert.equal((await f.saved()).suppressed.find((entry: { id: string }) => entry.id === 'clock').reason, 'previous-wallet');
});
