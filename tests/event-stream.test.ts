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
function fixture(options: { queue?: Item[]; read?: () => Promise<Item[]>; deliver?: (item: Item) => Promise<void>;
  watch?: EventStreamDependencies['watch'] } = {}) {
  const clock = new Clock();
  const queue = options.queue ?? [];
  const delivered: string[] = [];
  const errors: EventStreamFailure[] = [];
  const watchers: { changed: (name: string | null) => void; failed: () => void; closed: number }[] = [];
  let reads = 0;
  const stream = createEventStream({ directory: '/isolated-fixture/.local',
    read: async () => { reads++; return options.read ? options.read() : [...queue]; },
    deliver: options.deliver ?? (async item => { delivered.push(item.id); }),
    onError: phase => { errors.push(phase); },
  }, { after: clock.after, watch: options.watch ?? ((_directory, changed, failed) => {
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
