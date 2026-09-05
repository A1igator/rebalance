import { watch } from 'node:fs';

// Sequencer messages are untrusted activity hints, never balances or receipts.
export const SEQUENCER_FEED = 'wss://feed.mainnet.chain.robinhood.com';
export type WakeReason = 'chain' | 'config' | 'cycle' | 'stop' | 'reconnect';
export type WakeState = {
  feed: 'connecting' | 'connected' | 'fallback' | 'closed';
  files: 'watching' | 'unavailable' | 'closed';
  lastActivityAt: number | null;
};
type Cancel = () => void;
type Socket = Pick<WebSocket, 'addEventListener' | 'removeEventListener' | 'close'>;
export type WakeDependencies = {
  socket: (url: string) => Socket;
  watch: (directory: string, changed: (filename: string | null) => void, failed: () => void) => Cancel;
  after: (delayMs: number, callback: () => void) => Cancel;
  now: () => number;
};
export type WakeSource = { close: Cancel; state: () => WakeState };

const defaults: WakeDependencies = {
  socket: url => new WebSocket(url),
  watch: (directory, changed, failed) => {
    const watcher = watch(directory, (_event, filename) => changed(filename));
    watcher.on('error', failed);
    return () => watcher.close();
  },
  after: (delayMs, callback) => {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
  now: Date.now,
};

/** Hint sources only. The serial scheduler owns coalescing, RPC reads and its fallback watchdog. */
export function createWakeSource(
  options: { dataDir: string; signal: AbortSignal; onWake: (reason: WakeReason) => void },
  overrides: Partial<WakeDependencies> = {},
): WakeSource {
  const deps = { ...defaults, ...overrides };
  const status: WakeState = { feed: 'connecting', files: 'unavailable', lastActivityAt: null };
  let closed = false;
  let socket: Socket | undefined;
  let releaseSocket: Cancel | undefined;
  let socketDeadline: Cancel | undefined;
  let reconnectTimer: Cancel | undefined;
  let unwatch: Cancel | undefined;
  let watchRetry: Cancel | undefined;
  let reconnectDelay = 1_000;
  let watchGeneration = 0;

  function closeSocket() {
    socketDeadline?.(); socketDeadline = undefined;
    releaseSocket?.(); releaseSocket = undefined;
    const previous = socket; socket = undefined;
    // A connecting socket can reject close(); it is already detached either way.
    try { previous?.close(); } catch { /* No raw transport diagnostics or payloads. */ }
  }

  function reconnect() {
    closeSocket();
    if (closed || reconnectTimer) return;
    status.feed = 'fallback';
    reconnectTimer = deps.after(reconnectDelay, () => {
      reconnectTimer = undefined;
      connect();
    });
    reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
  }

  function connect() {
    if (closed) return;
    status.feed = 'connecting';
    let current: Socket;
    try { current = deps.socket(SEQUENCER_FEED); } catch { reconnect(); return; }
    socket = current;
    const isCurrent = () => !closed && socket === current;
    const deadline = (delay: number) => {
      socketDeadline?.();
      socketDeadline = deps.after(delay, () => { if (isCurrent()) reconnect(); });
    };
    const opened = () => {
      if (!isCurrent()) return;
      status.feed = 'connected';
      deadline(30_000);
      options.onWake('reconnect');
    };
    const activity = () => {
      if (!isCurrent() || status.feed !== 'connected') return;
      status.lastActivityAt = deps.now();
      reconnectDelay = 1_000;
      deadline(30_000);
      options.onWake('chain');
    };
    const failed = () => { if (isCurrent()) reconnect(); };
    const handlers = { open: opened, message: activity, error: failed, close: failed };
    for (const [event, handler] of Object.entries(handlers)) current.addEventListener(event, handler);
    releaseSocket = () => {
      for (const [event, handler] of Object.entries(handlers)) current.removeEventListener(event, handler);
    };
    deadline(10_000);
  }

  function watchFiles() {
    if (closed) return;
    const generation = ++watchGeneration;
    const failed = () => {
      if (closed || generation !== watchGeneration) return;
      watchGeneration++;
      unwatch?.(); unwatch = undefined;
      if (watchRetry) return;
      status.files = 'unavailable';
      watchRetry = deps.after(30_000, () => {
        watchRetry = undefined;
        watchFiles();
        if (status.files === 'watching') options.onWake('config');
      });
    };
    try {
      unwatch = deps.watch(options.dataDir, filename => {
        if (closed || generation !== watchGeneration) return;
        // Watch the directory so an atomic rename is observed; ignore our own outputs.
        if (filename === 'config.json') options.onWake('config');
        if (filename === 'cycle.json') options.onWake('cycle');
        if (filename === 'stop.json') options.onWake('stop');
      }, failed);
      status.files = 'watching';
    } catch { failed(); }
  }

  function close() {
    if (closed) return;
    closed = true;
    options.signal.removeEventListener('abort', close);
    reconnectTimer?.(); reconnectTimer = undefined;
    watchRetry?.(); watchRetry = undefined;
    unwatch?.(); unwatch = undefined;
    closeSocket();
    status.feed = 'closed';
    status.files = 'closed';
  }

  if (options.signal.aborted) close();
  else {
    options.signal.addEventListener('abort', close, { once: true });
    watchFiles();
    connect();
  }
  return { close, state: () => ({ ...status }) };
}
