import { watch } from 'node:fs';
import { basename } from 'node:path';

type Cancel = () => void;
export type EventStreamFailure = 'read' | 'delivery' | 'watch';
export type EventStream = { wake: Cancel; close: Cancel };
export type EventStreamDependencies = {
  watch: (directory: string, changed: (filename: string | null) => void, failed: Cancel) => Cancel;
  after: (delayMs: number, callback: Cancel) => Cancel;
};
const defaults: EventStreamDependencies = {
  watch: (directory, changed, failed) => {
    // Observe the directory: the queue is replaced by atomic rename.
    const watcher = watch(directory, (event, filename) => {
      if (event === 'rename' && filename === basename(directory)) failed();
      else changed(filename);
    });
    watcher.on('error', failed);
    watcher.on('close', failed);
    return () => watcher.close();
  },
  after: (delayMs, callback) => {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};

/** Push retained queue entries serially. Only explicit acknowledgement removes them.
 * Delivery success suppresses repeats in this stream; a new session gets a new stream.
 * There are no periodic reads. Timers exist only while recovering an actual failure.
 * A transport must settle delivery or close the stream; do not race a write with a
 * retry that could run concurrently with that same unresolved write.
 */
export function createEventStream<T extends { id: string }>(
  options: {
    directory: string;
    read: () => Promise<readonly T[]>;
    deliver: (event: T) => Promise<void>;
    onError?: (phase: EventStreamFailure) => void;
  },
  overrides: Partial<EventStreamDependencies> = {},
): EventStream {
  const deps = { ...defaults, ...overrides };
  const sent = new Set<string>();
  let closed = false;
  let dirty = false;
  let scheduled = false;
  let draining = false;
  let unwatch: Cancel | undefined;
  let watchGeneration = 0;
  let watchRetry: Cancel | undefined;
  let watchDelay = 1_000;
  let drainRetry: Cancel | undefined;
  let drainDelay = 1_000;

  function report(phase: EventStreamFailure) {
    try { options.onError?.(phase); } catch { /* Diagnostic callbacks cannot discard queued events. */ }
  }

  function requestDrain() {
    if (closed) return;
    dirty = true;
    if (draining || scheduled || drainRetry) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (!closed) void drain();
    });
  }

  async function drain() {
    if (closed || draining) return;
    draining = true;
    let phase: EventStreamFailure = 'read';
    try {
      while (!closed && dirty) {
        dirty = false;
        phase = 'read';
        const queue = await options.read();
        for (const event of queue) {
          if (closed) break;
          if (sent.has(event.id)) continue;
          phase = 'delivery';
          await options.deliver(event);
          // A transport write is not a durable acknowledgement or proof of push delivery.
          sent.add(event.id);
        }
        drainDelay = 1_000;
      }
    } catch {
      if (!closed) {
        dirty = true;
        report(phase);
        if (closed) return;
        drainRetry = deps.after(drainDelay, () => {
          drainRetry = undefined;
          requestDrain();
        });
        drainDelay = Math.min(drainDelay * 2, 30_000);
      }
    } finally {
      draining = false;
      if (dirty && !drainRetry) requestDrain();
    }
  }

  function watchQueue() {
    if (closed) return;
    const generation = ++watchGeneration;
    const failed = () => {
      if (closed || generation !== watchGeneration) return;
      watchGeneration++;
      const previous = unwatch; unwatch = undefined;
      previous?.();
      report('watch');
      if (closed) return;
      watchRetry = deps.after(watchDelay, () => {
        watchRetry = undefined;
        watchQueue();
        // Replay changes missed while the watcher was unavailable.
        requestDrain();
      });
      watchDelay = Math.min(watchDelay * 2, 30_000);
    };
    try {
      const release = deps.watch(options.directory, filename => {
        if (closed || generation !== watchGeneration) return;
        if (filename !== null && filename !== 'events.json') return;
        watchDelay = 1_000;
        requestDrain();
      }, failed);
      if (closed || generation !== watchGeneration) release();
      else unwatch = release;
    } catch { failed(); }
  }

  function wake() {
    if (closed) return;
    drainRetry?.(); drainRetry = undefined;
    requestDrain();
  }

  function close() {
    if (closed) return;
    closed = true;
    watchGeneration++;
    watchRetry?.(); watchRetry = undefined;
    drainRetry?.(); drainRetry = undefined;
    unwatch?.(); unwatch = undefined;
  }

  watchQueue();
  requestDrain();
  return { wake, close };
}
