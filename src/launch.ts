import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { Status } from './runtime.js';
import { acquireLock, atomicWriteJson, readJson } from './storage.js';

const REPOSITORY = fileURLToPath(new URL('..', import.meta.url));
const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url));
const CHART_URL = 'http://127.0.0.1:4663';
export type LaunchOptions = { setupOnly?: boolean; targets?: string; requestId?: string; expectedStop?: string };
type CommandResult = { ok: boolean; value: unknown };
type ChartProbe = { state: 'absent' } | { state: 'unavailable' } | { state: 'response'; value: unknown };
export type LaunchDependencies = {
  dataDir: string;
  command: (args: string[]) => Promise<CommandResult>;
  chartStatus: () => Promise<ChartProbe>;
  alive: (pid: number) => boolean;
  pause: () => Promise<void>;
  attempts: number;
};
export type LaunchResult = {
  app: 'Rebalance'; requested: 'full' | 'setup-only';
  outcome: 'armed' | 'ready' | 'starting' | 'blocked' | 'busy' | 'needs-input' | 'already-handled';
  status: Status | null;
  chart: { state: 'ready' | 'unavailable' | 'blocked' | 'not-checked'; url: string; message?: string };
  messages: string[];
};
type SpawnRecord = { runner?: number; chart?: number };

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true;
    throw error;
  }
}

function publicStatus(value: unknown): Status {
  const s = value as Status | null;
  if (!s || s.app !== 'Rebalance' || s.chain?.id !== 4663 || typeof s.armed !== 'boolean' ||
      (s.wallet !== null && (typeof s.wallet !== 'string' || !/^0x[\da-f]{40}$/i.test(s.wallet))) ||
      (s.config !== null && (!s.config || typeof s.config.targets !== 'object' || !s.config.targets))) {
    throw new Error('Invalid public status; preserve local records for recovery.');
  }
  return s;
}

function defaultDependencies(): LaunchDependencies {
  const dataDir = resolve(process.env.REBALANCE_DATA_DIR || resolve(REPOSITORY, '.local'));
  return {
    dataDir, alive: processAlive, pause: () => delay(250), attempts: 40,
    command: args => new Promise((resolveResult, reject) => {
      execFile(process.execPath, ['--import', 'tsx', CLI, ...args], {
        cwd: REPOSITORY, env: { ...process.env, REBALANCE_DATA_DIR: dataDir },
        timeout: 120_000, maxBuffer: 1_048_576,
      }, (error, stdout) => {
        // CLI stdout is explicitly public JSON. Never publish raw subprocess
        // errors/stderr, which can include environment or provider payloads.
        try { resolveResult({ ok: !error, value: JSON.parse(stdout) }); }
        catch { reject(new Error('Local command failed; inspect public status before retrying.')); }
      });
    }),
    chartStatus: async () => {
      try {
        const response = await fetch(`${CHART_URL}/api/status`, { signal: AbortSignal.timeout(1500) });
        if (!response.ok) return { state: 'unavailable' };
        try { return { state: 'response', value: await response.json() }; }
        catch { return { state: 'unavailable' }; }
      } catch (error) {
        const cause = (error as { cause?: { code?: string } }).cause;
        return { state: cause?.code === 'ECONNREFUSED' ? 'absent' : 'unavailable' };
      }
    },
  };
}

