import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as flush, setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { createEventStream, type EventStreamDependencies, type EventStreamFailure } from '../src/event-stream.js';

type Item = { id: string };
class Clock {
  now = 0;
  nextId = 0;
  timers = new Map<number, { at: number; callback: () => void }>();
  after = (ms: number, callback: () => void) => {
    const id = ++this.nextId;
    this.timers.set(id, { at: this.now + ms, callback });
    return () => { this.timers.delete(id); };
  };
  advance(ms: number) {
    const until = this.now + ms;
    for (;;) {
      const next = [...this.timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > until) break;
      this.now = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
    }
    this.now = until;
  }
}
function fixture(options: { queue?: Item[]; read?: () => Promise<Item[]>; deliver?: (item: Item) => Promise<void | boolean>;
  watch?: EventStreamDependencies['watch']; watchFiles?: readonly string[]; nextWakeAt?: () => number | null; clock?: Clock } = {}) {
  const clock = options.clock ?? new Clock();
  const queue = options.queue ?? [];
  const delivered: string[] = [];
  const errors: EventStreamFailure[] = [];
  const watchers: { changed: (name: string | null) => void; failed: () => void; closed: number }[] = [];
  let reads = 0;
  const stream = createEventStream({ directory: '/isolated-fixture/.local',
    read: async () => { reads++; return options.read ? options.read() : [...queue]; },
    deliver: options.deliver ?? (async item => { delivered.push(item.id); }),
    onError: phase => { errors.push(phase); },
    ...(options.watchFiles ? { watchFiles: options.watchFiles } : {}),
    ...(options.nextWakeAt ? { nextWakeAt: options.nextWakeAt } : {}),
  }, { now: () => clock.now, after: clock.after, watch: options.watch ?? ((_directory, changed, failed) => {
    const watcher = { changed, failed, closed: 0 };
    watchers.push(watcher);
    return () => { watcher.closed++; watcher.failed(); };
  }) });
  return { stream, clock, queue, delivered, errors, watchers, reads: () => reads };
}

test('startup and explicit reconnect replay unsent entries without healthy polling or acknowledgement', async t => {
  const f = fixture({ queue: [{ id: 'offline' }] }); t.after(f.stream.close);
  await flush();
  assert.equal(f.reads(), 1);
  assert.deepEqual(f.delivered, ['offline']);
  assert.deepEqual(f.queue, [{ id: 'offline' }], 'transport success must leave durable acknowledgement to the adapter');
  assert.equal(f.clock.timers.size, 0);
  f.clock.advance(3_600_000); await flush();
  assert.equal(f.reads(), 1, 'a healthy idle stream must not sweep its queue');
  for (const name of ['events.lock', 'events.json.tmp', 'status.json', '../events.json']) f.watchers[0]!.changed(name);
  await flush(); assert.equal(f.reads(), 1);
  f.queue.push({ id: 'online' });
  f.watchers[0]!.changed('events.json'); f.watchers[0]!.changed('events.json'); f.watchers[0]!.changed(null);
  await flush();
  assert.equal(f.reads(), 2, 'a burst of rename/change hints coalesces into one read');
  assert.deepEqual(f.delivered, ['offline', 'online']);
  f.queue.push({ id: 'missed-during-transport-reconnect' });
  f.stream.wake(); await flush();
  assert.deepEqual(f.delivered, ['offline', 'online', 'missed-during-transport-reconnect']);
  assert.equal(f.clock.timers.size, 0);
});

test('opted-in status replacements re-evaluate the queue and coalesce with queue hints', async t => {
  const f = fixture({ watchFiles: ['events.json', 'status.json'] }); t.after(f.stream.close);
  await flush();
  for (const name of ['status.lock', 'status.json.tmp', '../status.json', 'config.json']) f.watchers[0]!.changed(name);
  await flush(); assert.equal(f.reads(), 1);
  f.queue.push({ id: 'eligible-after-status-change' });
  f.watchers[0]!.changed('status.json');
  f.watchers[0]!.changed('status.json');
  f.watchers[0]!.changed('events.json');
  await flush();
  assert.equal(f.reads(), 2);
  assert.deepEqual(f.delivered, ['eligible-after-status-change']);
  assert.equal(f.clock.timers.size, 0, 'watching status must not introduce healthy polling');
  f.clock.advance(3_600_000); await flush();
  assert.equal(f.reads(), 2);
});

