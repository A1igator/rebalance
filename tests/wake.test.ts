import assert from 'node:assert/strict';
import { watch } from 'node:fs';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createWakeSource, SEQUENCER_FEED, type WakeDependencies, type WakeReason } from '../src/wake.js';

class FakeSocket extends EventTarget {
  closed = 0;
  close() { this.closed++; this.dispatchEvent(new Event('close')); }
  emit(type: string) { this.dispatchEvent(new Event(type)); }
}

class Clock {
  now = 0;
  nextId = 0;
  timers = new Map<number, { at: number; callback: () => void }>();
  after = (delay: number, callback: () => void) => {
    const id = ++this.nextId;
    this.timers.set(id, { at: this.now + delay, callback });
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

function fixture(overrides: Partial<WakeDependencies> = {}) {
  const clock = new Clock();
  const controller = new AbortController();
  const sockets: FakeSocket[] = [];
  const watchers: { changed: (file: string | null) => void; failed: () => void; closed: number }[] = [];
  const reasons: WakeReason[] = [];
  const dependencies: WakeDependencies = {
    after: clock.after, now: () => clock.now,
    socket: url => { assert.equal(url, SEQUENCER_FEED); const socket = new FakeSocket(); sockets.push(socket); return socket; },
    watch: (_dir, changed, failed) => {
      const watcher = { changed, failed, closed: 0 }; watchers.push(watcher);
      return () => { watcher.closed++; };
    },
    ...overrides,
  };
  const source = createWakeSource({ dataDir: '/unused-fixture', signal: controller.signal,
    onWake: reason => reasons.push(reason) }, dependencies);
  return { clock, controller, sockets, watchers, reasons, source };
}

test('feed frames produce activity hints without interpreting or reading payloads', t => {
  const f = fixture(); t.after(f.source.close);
  assert.equal(f.source.state().feed, 'connecting');
  f.sockets[0].emit('open');
  assert.deepEqual(f.reasons, ['reconnect']);
  assert.equal(f.source.state().lastActivityAt, null, 'open alone is not frame evidence');
  f.clock.advance(123);
  const message = new Event('message');
  Object.defineProperty(message, 'data', { get: () => { throw new Error('payload must never be read'); } });
  f.sockets[0].dispatchEvent(message);
  assert.deepEqual(f.reasons, ['reconnect', 'chain']);
  assert.equal(f.source.state().lastActivityAt, 123);
  const copy = f.source.state(); copy.feed = 'closed';
  assert.equal(f.source.state().feed, 'connected');
});

test('directory wakeups accept only config/cycle/stop paths, including rename destinations', t => {
  const f = fixture(); t.after(f.source.close);
  for (const file of ['config.json.tmp', 'status.json', 'pending.json', 'events.json', 'recovery.json', null,
    '/tmp/config.json', '../config.json']) f.watchers[0].changed(file);
  assert.deepEqual(f.reasons, []);
  for (const file of ['config.json', 'cycle.json', 'stop.json']) f.watchers[0].changed(file);
  assert.deepEqual(f.reasons, ['config', 'cycle', 'stop']);
});

test('disconnects use bounded exponential reconnects and detach stale sockets', t => {
  const f = fixture(); t.after(f.source.close);
  for (const wait of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
    const previous = f.sockets.at(-1)!;
    previous.emit('error');
    assert.equal(previous.closed, 1);
    assert.equal(f.source.state().feed, 'fallback');
    const count = f.sockets.length;
    previous.emit('open'); previous.emit('message'); previous.emit('close');
    assert.deepEqual(f.reasons, []);
    f.clock.advance(wait - 1);
    assert.equal(f.sockets.length, count);
    f.clock.advance(1);
    assert.equal(f.sockets.length, count + 1);
  }
  const live = f.sockets.at(-1)!;
  live.emit('open'); live.emit('message'); live.emit('close');
  const count = f.sockets.length;
  f.clock.advance(1_000);
  assert.equal(f.sockets.length, count + 1, 'observed activity resets reconnect backoff');
});

test('connection and silent-feed deadlines recover missing close/error events', t => {
  const f = fixture(); t.after(f.source.close);
  f.clock.advance(10_000);
  assert.equal(f.source.state().feed, 'fallback');
  assert.equal(f.sockets[0].closed, 1);
  f.clock.advance(1_000);
  f.sockets[1].emit('open');
  f.clock.advance(29_000);
  f.sockets[1].emit('message');
  f.clock.advance(29_999);
  assert.equal(f.source.state().feed, 'connected');
  f.clock.advance(1);
  assert.equal(f.source.state().feed, 'fallback');
  assert.equal(f.sockets[1].closed, 1);
});

test('file watcher failure retries once per deadline and ignores detached callbacks', t => {
  const f = fixture(); t.after(f.source.close);
  f.watchers[0].failed(); f.watchers[0].failed();
  assert.equal(f.watchers[0].closed, 1);
  assert.equal(f.source.state().files, 'unavailable');
  f.watchers[0].changed('stop.json');
  f.clock.advance(29_999);
  assert.equal(f.watchers.length, 1);
  f.clock.advance(1);
  assert.equal(f.watchers.length, 2);
  assert.equal(f.source.state().files, 'watching');
  assert.deepEqual(f.reasons, ['config'], 'restored watching prompts a fresh state read');
  f.watchers[0].failed();
  assert.equal(f.watchers[1].closed, 0);
  f.watchers[1].changed('stop.json');
  assert.deepEqual(f.reasons, ['config', 'stop']);
});

test('abort cancels reconnect/watch deadlines, closes handles and prevents further wakeups', () => {
  const f = fixture();
  f.watchers[0].failed(); f.sockets[0].emit('close');
  assert.equal(f.clock.timers.size, 2);
  f.controller.abort(); f.source.close();
  assert.equal(f.clock.timers.size, 0);
  assert.equal(f.source.state().feed, 'closed');
  assert.equal(f.source.state().files, 'closed');
  f.sockets[0].emit('message'); f.watchers[0].changed('config.json');
  f.clock.advance(120_000);
  assert.deepEqual(f.reasons, []);
  assert.equal(f.sockets.length, 1);
  assert.equal(f.watchers.length, 1);
});

test('already-aborted creation opens no handles; constructor failures retain fallback', () => {
  const controller = new AbortController(); controller.abort();
  const noCall = () => { throw new Error('must not open handles'); };
  const source = createWakeSource({ dataDir: '/unused', signal: controller.signal, onWake: noCall },
    { socket: noCall, watch: noCall, after: noCall });
  assert.equal(source.state().feed, 'closed');
  assert.equal(source.state().files, 'closed');
  const f = fixture({ socket: () => { throw new Error('secret transport details'); },
    watch: () => { throw new Error('private filesystem path'); } });
  assert.equal(f.source.state().feed, 'fallback');
  assert.equal(f.source.state().files, 'unavailable');
  f.clock.advance(60_000);
  assert.deepEqual(f.reasons, []);
  assert.equal(f.clock.timers.size, 2, 'at most one retry per failed source');
  f.source.close();
  assert.equal(f.clock.timers.size, 0);
});

test('native directory watch observes atomic config replacement in isolated storage', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rebalance-wake-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const controller = new AbortController();
  let resolve!: () => void;
  const changed = new Promise<void>(done => { resolve = done; });
  let unavailable!: (code: string) => void;
  const watchError = new Promise<string>(done => { unavailable = done; });
  const source = createWakeSource({ dataDir: directory, signal: controller.signal,
    onWake: reason => { if (reason === 'config') resolve(); } }, {
    socket: () => new FakeSocket(),
    watch: (dir, onChange, failed) => {
      const watcher = watch(dir, (_event, filename) => onChange(filename));
      watcher.on('error', error => { unavailable((error as NodeJS.ErrnoException).code ?? 'unknown'); failed(); });
      return () => watcher.close();
    },
  });
  t.after(source.close);
  await writeFile(join(directory, 'config.json.tmp'), '{}');
  await rename(join(directory, 'config.json.tmp'), join(directory, 'config.json'));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([changed, watchError, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('native rename event was not observed')), 2_000);
    })]);
    if (typeof outcome === 'string') {
      assert.equal(outcome, 'EMFILE');
      assert.equal(source.state().files, 'unavailable');
      t.skip('Native fs.watch unavailable (EMFILE) in this environment; mocked fallback and rename tests pass.');
      return;
    }
  } finally { clearTimeout(timer); }
  assert.equal(source.state().files, 'watching');
});