/** Fixed CLI operations only; no model, shell command interpolation or signing here. */
export async function launch(options: LaunchOptions = {}, overrides: Partial<LaunchDependencies> = {}): Promise<LaunchResult> {
  const deps = { ...defaultDependencies(), ...overrides };
  const result: LaunchResult = { app: 'Rebalance', requested: options.setupOnly ? 'setup-only' : 'full',
    outcome: 'blocked', status: null, chart: { state: 'not-checked', url: CHART_URL }, messages: [] };
  if (options.requestId !== undefined && (!options.requestId || options.requestId.length > 2048)) {
    result.messages.push('Invalid launch request identifier.'); return result;
  }
  if (options.expectedStop !== undefined && !/^(?:none|[0-9a-f]{64})$/.test(options.expectedStop)) {
    result.messages.push('Invalid expected stop generation.'); return result;
  }
  const attempts = Math.max(1, Math.min(80, deps.attempts));
  const recordPath = resolve(deps.dataDir, 'launch-processes.json');
  const requestPath = options.requestId === undefined ? null : resolve(deps.dataDir, 'launch-requests',
    `${createHash('sha256').update(options.requestId).digest('hex')}.json`);
  let release: (() => Promise<void>) | undefined;
  let startAttempted = false;
  const stopToken = async () => {
    const stopped = await readJson(resolve(deps.dataDir, 'stop.json'));
    return stopped === null ? 'none' : createHash('sha256').update(JSON.stringify(stopped)).digest('hex');
  };
  const identity = (s: Status) => JSON.stringify({ chainId: s.chain.id, wallet: s.wallet?.toLowerCase(),
    mode: s.mode, targets: Object.entries(s.config?.targets ?? {}).sort(([a], [b]) => a.localeCompare(b)),
    rebalanceIntervalSeconds: s.config?.rebalanceIntervalSeconds });
  let verifiedChartIdentity: string | null = null;
  const readStatus = async () => {
    const response = await deps.command(['status']);
    if (!response.ok) throw new Error('Public status could not be read; preserve the existing configuration.');
    result.status = publicStatus(response.value);
    if (verifiedChartIdentity !== null && identity(result.status) !== verifiedChartIdentity) {
      result.chart = { state: 'not-checked', url: CHART_URL, message: 'Configuration changed after the chart check.' };
    }
    return result.status;
  };
  const livePid = (pid: unknown): pid is number => typeof pid === 'number' && Number.isSafeInteger(pid) &&
    pid > 0 && pid <= 2_147_483_647 && deps.alive(pid);
  const lockAlive = async (name: string) => {
    const lock = await readJson<{ pid: number }>(resolve(deps.dataDir, name));
    if (lock !== null && (!Number.isSafeInteger(lock.pid) || lock.pid <= 0 || lock.pid > 2_147_483_647)) {
      throw new Error('Invalid process lock; preserve it for recovery.');
    }
    return lock !== null && livePid(lock.pid);
  };
  const run = async (args: string[]) => {
    const command = await deps.command(args);
    if (!command.ok) throw new Error('A local launch command failed; inspect public status before retrying.');
    return command.value;
  };
  let spawned: SpawnRecord = {};
  const recordSpawn = async (kind: keyof SpawnRecord, value: unknown) => {
    const pid = (value as { pid?: number })?.pid;
    if (!Number.isSafeInteger(pid) || !pid || pid <= 0 || pid > 2_147_483_647) {
      throw new Error('Background command did not return a valid process identifier; inspect status before retrying.');
    }
    spawned = { ...spawned, [kind]: pid };
    await atomicWriteJson(recordPath, spawned);
  };
  const ensureChart = async () => {
    let requested = false;
    for (let i = 0; i < attempts; i++) {
      const owned = await lockAlive('chart.lock');
      const probe = await deps.chartStatus();
      if (probe.state === 'response') {
        let chart: Status;
        try { chart = publicStatus(probe.value); }
        catch { result.chart = { state: 'blocked', url: CHART_URL, message: 'The chart port returned unexpected data.' }; return; }
        const expected = result.status!;
        const weights = (s: Status) => JSON.stringify(Object.entries(s.config?.targets ?? {}).sort(([a], [b]) => a.localeCompare(b)));
        if (!owned || chart.wallet?.toLowerCase() !== expected.wallet?.toLowerCase() || weights(chart) !== weights(expected)) {
          result.chart = { state: 'blocked', url: CHART_URL, message: 'The listener is not the owned chart for this wallet and allocation.' }; return;
        }
        verifiedChartIdentity = identity(expected);
        result.chart = { state: 'ready', url: CHART_URL }; return;
      }
      if (probe.state === 'unavailable' && !owned && !livePid(spawned.chart)) {
        result.chart = { state: 'blocked', url: CHART_URL, message: 'The chart port is unavailable or occupied; no listener was replaced.' }; return;
      }
      if (probe.state === 'absent' && !owned && !livePid(spawned.chart) && !requested) {
        requested = true;
        await recordSpawn('chart', await run(['chart', '--background']));
      }
      if (i + 1 < attempts) await deps.pause();
    }
    result.chart = { state: 'unavailable', url: CHART_URL, message: 'Chart startup is not yet verified; an existing process was not duplicated.' };
  };

  try {
    try { release = await acquireLock(deps.dataDir, 'launch.lock'); }
    catch {
      result.outcome = 'busy'; result.messages.push('Another launch or lock recovery is in progress; no second launch was started.');
      await readStatus(); return result;
    }
    const expectedStop = options.expectedStop ?? await stopToken();
    await readStatus();
    if (requestPath && await readJson(requestPath)) {
      result.outcome = 'already-handled';
      result.messages.push('This launch request was already handled; replay will not resume a subsequently stopped runner.');
      return result;
    }
    // Record receipt before side effects. Even an interrupted launch must not be
    // replayed by a hook after a later user stop. A new prompt is a new request.
    if (requestPath) await atomicWriteJson(requestPath, { receivedAt: new Date().toISOString(), setupOnly: !!options.setupOnly });
    spawned = await readJson<SpawnRecord>(recordPath) ?? {};
    if (!result.status!.config) {
      if (!options.targets) {
        result.outcome = 'needs-input'; result.messages.push('Supply all five target percentages to finish first-time setup.');
        return result;
      }
      if (!result.status!.wallet) await run(['wallet', 'create']);
      await run(['configure', '--targets', options.targets]);
      await readStatus();
      if (!result.status!.config) throw new Error('Configuration was not established; no runner was started.');
    }
    if (!result.status!.armed && (await lockAlive('run.lock') || livePid(spawned.runner))) {
      await readStatus();
      result.outcome = result.status!.armed ? 'armed' : 'busy';
      result.messages.push('An existing runner is starting or stopping; it was not restarted.');
      return result;
    }
    let preparationBlocked = false;
    const preparedIdentity = identity(result.status!);
    const initiallyArmed = result.status!.armed;
    if (!result.status!.armed) {
      const checked = await deps.command(['check']);
      try { result.status = publicStatus(checked.value); }
      catch { preparationBlocked = true; await readStatus(); }
      if (!checked.ok || result.status!.error) {
        preparationBlocked = true;
        result.messages.push('The read-only check failed; no trading runner was started.');
      }
      if (['unresolved', 'reverted'].includes(result.status!.operation?.status ?? '')) {
        preparationBlocked = true;
        result.messages.push('The earlier transaction needs recovery; its records were preserved.');
      }
    }
    await ensureChart();
    // Chart startup/probing can outlast a concurrent stop, process exit or
    // config edit. Read public state again before any readiness/armed return.
    await readStatus();
    if (identity(result.status!) !== preparedIdentity) {
      result.chart = { state: 'not-checked', url: CHART_URL, message: 'Configuration changed after the chart and portfolio checks.' };
      result.messages.push('Configuration changed during launch; repeat the request to check the new saved configuration.');
      result.outcome = result.status!.armed ? 'armed' : 'blocked';
      return result;
    }
    if (initiallyArmed && !result.status!.armed) {
      result.messages.push('The existing runner stopped or exited during setup; it was not resumed.');
      return result;
    }
    if (result.chart.state !== 'ready' || result.status!.error) preparationBlocked = true;
    if (result.status!.mode !== 'private-key') {
      result.messages.push(`${result.status!.mode} execution is deferred; no signer fallback is used.`);
    }
    if (result.status!.armed) { result.outcome = 'armed'; return result; }
    if (preparationBlocked) return result;
    if (options.setupOnly) { result.outcome = 'ready'; return result; }
    // The run lock remains the final exclusion guard against an external
    // ordinary CLI start racing this launch.
    if (await lockAlive('run.lock')) {
      result.outcome = 'busy'; result.messages.push('A runner acquired the process lock during setup.'); return result;
    }
    if (await stopToken() !== expectedStop) {
      result.messages.push('A newer stop arrived during setup; it was preserved and no runner was started.');
      return result;
    }
    // The ordinary start command repeats this generation comparison while it
    // serializes stop-marker updates, closing the check/spawn race.
    startAttempted = true;
    await recordSpawn('runner', await run(['start', '--background', '--expected-stop', expectedStop]));
    for (let i = 0; i < attempts; i++) {
      await readStatus();
      if (result.status!.armed) { result.outcome = 'armed'; return result; }
      if (!livePid(spawned.runner) && !await lockAlive('run.lock')) {
        result.messages.push('The spawned runner exited before verified arming; inspect its public error.'); return result;
      }
      if (i + 1 < attempts) await deps.pause();
    }
    result.outcome = 'starting'; result.messages.push('The runner process exists, but arming has not yet been verified.');
    return result;
  } catch (error) {
    if (startAttempted) {
      try { await readStatus(); } catch { result.status = null; }
      result.outcome = result.status?.armed ? 'armed' : 'starting';
      result.messages.push(result.status?.armed
        ? 'The runner is armed, but launch bookkeeping or readiness checks failed.'
        : 'The start command may have launched a runner; its state is not verified. Inspect status and do not blindly retry.');
    }
    // Our own concise errors are safe; provider/child exceptions are not echoed.
    result.messages.push(error instanceof Error && error.constructor === Error
      ? error.message.slice(0, 300) : 'Launch failed; preserve local records and inspect public status.');
    return result;
  } finally { await release?.(); }
}
