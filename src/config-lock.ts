import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireLock, isLiveLockContention } from './storage.js';

const MAX_WAIT_MS = 5_000;
export class ConfigLockBusyError extends Error {
  readonly code = 'REBALANCE_LOCK_BUSY';
  constructor() {
    super('Configuration is busy at a transaction boundary; retry shortly.');
    this.name = 'ConfigLockBusyError';
  }
}

/** Wait only for the short settings-write/final-broadcast boundary. */
export async function acquireConfigLock(dataDir: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<() => Promise<void>> {
  const timeout = options.timeoutMs ?? MAX_WAIT_MS;
  if (!Number.isFinite(timeout) || timeout < 0 || timeout > MAX_WAIT_MS) throw new Error('Invalid configuration lock timeout');
  const deadline = performance.now() + timeout;
  for (;;) {
    options.signal?.throwIfAborted();
    try {
      const release = await acquireLock(dataDir, 'config.lock');
      if (options.signal?.aborted) { await release(); options.signal.throwIfAborted(); }
      return release;
    } catch (error) {
      // The exclusive file exists before its JSON write completes. Retry a partial
      // read without reclaiming it; permanently malformed records fail closed.
      if (!isLiveLockContention(error) && !(error instanceof SyntaxError)) throw error;
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new ConfigLockBusyError();
      await delay(Math.min(20, remaining), undefined, { signal: options.signal });
    }
  }
}