test('an absolute eligibility deadline reads an unchanged queue exactly once when due', async t => {
  const clock = new Clock();
  const dueAt = 30_000;
  const retained = [{ id: 'persistent-attention' }];
  const f = fixture({ clock, queue: retained,
    read: async () => clock.now >= dueAt ? retained : [],
    nextWakeAt: () => clock.now < dueAt ? dueAt : null,
  }); t.after(f.stream.close);
  await flush();
  assert.equal(f.reads(), 1);
  assert.deepEqual(f.delivered, []);
  assert.equal(clock.timers.size, 1);
  clock.advance(dueAt - 1); await flush();
  assert.equal(f.reads(), 1);
  clock.advance(1); await flush();
  assert.equal(f.reads(), 2);
  assert.deepEqual(f.delivered, ['persistent-attention']);
  assert.deepEqual(retained, [{ id: 'persistent-attention' }], 'deadline delivery does not require a queue rewrite');
  assert.equal(clock.timers.size, 0);
  clock.advance(3_600_000); await flush();
  assert.equal(f.reads(), 2, 'a consumed deadline must not become a periodic sweep');
});

test('status changes reschedule an eligibility deadline and healthy recovery cancels it', async t => {
  const clock = new Clock();
  let dueAt: number | null = 30_000;
  const f = fixture({ clock, watchFiles: ['events.json', 'status.json'],
    nextWakeAt: () => dueAt !== null && clock.now < dueAt ? dueAt : null,
  }); t.after(f.stream.close);
  await flush();
  clock.advance(10_000);
  dueAt = 50_000;
  f.watchers[0]!.changed('status.json'); await flush();
  assert.equal(f.reads(), 2);
  assert.equal(clock.timers.size, 1);
  clock.advance(20_000); await flush();
  assert.equal(f.reads(), 2, 'the replaced deadline must not fire');
  clock.advance(19_999); await flush(); assert.equal(f.reads(), 2);
  clock.advance(1); await flush(); assert.equal(f.reads(), 3);
  assert.equal(clock.timers.size, 0);

  dueAt = 80_000;
  f.watchers[0]!.changed('status.json'); await flush();
  assert.equal(clock.timers.size, 1);
  clock.advance(10_000);
  dueAt = null;
  f.watchers[0]!.changed('status.json'); await flush();
  const healthyReads = f.reads();
  assert.equal(clock.timers.size, 0, 'recovery must clear the obsolete attention deadline');
  clock.advance(3_600_000); await flush();
  assert.equal(f.reads(), healthyReads);
  assert.deepEqual(f.delivered, []);
});

test('repeated file hints do not postpone an absolute eligibility deadline', async t => {
  const clock = new Clock();
  const dueAt = 30_000;
  const f = fixture({ clock, watchFiles: ['events.json', 'status.json'],
    read: async () => clock.now >= dueAt ? [{ id: 'still-failed' }] : [],
    nextWakeAt: () => clock.now < dueAt ? dueAt : null,
  }); t.after(f.stream.close);
  await flush();
  for (const elapsed of [5_000, 5_000, 5_000, 5_000, 5_000, 4_999]) {
    clock.advance(elapsed);
    f.watchers[0]!.changed('status.json');
    f.watchers[0]!.changed('events.json');
    await flush();
    assert.deepEqual(f.delivered, []);
    assert.equal(clock.timers.size, 1);
  }
  const beforeDeadline = f.reads();
  clock.advance(1); await flush();
  assert.equal(clock.now, dueAt);
  assert.equal(f.reads(), beforeDeadline + 1);
  assert.deepEqual(f.delivered, ['still-failed']);
  assert.equal(clock.timers.size, 0);
});

test('closing a stream cancels its eligibility deadline', async () => {
  const clock = new Clock();
  const f = fixture({ clock, nextWakeAt: () => 30_000 });
  await flush();
  assert.equal(clock.timers.size, 1);
  f.stream.close(); f.stream.close();
  assert.equal(clock.timers.size, 0);
  clock.advance(3_600_000); await flush();
  assert.equal(f.reads(), 1);
  assert.deepEqual(f.delivered, []);
});

test('deadline and status wakeups wait for an active delivery and drain serially', async t => {
  const clock = new Clock();
  const dueAt = 30_000;
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const available: Item[] = [];
  const delivered: string[] = [];
  let active = 0; let maximum = 0;
  const f = fixture({ clock, watchFiles: ['events.json', 'status.json'],
    nextWakeAt: () => clock.now < dueAt ? dueAt : null,
    read: async () => clock.now >= dueAt ? [...available, { id: 'became-due' }] : [...available],
    deliver: async item => {
      active++; maximum = Math.max(maximum, active);
      if (item.id === 'first') await blocked;
      delivered.push(item.id); active--;
    },
  }); t.after(f.stream.close);
  await flush();
  available.push({ id: 'first' });
  f.watchers[0]!.changed('events.json'); await flush();
  assert.equal(f.reads(), 2);
  assert.equal(active, 1);
  clock.advance(dueAt); await flush();
  for (let i = 0; i < 20; i++) f.watchers[0]!.changed('status.json');
  await flush();
  assert.equal(f.reads(), 2, 'neither the deadline nor hints may start a concurrent drain');
  assert.equal(active, 1);
  release(); await flush();
  assert.equal(maximum, 1);
  assert.equal(f.reads(), 3);
  assert.deepEqual(delivered, ['first', 'became-due']);
  assert.equal(clock.timers.size, 0);
});

