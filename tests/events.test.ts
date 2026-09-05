import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { promisify } from 'node:util';
import type { RebalanceEvent } from '../src/events.js';

// Set the data directory before importing modules that capture it at load time.
const directory = await mkdtemp(join(tmpdir(), 'rebalance-events-test-'));
const previousDirectory = process.env.REBALANCE_DATA_DIR;
process.env.REBALANCE_DATA_DIR = directory;
const { events, publishEvent, acknowledgeEvent, ledgerCondition, rebalanceCompleted, attentionCondition, transactionRecovered } = await import('../src/events.js');
const queuePath = join(directory, 'events.json');
const conditionPath = join(directory, 'notification-state.json');

beforeEach(async () => {
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
});
after(async () => {
  if (previousDirectory === undefined) delete process.env.REBALANCE_DATA_DIR;
  else process.env.REBALANCE_DATA_DIR = previousDirectory;
  await rm(directory, { recursive: true, force: true });
});

function sample(id: string): RebalanceEvent {
  return { id, type: 'rebalance-completed', createdAt: '2026-09-04T20:00:00.000Z', message: `Recorded receipt event ${id}` };
}
async function savedQueue(): Promise<RebalanceEvent[]> {
  return JSON.parse(await readFile(queuePath, 'utf8')) as RebalanceEvent[];
}

test('verified recovery events remain distinct from full completion and survive replay after acknowledgement', async () => {
  const hash = `0x${'ab'.repeat(32)}`;
  await transactionRecovered(hash, 'cancelled');
  const [event] = await events();
  assert.equal(event.type, 'rebalance-recovered');
  assert.match(event.message, /not a completed rebalance/);
  await acknowledgeEvent(event.id);
  await transactionRecovered(hash.toUpperCase().replace('0X', '0x'), 'cancelled');
  assert.deepEqual(await events(), []);
  await assert.rejects(transactionRecovered('invalid', 'cancelled'), /Invalid recovery receipt/);
  await assert.rejects(transactionRecovered(hash, 'made-up' as 'cancelled'), /Invalid recovery outcome/);
});

test('offline events are durable and duplicate publication cannot overwrite the original', async () => {
  assert.deepEqual(await events(), []);
  const first = sample('receipt-one');
  const second = sample('receipt-two');
  await publishEvent(first);
  await publishEvent(second);
  await publishEvent({ ...first, message: 'Duplicate with different content' });
  assert.deepEqual(await events(), [first, second]);
  assert.deepEqual(await savedQueue(), [first, second]);
});

test('acknowledgement hides only the handled event and retains durable history and other offline events', async () => {
  await publishEvent(sample('handled'));
  await publishEvent(sample('offline'));
  await acknowledgeEvent('handled');
  const firstAcknowledgement = (await savedQueue())[0]!.acknowledgedAt;
  assert.ok(firstAcknowledgement && Number.isFinite(Date.parse(firstAcknowledgement)));
  await acknowledgeEvent('handled');
  await publishEvent(sample('handled'));
  assert.deepEqual((await events()).map(event => event.id), ['offline']);
  const persisted = await savedQueue();
  assert.equal(persisted.length, 2);
  assert.equal(persisted[0]!.acknowledgedAt, firstAcknowledgement);
  assert.equal(persisted[1]!.acknowledgedAt, undefined);
  await assert.rejects(acknowledgeEvent('missing'), /Unknown notification event/);
  assert.deepEqual(await savedQueue(), persisted);
});

test('Ledger conditions alert once per transition, including after acknowledgement, without monitor-tick flooding', async () => {
  const wallet = `0x${'a'.repeat(40)}`;
  const targets = { USDG: 2_000, TSLA: 2_000, AAPL: 2_000, NVDA: 2_000, AMZN: 2_000 };
  await ledgerCondition(wallet, targets, false);
  assert.deepEqual(await events(), []);
  await ledgerCondition(wallet, targets, true);
  const first = (await events())[0]!;
  assert.equal(first.type, 'ledger-rebalance-needed');
  for (let tick = 0; tick < 5; tick += 1) {
    await ledgerCondition(wallet.toUpperCase(), Object.fromEntries(Object.entries(targets).reverse()), true);
  }
  assert.deepEqual((await events()).map(event => event.id), [first.id]);
  await acknowledgeEvent(first.id);
  await ledgerCondition(wallet, targets, true);
  assert.deepEqual(await events(), []);

  const changedTargets = { ...targets, USDG: 3_000, TSLA: 1_000 };
  await ledgerCondition(wallet, changedTargets, true);
  const changed = (await events())[0]!;
  assert.notEqual(changed.id, first.id);
  await ledgerCondition(wallet, changedTargets, false);
  await ledgerCondition(wallet, changedTargets, true);
  const queued = await events();
  assert.equal(queued.length, 2);
  assert.equal(new Set(queued.map(event => event.id)).size, 2);
  for (let tick = 0; tick < 5; tick += 1) await ledgerCondition(wallet, changedTargets, true);
  assert.deepEqual(await events(), queued);
  assert.equal((await savedQueue()).length, 3);
});

