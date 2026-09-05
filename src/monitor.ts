import type { Config } from './config.js';
import type { RebalanceCycle } from './cadence.js';
import type { Status } from './runtime.js';
import type { PendingTransaction } from './storage.js';
import { AUTO_RECOVERY_GRACE_MS } from './recovery.js';
import { createWakeSource, type WakeReason } from './wake.js';

export type MonitorInput = { config: Config | null; cycle: RebalanceCycle | null; pending: PendingTransaction | null; stopped: boolean };
export type MonitorDependencies = {
  dataDir: string; signal: AbortSignal;
  read(): Promise<MonitorInput>;
  run(): Promise<Status>;
  source?: typeof createWakeSource;
};
export const RECEIPT_MIN_MS = 1000;
export const RECEIPT_WATCHDOG_MS = 3000;
export const MARKET_MIN_MS = 5000;
export const CONTROL_WATCHDOG_MS = 5000;
const fingerprint = (value: unknown) => JSON.stringify(value);

/** Activity wakes one serial graph. Timers cover exact deadlines, missed local
 * events and unavailable feeds; they never create another executor. */
export async function driveMonitor({ dataDir, signal, read, run, source = createWakeSource }: MonitorDependencies): Promise<void> {
  let chainDirty = false;
  let localDirty = false;
  let wake: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let graphAt = 0;
  let chainAt = Infinity;
  let controlAt = 0;
  let configKey: string | undefined;
  let cycleKey: string | undefined;
  let errors = 0;
  const deadline = () => Math.min(graphAt, controlAt, chainDirty ? chainAt : Infinity, localDirty ? Date.now() : Infinity);
  const schedule = () => {
    if (!wake) return;
    clearTimeout(timer);
    timer = setTimeout(() => wake?.(), Math.max(0, Math.min(2_147_483_647, deadline() - Date.now())));
  };
  const notify = (reason: WakeReason) => {
    if (reason === 'chain' || reason === 'reconnect') chainDirty = true;
    else localDirty = true;
    schedule();
  };
  let events: ReturnType<typeof createWakeSource> | undefined;
  const abort = () => wake?.();
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (!signal.aborted) {
      localDirty = false;
      const input = await read();
      if (signal.aborted || input.stopped || !input.config) break;
      events ??= source({ dataDir, signal, onWake: notify });
      const now = Date.now();
      const changed = configKey !== fingerprint(input.config) || cycleKey !== fingerprint(input.cycle);
      if (changed || now >= graphAt || (chainDirty && now >= chainAt)) {
        chainDirty = false;
        const result = await run();
        configKey = fingerprint(input.config);
        const current = await read();
        // Receipt reconciliation may persist success before an observation
        // failure leaves the published cycle stale. Baseline the actual record
        // so our own write cannot repeatedly bypass RPC error backoff.
        cycleKey = fingerprint(current.cycle);
        if (signal.aborted || current.stopped || !current.config) break;
        const finished = Date.now();
        errors = result.error ? errors + 1 : 0;
        if (errors) {
          graphAt = finished + Math.min(30_000, 2000 * 2 ** Math.min(errors - 1, 4));
          chainAt = Infinity;
        } else if (current.pending) {
          chainAt = finished + RECEIPT_MIN_MS;
          graphAt = finished + RECEIPT_WATCHDOG_MS;
          const created = Date.parse(current.pending.createdAt);
          const recoveryAt = created + AUTO_RECOVERY_GRACE_MS;
          if (Number.isFinite(created) && recoveryAt > finished) graphAt = Math.min(graphAt, recoveryAt);
        } else {
          const eligible = Date.parse(current.cycle?.nextEligibleAt ?? '');
          if (result.operation?.status === 'cooling-down' && eligible > finished) {
            graphAt = eligible;
            chainAt = Infinity;
          } else {
            graphAt = result.operation?.status === 'cooling-down' && Number.isFinite(eligible)
              ? finished : finished + current.config.pollSeconds * 1000;
            chainAt = finished + MARKET_MIN_MS;
          }
        }
      }
      controlAt = Date.now() + CONTROL_WATCHDOG_MS;
      if (signal.aborted) break;
      await new Promise<void>(resolve => { wake = resolve; schedule(); });
      wake = undefined;
      clearTimeout(timer);
    }
  } finally {
    wake = undefined;
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    events?.close();
  }
}