test('queue changes during a slow delivery are drained serially and coalesced', async t => {
  const delivered: string[] = [];
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let active = 0; let maximum = 0;
  const f = fixture({ queue: [{ id: 'first' }, { id: 'second' }], deliver: async item => {
    active++; maximum = Math.max(maximum, active);
    if (item.id === 'first') await blocked;
    delivered.push(item.id); active--;
  } }); t.after(f.stream.close);
  await flush();
  f.queue.push({ id: 'third' });
  for (let i = 0; i < 20; i++) f.watchers[0]!.changed('events.json');
  f.stream.wake(); await flush();
  assert.equal(f.reads(), 1);
  assert.equal(active, 1);
  release(); await flush();
  assert.equal(maximum, 1);
  assert.equal(f.reads(), 2);
  assert.deepEqual(delivered, ['first', 'second', 'third']);
  assert.equal(f.clock.timers.size, 0);
});

test('a delivery veto after an earlier delayed send leaves the backlog eligible for a later status wake', async t => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let eligible = true;
  let active = 0; let maximum = 0;
  const attempts: string[] = [];
  const delivered: string[] = [];
  const retained = [{ id: 'first' }, { id: 'became-stale' }, { id: 'completion' }];
  const f = fixture({ queue: retained, watchFiles: ['events.json', 'status.json'], deliver: async item => {
    active++; maximum = Math.max(maximum, active); attempts.push(item.id);
    try {
      if (item.id === 'first') await blocked;
      if (item.id === 'became-stale' && !eligible) return false;
      delivered.push(item.id);
      if (item.id === 'completion') return true;
      // Existing void-return adapters still count as successful delivery.
    } finally { active--; }
  } }); t.after(f.stream.close);
  await flush();
  assert.deepEqual(attempts, ['first']); assert.equal(active, 1);
  eligible = false; release(); await flush();
  assert.deepEqual(attempts, ['first', 'became-stale', 'completion']);
  assert.deepEqual(delivered, ['first', 'completion'], 'veto does not block a later critical event');
  assert.equal(maximum, 1); assert.equal(active, 0);
  assert.equal(f.clock.timers.size, 0); assert.deepEqual(f.errors, []);
  assert.deepEqual(retained, [{ id: 'first' }, { id: 'became-stale' }, { id: 'completion' }]);
  const reads = f.reads();
  f.clock.advance(3_600_000); await flush();
  assert.equal(f.reads(), reads, 'a veto cannot start an immediate or periodic retry');
  assert.equal(attempts.length, 3);
  eligible = true; f.watchers[0]!.changed('status.json'); await flush();
  assert.deepEqual(attempts, ['first', 'became-stale', 'completion', 'became-stale']);
  assert.deepEqual(delivered, ['first', 'completion', 'became-stale'], 'vetoed ID was not inserted in the sent set');
  assert.equal(maximum, 1); assert.equal(f.clock.timers.size, 0);
  f.watchers[0]!.changed('events.json'); await flush();
  assert.equal(attempts.length, 4, 'successfully delivered entries are not repeated after reconsideration');
});

test('read failures alone schedule bounded retries; file hint storms do not bypass backoff', async t => {
  let failed = true;
  const f = fixture({ read: async () => { if (failed) throw new Error('private filesystem diagnostic'); return [{ id: 'retained' }]; } });
  t.after(f.stream.close); await flush();
  assert.deepEqual(f.errors, ['read']);
  for (const ms of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
    const before = f.reads();
    f.watchers[0]!.changed('events.json'); await flush();
    assert.equal(f.reads(), before);
    f.clock.advance(ms - 1); await flush(); assert.equal(f.reads(), before);
    f.clock.advance(1); await flush(); assert.equal(f.reads(), before + 1);
    assert.equal(f.clock.timers.size, 1);
  }
  failed = false;
  f.clock.advance(30_000); await flush();
  assert.deepEqual(f.delivered, ['retained']);
  assert.equal(f.clock.timers.size, 0);
  const before = f.reads(); f.clock.advance(3_600_000); await flush(); assert.equal(f.reads(), before);
});