test('a persisted Ledger transition repairs a crash before queue publication using the same event identity', async () => {
  const wallet = `0x${'b'.repeat(40)}`;
  const targets = { USDG: 10_000, TSLA: 0, AAPL: 0, NVDA: 0, AMZN: 0 };
  await ledgerCondition(wallet, targets, true);
  const condition = JSON.parse(await readFile(conditionPath, 'utf8')) as { event: RebalanceEvent };
  // Simulate the recorded condition surviving while its queue write never landed.
  await rm(queuePath);
  await ledgerCondition(wallet, targets, true);
  assert.deepEqual(await events(), [condition.event]);
  await ledgerCondition(wallet, targets, true);
  assert.equal((await savedQueue()).length, 1);
});

test('completion events deduplicate by case-insensitive receipt hash and reject invalid identities', async () => {
  const hash = `0x${'ab'.repeat(32)}`;
  await rebalanceCompleted(hash);
  await rebalanceCompleted(`0x${'AB'.repeat(32)}`);
  const queued = await events();
  assert.equal(queued.length, 1);
  assert.equal(queued[0]!.id, `rebalance-${hash}`);
  assert.equal(queued[0]!.hash, hash);
  await acknowledgeEvent(queued[0]!.id);
  await rebalanceCompleted(hash);
  assert.deepEqual(await events(), []);
  for (const invalid of ['', '0x1234', `0x${'z'.repeat(64)}`]) {
    await assert.rejects(rebalanceCompleted(invalid), /Invalid receipt hash/);
  }
  assert.equal((await savedQueue()).length, 1);
});

test('attention conditions deduplicate across acknowledgement and process restart, then allow meaningful transitions', async () => {
  const wallet = `0x${'a'.repeat(40)}`;
  const hash = `0x${'ab'.repeat(32)}`;
  await attentionCondition(wallet, { kind: 'unresolved', hash });
  const first = (await events())[0]!;
  assert.equal(first.type, 'rebalance-attention');
  assert.equal(first.hash, hash);
  assert.match(first.message, /unknown outcome/);
  await acknowledgeEvent(first.id);
  await attentionCondition(`0x${'A'.repeat(40)}`, { kind: 'unresolved', hash: `0x${'AB'.repeat(32)}` });
  const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    const { attentionCondition, events } = await import(process.argv[1]);
    await attentionCondition(process.argv[2], { kind: 'unresolved', hash: process.argv[3] });
    process.stdout.write(JSON.stringify(await events()));
  `, '--', new URL('../src/events.ts', import.meta.url).href, wallet, hash],
  { env: { ...process.env, REBALANCE_DATA_DIR: directory }, timeout: 10_000 });
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), []);
  assert.equal((await savedQueue()).length, 1);

  await attentionCondition(wallet, { kind: 'unresolved', hash: `0x${'cd'.repeat(32)}` });
  await attentionCondition(wallet, { kind: 'runtime-failure', phase: 'observe' });
  const changed = await events();
  assert.equal(changed.length, 2);
  await attentionCondition(wallet, { kind: 'runtime-failure', phase: 'observe' });
  assert.deepEqual(await events(), changed);
  await attentionCondition(wallet, null);
  await attentionCondition(wallet, { kind: 'runtime-failure', phase: 'observe' });
  assert.equal((await events()).length, 3, 'a later recurrence after recovery gets a fresh identity');
  await attentionCondition(`0x${'b'.repeat(40)}`, { kind: 'runtime-failure', phase: 'observe' });
  assert.equal((await events()).length, 4, 'a different wallet has its own condition identity');
});

test('attention repairs an interrupted queue write even when the condition has already recovered', async () => {
  const wallet = `0x${'c'.repeat(40)}`;
  await attentionCondition(wallet, { kind: 'reverted', hash: `0x${'12'.repeat(32)}` });
  const first = (await events())[0]!;
  await rm(queuePath);
  await attentionCondition(wallet, null);
  assert.deepEqual(await events(), [first]);
  await acknowledgeEvent(first.id);
  await attentionCondition(wallet, null);
  assert.deepEqual(await events(), []);
  await attentionCondition(wallet, { kind: 'reverted', hash: first.hash });
  assert.notEqual((await events())[0]!.id, first.id);
  assert.equal((await savedQueue()).length, 2);
});

test('attention notifications store only fixed descriptions and validated public hashes', async () => {
  const wallet = `0x${'d'.repeat(40)}`;
  const secret = 'fixture-secret-provider-payload';
  await attentionCondition(wallet, { kind: 'runtime-failure', phase: 'quote', message: secret } as never);
  const first = (await events())[0]!;
  assert.match(first.message, /usable swap quote/);
  assert.equal(first.hash, undefined);
  for (const invalid of [
    { kind: 'unresolved', hash: secret }, { kind: secret }, { kind: 'runtime-failure', phase: secret },
  ]) await assert.rejects(attentionCondition(wallet, invalid as never), error => {
    assert.doesNotMatch(String(error), /fixture-secret/);
    return true;
  });
  const queue = await readFile(queuePath, 'utf8');
  const condition = await readFile(join(directory, 'attention-state.json'), 'utf8');
  assert.doesNotMatch(queue + condition, /fixture-secret/);
  assert.equal((queue + condition).includes(wallet), false);
  assert.equal((await savedQueue()).length, 1);
});
