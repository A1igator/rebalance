import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveProfile, walletIdentity, type RoutedProfile } from '../scripts/profile-routing.mjs';
import { validateConfig } from './config.js';
import { readView, viewState } from './view-session.js';
import { acquireLock, atomicWriteJson, readJson } from './storage.js';

export type RunnerSummary = { wallet: string | null; state: 'running' | 'stopped' | 'starting' | 'stopping' | 'unavailable' | 'deferred'; message?: string };
export type RunnerResult = RunnerSummary & { requestId: string; outcome: string };
export type RunnerRequest = { token: string; wallet: string; action: 'start' | 'stop'; requestId: string };
type Outcome = 'prepared' | 'armed' | 'starting' | 'stop-requested' | 'blocked' | 'busy' | 'deferred' | 'uncertain';
type Entry = { version: 1; sessionId: string; requestId: string; wallet: string; action: 'start' | 'stop'; expectedStop: string; receivedAt: string; outcome: Outcome };
export type PortfolioControlDependencies = {
  execute: (profile: RoutedProfile, args: readonly string[]) => Promise<{ ok: boolean; value: unknown }>;
  alive: (pid: number) => boolean;
  persist: typeof atomicWriteJson;
};
const repository = fileURLToPath(new URL('..', import.meta.url));
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const LOG = 'runner-requests.json';
const messages: Record<Outcome, string> = {
  prepared: 'The control request is still being verified. No second request was dispatched.',
  armed: 'The runner launch completed. The displayed state is verified separately.',
  starting: 'Startup may still be in progress. A spawned process does not yet establish running state.',
  'stop-requested': 'Stop requested. Any transaction already submitted can still settle.',
  blocked: 'Startup was blocked. Existing transaction and recovery records were preserved.',
  busy: 'An existing launch is still in progress. No second launch was dispatched.',
  deferred: 'This earlier Ledger Start request was deferred. Use a new Start request to begin monitoring.',
  uncertain: 'The control outcome could not be verified. This request will not be replayed automatically.',
};
export class PortfolioControlError extends Error {
  constructor(public readonly statusCode: 400 | 403 | 409, message: string) { super(message); }
}
const unavailable = (wallet: string | null): RunnerSummary => ({ wallet, state: 'unavailable', message: 'Runner state is unavailable. Existing control and transaction records were preserved.' });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const key = (entry: Pick<Entry, 'sessionId' | 'requestId'>) => hash(`${entry.sessionId}\0${entry.requestId}`);
const pid = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 2_147_483_647;
const defaults: PortfolioControlDependencies = {
  execute: (profile, args) => new Promise((done, fail) => {
    execFile(process.execPath, ['--import', 'tsx', resolve(repository, 'src/cli.ts'), ...args], {
      cwd: repository, timeout: 120_000, maxBuffer: 1_048_576, killSignal: 'SIGKILL',
      env: { ...process.env, REBALANCE_ROOT_DIR: profile.rootDir, REBALANCE_DATA_DIR: profile.dataDir,
        REBALANCE_PROFILE_PINNED: '1', REBALANCE_PROFILE_WALLET: profile.wallet ?? '', REBALANCE_CHART_PORT: String(profile.chartPort) },
    }, (error, stdout) => {
      try { done({ ok: !error, value: JSON.parse(stdout) }); }
      catch { fail(new Error('The local control command could not be verified.')); }
    });
  }),
  alive: value => { try { process.kill(value, 0); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true;
    throw error;
  } },
  persist: atomicWriteJson,
};