test('a rejected delivery retries only unsent entries, retaining the queue', async t => {
  const attempts: string[] = [];
  let failed = true;
  const f = fixture({ queue: [{ id: 'one' }, { id: 'two' }], deliver: async item => {
    attempts.push(item.id);
    if (item.id === 'two' && failed) throw new Error('transport closed');
  } }); t.after(f.stream.close); await flush();
  assert.deepEqual(attempts, ['one', 'two']);
  assert.deepEqual(f.errors, ['delivery']);
  assert.equal(f.clock.timers.size, 1);
  failed = false;
  f.stream.wake(); await flush();
  assert.deepEqual(attempts, ['one', 'two', 'two']);
  assert.equal(f.clock.timers.size, 0, 'explicit reconnect cancels the obsolete retry deadline');
  assert.deepEqual(f.queue, [{ id: 'one' }, { id: 'two' }]);
});

test('failed and closed watchers reattach and replay missed writes without accepting stale callbacks', async t => {
  const f = fixture(); t.after(f.stream.close); await flush();
  const first = f.watchers[0]!;
  first.failed(); first.failed();
  assert.equal(first.closed, 1);
  assert.deepEqual(f.errors, ['watch']);
  assert.equal(f.clock.timers.size, 1);
  f.queue.push({ id: 'written-while-unwatched' });
  first.changed('events.json'); await flush(); assert.equal(f.reads(), 1);
  f.clock.advance(999); await flush(); assert.equal(f.watchers.length, 1);
  f.clock.advance(1); await flush();
  assert.equal(f.watchers.length, 2);
  assert.deepEqual(f.delivered, ['written-while-unwatched']);
  assert.equal(f.clock.timers.size, 0);
  first.failed(); assert.equal(f.watchers[1]!.closed, 0);
  f.watchers[1]!.failed();
  f.clock.advance(1_999); await flush(); assert.equal(f.watchers.length, 2);
  f.clock.advance(1); await flush(); assert.equal(f.watchers.length, 3);
  f.watchers[2]!.changed('events.json'); await flush();
  f.watchers[2]!.failed();
  f.clock.advance(1_000); await flush(); assert.equal(f.watchers.length, 4, 'real file activity resets watcher failure backoff');
});

test('an initially missing queue directory retries its watcher and replays after it becomes available', async t => {
  let unavailable = true;
  let attempts = 0;
  const f = fixture({ queue: [{ id: 'offline' }], watch: () => {
    attempts++;
    if (unavailable) throw new Error('ENOENT');
    return () => {};
  } }); t.after(f.stream.close); await flush();
  assert.equal(attempts, 1);
  assert.deepEqual(f.delivered, ['offline']);
  assert.deepEqual(f.errors, ['watch']);
  f.queue.push({ id: 'new' }); unavailable = false;
  f.clock.advance(1_000); await flush();
  assert.equal(attempts, 2);
  assert.deepEqual(f.delivered, ['offline', 'new']);
  assert.equal(f.clock.timers.size, 0);
});

test('close detaches watchers and deadlines, and never sends another item after a pending delivery settles', async () => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const attempts: string[] = [];
  const f = fixture({ queue: [{ id: 'one' }, { id: 'two' }], deliver: async item => { attempts.push(item.id); await blocked; } });
  await flush();
  f.watchers[0]!.failed(); assert.equal(f.clock.timers.size, 1);
  f.stream.close(); f.stream.close();
  assert.equal(f.clock.timers.size, 0);
  f.stream.wake(); f.watchers[0]!.changed('events.json');
  release(); await flush(); f.clock.advance(3_600_000); await flush();
  assert.deepEqual(attempts, ['one']);
  assert.equal(f.reads(), 1);
  assert.equal(f.watchers.length, 1);
  const neverStarted = fixture(); neverStarted.stream.close(); await flush();
  assert.equal(neverStarted.reads(), 0);
  assert.equal(neverStarted.watchers[0]!.closed, 1);
});

test('real parent-directory watches observe repeated atomic queue replacements', { timeout: 6_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'rebalance-event-stream-test-'));
  const directory = join(root, '.local'); await mkdir(directory);
  const file = join(directory, 'events.json');
  await writeFile(file, JSON.stringify([{ id: 'offline' }]));
  const received: string[] = [];
  const failures: EventStreamFailure[] = [];
  const stream = createEventStream<Item>({ directory,
    read: async () => JSON.parse(await readFile(file, 'utf8')) as Item[],
    deliver: async item => { received.push(item.id); },
    onError: phase => { failures.push(phase); },
  });
  t.after(async () => { stream.close(); await rm(root, { recursive: true, force: true }); });
  const waitForCount = async (count: number) => {
    const deadline = Date.now() + 1_500;
    while (received.length < count && Date.now() < deadline) await delay(10);
    assert.equal(received.length, count);
  };
  await waitForCount(1);
  for (const id of ['online', 'another']) {
    await writeFile(`${file}.tmp`, JSON.stringify([{ id: 'offline' }, { id }]));
    await rename(`${file}.tmp`, file);
    await waitForCount(id === 'online' ? 2 : 3);
  }
  assert.deepEqual(received, ['offline', 'online', 'another']);
  assert.deepEqual(failures, []);
});