/** One chart's controls stay pinned to its original portfolio, including across awaits. */
export class PortfolioControls {
  private readonly deps: PortfolioControlDependencies;
  private readonly active = new Map<string, { action: RunnerRequest['action']; promise: Promise<RunnerResult> }>();
  readonly rootDir: string;
  readonly dataDir: string;
  constructor(rootDir: string, dataDir: string, overrides: Partial<PortfolioControlDependencies> = {}) {
    this.rootDir = resolve(rootDir); this.dataDir = resolve(dataDir); this.deps = { ...defaults, ...overrides };
  }
  private path(name: string) { return resolve(this.dataDir, name); }
  private async profile() {
    const config = validateConfig(await readJson(this.path('config.json')));
    const profile = await resolveProfile(this.rootDir, { wallet: config.wallet });
    if (resolve(profile.dataDir) !== this.dataDir) throw new Error('Chart portfolio identity mismatch');
    return { profile, config };
  }
  private async stopToken() {
    const value = await readJson(this.path('stop.json'));
    return value === null ? 'none' : hash(JSON.stringify(value));
  }
  private async entries(): Promise<Entry[]> {
    const entries = await readJson<unknown>(this.path(LOG)) ?? [];
    if (!Array.isArray(entries) || entries.length > 10_000) throw new Error('Invalid runner request records');
    const seen = new Set<string>();
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || Object.keys(entry).some(name => !['version','sessionId','requestId','wallet','action','expectedStop','receivedAt','outcome'].includes(name)) ||
          entry.version !== 1 || typeof entry.sessionId !== 'string' || !entry.sessionId || entry.sessionId.length > 2048 || /[\x00-\x1f\x7f]/.test(entry.sessionId) ||
          typeof entry.requestId !== 'string' || !uuid.test(entry.requestId) || entry.requestId !== entry.requestId.toLowerCase() ||
          typeof entry.wallet !== 'string' || !/^0x[0-9a-f]{40}$/.test(entry.wallet) || !['start','stop'].includes(entry.action) ||
          typeof entry.expectedStop !== 'string' || !/^(none|[a-f0-9]{64})$/.test(entry.expectedStop) ||
          typeof entry.receivedAt !== 'string' || !Number.isFinite(Date.parse(entry.receivedAt)) || !Object.hasOwn(messages, entry.outcome) || seen.has(key(entry))) {
        throw new Error('Invalid runner request records');
      }
      seen.add(key(entry));
    }
    return entries;
  }
  private async controlled<T>(action: () => Promise<T>) {
    let release: (() => Promise<void>) | undefined;
    for (let attempt = 0; ; attempt++) {
      try { release = await acquireLock(this.dataDir, 'runner-requests.lock'); break; }
      catch (error) {
        if (attempt >= 39 || (!(error instanceof SyntaxError) && (!(error instanceof Error) || !error.message.startsWith('Lock runner-requests.lock is held')))) throw error;
        await new Promise(done => setTimeout(done, 25));
      }
    }
    try { return await action(); } finally { await release(); }
  }
  private async liveLock(name: string) {
    let value: { pid?: number } | null;
    for (let attempt = 0; ; attempt++) {
      try { value = await readJson(this.path(name)); break; }
      catch (error) {
        if (!(error instanceof SyntaxError) || attempt >= 10) throw error;
        await new Promise(done => setTimeout(done, 50));
      }
    }
    if (value === null) return false;
    if (!pid(value.pid)) throw new Error('Invalid runner ownership record');
    return this.deps.alive(value.pid);
  }
  async read(): Promise<RunnerSummary> {
    let wallet: string | null = null;
    try {
      const { config } = await this.profile(); wallet = walletIdentity(config.wallet);
      const [run, launch, stopped, processes, saved, entries] = await Promise.all([
        this.liveLock('run.lock'), this.liveLock('launch.lock'), readJson(this.path('stop.json')),
        readJson<{ runner?: number }>(this.path('launch-processes.json')),
        readJson<{ wallet?: string; armed?: boolean }>(this.path('status.json')), this.entries(),
      ]);
      if (processes?.runner !== undefined && !pid(processes.runner)) throw new Error('Invalid launch process record');
      const spawning = processes?.runner !== undefined && this.deps.alive(processes.runner);
      const generation = stopped === null ? 'none' : hash(JSON.stringify(stopped));
      // A new Start may still be checking the portfolio before clearing exactly
      // the older stop it captured. A later stop has a different generation.
      const pending = entries.findLast(item => ['prepared','uncertain','starting'].includes(item.outcome) &&
        (item.action === 'stop' || item.expectedStop === generation));
      const inFlight = pending?.outcome === 'prepared' && this.active.has(key(pending));
      if (stopped !== null && (pending?.action !== 'start' || (run && saved?.armed === true))) {
        return { wallet, state: run || launch || spawning || inFlight ? 'stopping' : 'stopped',
          message: run || launch || spawning || inFlight ? messages['stop-requested'] : undefined };
      }
      if (run) {
        const running = saved?.wallet?.toLowerCase() === wallet && saved.armed === true;
        return { wallet, state: running ? 'running' : 'starting',
          ...(config.mode === 'ledger' && running ? { message: 'Ledger monitoring is active. Each rebalance requires a separate request and physical confirmation of every transaction.' } : {}) };
      }
      if (launch || spawning) return { wallet, state: 'starting', message: messages.starting };
      if (pending) return inFlight
        ? { wallet, state: pending.action === 'start' ? 'starting' : 'stopping', message: messages.prepared } : unavailable(wallet);
      return { wallet, state: 'stopped' };
    } catch { return unavailable(wallet); }
  }
  async command(input: RunnerRequest): Promise<RunnerResult> {
    if (!input || Object.keys(input).some(name => !['token','wallet','action','requestId'].includes(name)) ||
        typeof input.token !== 'string' || typeof input.wallet !== 'string' || !/^0x[0-9a-f]{40}$/i.test(input.wallet) ||
        !['start','stop'].includes(input.action) || typeof input.requestId !== 'string' || !uuid.test(input.requestId)) {
      throw new PortfolioControlError(400, 'Invalid runner control request.');
    }
    const expectedStop = input.action === 'start' ? await this.stopToken() : 'none';
    let sessionId: string;
    try {
      const view = await readView(this.rootDir, input.token);
      const state = await viewState(this.rootDir, input.token);
      if (state.connectedWallet?.toLowerCase() !== input.wallet.toLowerCase()) throw new Error();
      sessionId = view.sessionId;
    } catch { throw new PortfolioControlError(403, 'Reconnect this chart to the selected wallet before controlling it.'); }
    const { profile, config } = await this.profile();
    if (walletIdentity(config.wallet) !== input.wallet.toLowerCase()) throw new PortfolioControlError(403, 'This control belongs to another wallet chart.');
    const entry: Entry = { version: 1, sessionId, requestId: input.requestId.toLowerCase(), wallet: walletIdentity(config.wallet),
      action: input.action, expectedStop, receivedAt: new Date().toISOString(), outcome: 'prepared' };
    const id = key(entry);
    const operation = async (): Promise<RunnerResult> => {
      let dispatch = false;
      let replay = false;
      const prepared = await this.controlled(async () => {
        const entries = await this.entries();
        const existing = entries.find(item => key(item) === id);
        if (existing) {
          if (existing.action !== entry.action || existing.wallet !== entry.wallet) throw new PortfolioControlError(409, 'This request ID already belongs to another control action.');
          replay = true;
          return existing;
        }
        if (entries.length >= 10_000) throw new PortfolioControlError(409, 'Runner request history is full; preserve it before continuing.');
        const sinceStop = entries.slice(entries.findLastIndex(item => item.outcome === 'stop-requested') + 1)
          .filter(item => item.action === 'stop' || item.expectedStop === entry.expectedStop);
        if (entry.action === 'start' && sinceStop.some(item => ['prepared','uncertain','starting'].includes(item.outcome))) {
          entry.outcome = sinceStop.some(item => item.outcome === 'prepared' && this.active.has(key(item))) ? 'busy' : 'uncertain';
        }
        entries.push(entry);
        await this.deps.persist(this.path(LOG), entries);
        dispatch = entry.outcome === 'prepared';
        return entry;
      });
      if (!dispatch) return { ...await this.read(), requestId: entry.requestId, outcome: prepared.outcome === 'prepared' ? 'uncertain' : replay ? 'already-handled' : prepared.outcome,
        message: messages[prepared.outcome === 'prepared' ? 'uncertain' : prepared.outcome] };
      let outcome: Outcome = 'uncertain';
      try {
        const result = await this.deps.execute(profile, entry.action === 'start'
          ? ['launch', '--request-id', `chart:${id}`, '--expected-stop', entry.expectedStop] : ['stop']);
        const value = result.value as { app?: string; outcome?: string; status?: unknown } | null;
        if (entry.action === 'stop') {
          if (result.ok && value?.status === 'stop-requested') outcome = 'stop-requested';
        } else if (value?.app === 'Rebalance') {
          const status = value.status as { chain?: { id?: number }; wallet?: string } | null;
          if (status && (status.chain?.id !== 4663 || status.wallet?.toLowerCase() !== entry.wallet)) throw new Error('Wrong launch identity');
          if (value.outcome === 'armed' && result.ok) outcome = 'armed';
          else if (value.outcome === 'starting') outcome = 'starting';
          else if (value.outcome === 'busy') outcome = 'busy';
          else if (['blocked','needs-input','already-handled'].includes(value.outcome ?? '')) outcome = 'blocked';
        }
      } catch { /* A potentially dispatched request never becomes a safe retry. */ }
      await this.controlled(async () => {
        const entries = await this.entries();
        const saved = entries.find(item => key(item) === id);
        if (!saved || saved.outcome !== 'prepared') throw new Error('Runner request result could not be persisted');
        saved.outcome = outcome;
        await this.deps.persist(this.path(LOG), entries);
      });
      return { ...await this.read(), requestId: entry.requestId, outcome, message: messages[outcome] };
    };
    // The journal is the durable guard; concurrent callers share only their exact
    // request. Stop uses its own request and is never queued behind slow launch.
    const current = this.active.get(id);
    if (current) {
      if (current.action !== entry.action) throw new PortfolioControlError(409, 'This request ID already belongs to another control action.');
      return current.promise;
    }
    const running = operation(); this.active.set(id, { action: entry.action, promise: running });
    try { return await running; } finally { if (this.active.get(id)?.promise === running) this.active.delete(id); }
  }
}
