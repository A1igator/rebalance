import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveProfile, walletIdentity, type RoutedProfile } from '../scripts/profile-routing.mjs';
import { requestLedgerRebalance } from './ledger-request.js';
import { validateConfig } from './config.js';
import { acquireConfigLock, ConfigLockBusyError } from './config-lock.js';
import { readView, viewState } from './view-session.js';
import { acquireLock, atomicWriteJson, isLiveLockContention, readJson } from './storage.js';
import { validatePending } from './transactions.js';
import type { PendingTransaction } from './storage.js';
import { ensureSelectedCodexNotifications } from './selected-notifications.js';

type BatchingImplementation = 'calibur' | 'simple7702';
export type CaliburSummary = { implementation?: BatchingImplementation; state: 'needed' | 'ready' | 'unknown' | 'authorizing' | 'signing' | 'confirming'; message?: string };
export type RunnerSummary = { wallet: string | null; state: 'running' | 'stopped' | 'starting' | 'stopping' | 'setting-up' | 'unavailable' | 'deferred'; message?: string; calibur?: CaliburSummary; canCancelStart?: true };
export type RunnerResult = RunnerSummary & { requestId: string; outcome: string };
export type RunnerRequest = { token: string; wallet: string; action: 'start' | 'stop'; requestId: string };
export type LedgerRetryRequest = { token: string; wallet: string; requestId: string; retryOf: string };
type Outcome = 'prepared' | 'armed' | 'starting' | 'stop-requested' | 'blocked' | 'busy' | 'deferred' | 'uncertain';
const setupFailures = {
  'setup-check-unavailable': 'Wallet batching could not be checked. Check the network, then press Start to retry. No setup or runner launch was dispatched.',
  'deployment-needed': 'Simple7702 needs a one-time contract deployment on this network. Complete deployment before pressing Start; ETH is required.',
  'existing-calibur': 'This wallet already uses Calibur. Its delegation and pending receipts were preserved.',
  'simulation-failed': 'Batching setup simulation could not be verified. Check the network, then press Start to retry.',
  'insufficient-eth': 'Batching setup needs more ETH for gas. Fund this wallet, then press Start.',
  'fee-above-target': 'Batching setup exceeds the fee target. Wait for lower fees or update the target, then press Start.',
  'fee-unavailable': 'A fresh Batching setup fee estimate is unavailable. Check the network, then press Start to retry.',
  rejected: 'Batching setup was cancelled on the Ledger. Press Start when ready to try again.',
  cancelled: 'Batching setup was cancelled before broadcast. Press Start when ready to try again.',
  timeout: 'Ledger setup timed out. Unlock the device, open Ethereum, then press Start.',
  unavailable: 'Open Ethereum on the connected Ledger, then press Start to retry setup.',
  'account-mismatch': 'The Ledger account does not match this portfolio. Select the correct account before pressing Start.',
  'invalid-transaction': 'Batching setup could not be prepared. Review the setup configuration before retrying.',
  'invalid-signature': 'The Ledger signature could not be verified. Check the selected device before retrying.',
  unsupported: 'The Ledger cannot sign this setup. Review device signing support before retrying.',
} as const;
type SetupFailure = keyof typeof setupFailures;
class SetupBusyError extends Error {}
class SetupBlockedError extends Error { constructor(readonly reason: SetupFailure) { super(setupFailures[reason]); } }
type Entry = { version: 1; sessionId: string; requestId: string; wallet: string; action: 'start' | 'stop'; expectedStop: string; receivedAt: string; outcome: Outcome; setupBlocked?: SetupFailure };
export type PortfolioControlDependencies = {
  execute: (profile: RoutedProfile, args: readonly string[], sessionId?: string, options?: { timeoutMs?: number; signal?: AbortSignal }) => Promise<{ ok: boolean; value: unknown }>;
  caliburStatus: (profile: RoutedProfile) => Promise<unknown>;
  simple7702Status: (profile: RoutedProfile) => Promise<unknown>;
  wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  selectedNotifications: (profile: RoutedProfile, sessionId: string, starting: boolean) => Promise<unknown>;
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
  execute: (profile, args, sessionId, options) => new Promise((done, fail) => {
    execFile(process.execPath, ['--import', 'tsx', resolve(repository, 'src/cli.ts'), ...args], {
      cwd: repository, timeout: options?.timeoutMs ?? 120_000, signal: options?.signal, maxBuffer: 1_048_576, killSignal: 'SIGTERM',
      env: { ...process.env, REBALANCE_ROOT_DIR: profile.rootDir, REBALANCE_DATA_DIR: profile.dataDir,
        REBALANCE_SESSION_ID: sessionId ?? '', CODEX_THREAD_ID: '', CLAUDE_CODE_SESSION_ID: '',
        REBALANCE_PROFILE_PINNED: '1', REBALANCE_PROFILE_WALLET: profile.wallet ?? '', REBALANCE_CHART_PORT: String(profile.chartPort) },
    }, (error, stdout) => {
      try { done({ ok: !error, value: JSON.parse(stdout) }); }
      catch { fail(new Error('The local control command could not be verified.')); }
    });
  }),
  caliburStatus: async profile => {
    const result = await defaults.execute(profile, ['ledger', 'calibur-status'], undefined, { timeoutMs: 10_000 });
    if (!result.ok) throw new Error('Calibur status is unavailable');
    return result.value;
  },
  simple7702Status: async profile => {
    const result = await defaults.execute(profile, ['ledger', 'simple7702-status'], undefined, { timeoutMs: 10_000 });
    if (!result.ok) throw new Error('Simple7702 status is unavailable');
    return result.value;
  },
  wait: (milliseconds, signal) => new Promise((done, fail) => {
    signal.throwIfAborted();
    const abort = () => { clearTimeout(timer); fail(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); done(); }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
  }),
  selectedNotifications: (profile, sessionId, starting) => ensureSelectedCodexNotifications(profile.rootDir, sessionId,
    { dataDir: profile.dataDir, starting, explicitSelection: true }),
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
  private readonly setups = new Map<string, { controller: AbortController; expectedStop: string; phase: 'checking' | 'setup'; implementation?: BatchingImplementation }>();
  private caliburCache: { at: number; value: CaliburSummary } | undefined;
  private caliburRefresh: Promise<void> | undefined;
  readonly rootDir: string;
  readonly dataDir: string;
  constructor(rootDir: string, dataDir: string, overrides: Partial<PortfolioControlDependencies> = {}) {
    this.rootDir = resolve(rootDir); this.dataDir = resolve(dataDir); this.deps = { ...defaults, ...overrides };
    for (const [dependency, command] of [['caliburStatus', 'calibur-status'], ['simple7702Status', 'simple7702-status']] as const) {
      if (overrides.execute && !overrides[dependency]) this.deps[dependency] = async profile => {
        const result = await overrides.execute!(profile, ['ledger', command], undefined, { timeoutMs: 10_000 });
        if (!result.ok) throw new Error('Batching status is unavailable');
        return result.value;
      };
    }
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
      if (!entry || typeof entry !== 'object' || Object.keys(entry).some(name => !['version','sessionId','requestId','wallet','action','expectedStop','receivedAt','outcome','setupBlocked'].includes(name)) ||
          (entry.setupBlocked !== undefined && (typeof entry.setupBlocked !== 'string' || !Object.hasOwn(setupFailures, entry.setupBlocked))) ||
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
  private async ownsRunningPortfolio(wallet: string) {
    const [run, processes, saved, stopped] = await Promise.all([
      readJson<{pid?:number}>(this.path('run.lock')), readJson<{runner?:number}>(this.path('launch-processes.json')),
      readJson<{wallet?:string;armed?:boolean}>(this.path('status.json')), readJson(this.path('stop.json')),
    ]);
    return run !== null && pid(run.pid) && this.deps.alive(run.pid) && processes?.runner === run.pid && stopped === null &&
      saved?.wallet?.toLowerCase() === wallet && saved.armed === true;
  }
  private async spawnedRunner() {
    const saved = await readJson<{runner?:number}>(this.path('launch-processes.json'));
    if (saved?.runner === undefined) return false;
    if (!pid(saved.runner)) throw new Error('Invalid launch process record');
    return this.deps.alive(saved.runner);
  }
  private setupState(value: unknown, wallet: string, implementation: BatchingImplementation): CaliburSummary {
    const result = value as { app?: string; operation?: string; wallet?: string; chainId?: number; outcome?: string; blockedReason?: string } | null;
    if (result?.app !== 'Rebalance' || result.operation !== `${implementation}-setup` || result.chainId !== 4663 ||
        result.wallet?.toLowerCase() !== wallet.toLowerCase()) throw new Error('Batching setup identity could not be verified');
    if (result.outcome === 'blocked' && result.blockedReason && Object.hasOwn(setupFailures, result.blockedReason)) {
      throw new SetupBlockedError(result.blockedReason as SetupFailure);
    }
    const label = implementation === 'calibur' ? 'Calibur' : 'Simple7702';
    const state: CaliburSummary['state'] = ['already-enabled', 'confirmed'].includes(result.outcome ?? '') ? 'ready'
      : result.outcome === 'needed' ? 'needed' : result.outcome === 'authorizing' ? 'authorizing'
      : result.outcome === 'signing' ? 'signing' : ['confirming', 'pending'].includes(result.outcome ?? '') ? 'confirming' : 'unknown';
    const messages: Record<CaliburSummary['state'], string> = {
      needed: 'Start enables one-signature rebalances. Initial Ledger setup requires authorization and transaction confirmation.',
      ready: `${label} is enabled. Approvals and Uniswap swaps share one transaction; ETH is required.`,
      unknown: 'Batching setup could not be verified. No automatic signing retry will occur.',
      authorizing: `Confirm ${label} delegation on your Ledger.`, signing: `Confirm the ${label} setup transaction on your Ledger.`,
      confirming: 'Waiting for the Batching setup receipt before starting the portfolio.',
    };
    const summary = { implementation, state, message: messages[state] };
    this.caliburCache = { at: Date.now(), value: summary };
    return summary;
  }
  private statusFor(profile: RoutedProfile, implementation: BatchingImplementation) {
    return implementation === 'calibur' ? this.deps.caliburStatus(profile) : this.deps.simple7702Status(profile);
  }
  private async currentBatching(profile: RoutedProfile) {
    const value = await this.deps.simple7702Status(profile);
    const result = value as { app?: string; operation?: string; wallet?: string; chainId?: number; outcome?: string; blockedReason?: string } | null;
    if (result?.app === 'Rebalance' && result.operation === 'simple7702-setup' && result.chainId === 4663 &&
        result.wallet?.toLowerCase() === profile.wallet?.toLowerCase() && result.outcome === 'blocked' && result.blockedReason === 'existing-calibur') {
      return this.setupState(await this.deps.caliburStatus(profile), profile.wallet!, 'calibur');
    }
    return this.setupState(value, profile.wallet!, 'simple7702');
  }
  private cachedCalibur(profile: RoutedProfile, implementation?: BatchingImplementation): CaliburSummary {
    if ((!this.caliburCache || Date.now() - this.caliburCache.at >= 2_000) && !this.caliburRefresh) {
      this.caliburRefresh = (implementation
        ? this.statusFor(profile, implementation).then(value => this.setupState(value, profile.wallet!, implementation))
        : this.currentBatching(profile)).then(() => {})
        .catch(error => { this.caliburCache = { at: Date.now(), value: { implementation: implementation ?? 'simple7702',
          state: error instanceof SetupBlockedError ? 'needed' : 'unknown',
          message: error instanceof SetupBlockedError ? error.message : 'Batching setup status is unavailable.' } }; })
        .finally(() => { this.caliburRefresh = undefined; });
    }
    return this.caliburCache?.value ?? { implementation: implementation ?? 'simple7702', state: 'unknown', message: 'Checking batching setup.' };
  }
  private async prepareCalibur(profile: RoutedProfile, entry: Entry, signal: AbortSignal, receiptOnly = false): Promise<BatchingImplementation | undefined> {
    const current = async () => {
      signal.throwIfAborted();
      if (await this.stopToken() !== entry.expectedStop) throw new Error('A newer Stop superseded this Start');
    };
    await current();
    // Only this explicit stopped-wallet Start opts in. Hold the same short
    // execution/configuration boundaries as configure; preserve every field.
    let hasPendingSetup = receiptOnly;
    let alreadyReady = false;
    const initialConfig = (await this.profile()).config;
    const retained = await readJson<PendingTransaction>(this.path('pending.json'));
    let implementation: BatchingImplementation;
    if (retained || receiptOnly) {
      if (initialConfig.execution !== 'calibur' && initialConfig.execution !== 'simple7702') throw new Error('Setup execution mode changed');
      implementation = initialConfig.execution;
      if (retained && retained.kind !== `${implementation}-setup`) throw new Error('Pending transaction belongs to another execution path');
      if (retained) validatePending(retained, initialConfig);
    } else {
      let state: CaliburSummary;
      try { state = await this.currentBatching(profile); }
      catch (error) {
        // This request has only observed public setup status. Unlike a lost
        // setup/launch reply, a failed check is safe for a new explicit Start.
        if (error instanceof SetupBlockedError) throw error;
        throw new SetupBlockedError('setup-check-unavailable');
      }
      await current();
      if (state.state !== 'needed' && state.state !== 'ready') throw new SetupBlockedError('setup-check-unavailable');
      implementation = state.implementation!;
      alreadyReady = state.state === 'ready' && initialConfig.execution === implementation;
      // An existing Calibur designation is never migrated by Start.
      if (implementation === 'calibur' && state.state !== 'ready') throw new SetupBlockedError('setup-check-unavailable');
    }
    const activeSetup = this.setups.get(key(entry));
    if (activeSetup) {
      activeSetup.implementation = implementation;
      if (!alreadyReady) activeSetup.phase = 'setup';
    }
    const busy = (error: unknown): never => {
      if (error instanceof ConfigLockBusyError || isLiveLockContention(error)) throw new SetupBusyError('Another operation currently owns this portfolio');
      throw error;
    };
    const releaseRun = await acquireLock(this.dataDir, 'run.lock').catch(busy);
    try {
      const releaseConfig = await acquireConfigLock(this.dataDir, { signal }).catch(busy);
      try {
        await current();
        const { config } = await this.profile();
        const pending = await readJson<{ kind?: string }>(this.path('pending.json'));
        hasPendingSetup ||= pending?.kind === `${implementation}-setup`;
        if (config.mode !== 'ledger' || walletIdentity(config.wallet) !== entry.wallet ||
            (pending && (pending.kind !== `${implementation}-setup` || config.execution !== implementation))) {
          throw new Error('Ledger setup requires an idle portfolio without a pending transaction');
        }
        if (receiptOnly && config.execution !== implementation) throw new Error('Setup execution mode changed');
        if (alreadyReady) {
          // A fresh delegation/deployment proof can reuse an already configured
          // wallet. Keep the same Stop/configuration/receipt boundaries as setup.
          if (pending || JSON.stringify(config) !== JSON.stringify(initialConfig)) {
            throw new SetupBlockedError('setup-check-unavailable');
          }
          await current();
          return implementation;
        }
        if (config.execution !== implementation) {
          const raw = await readJson<Record<string, unknown>>(this.path('config.json'));
          const next = { ...raw, execution: implementation }; validateConfig(next);
          await this.deps.persist(this.path('config.json'), next);
        }
        await current();
      } finally { await releaseConfig(); }
    } finally { await releaseRun(); }
    await current();
    const result = hasPendingSetup ? { ok: true, value: await this.statusFor(profile, implementation) }
      : await this.deps.execute(profile, ['ledger', `setup-${implementation}`, '--expected-stop', entry.expectedStop], entry.sessionId,
        { timeoutMs: 270_000, signal });
    await current();
    const initial = this.setupState(result.value, entry.wallet, implementation);
    if (!result.ok) return undefined;
    if (initial.state === 'ready') return implementation;
    if (initial.state !== 'confirming') return undefined;
    // Receipt-only checks never call setup a second time, even after uncertainty.
    const deadline = Date.now() + 60_000;
    for (let attempt = 0; attempt < 30 && Date.now() < deadline; attempt++) {
      await this.deps.wait(Math.min(2_000, deadline - Date.now()), signal); await current();
      const remaining = deadline - Date.now(); if (remaining <= 0) return undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const observed = await Promise.race([this.statusFor(profile, implementation), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Batching receipt confirmation timed out')), remaining);
      })]).finally(() => { clearTimeout(timer); });
      const state = this.setupState(observed, entry.wallet, implementation);
      await current();
      if (state.state === 'ready') return implementation;
      if (state.state !== 'confirming') return undefined;
    }
    return undefined;
  }
  async read(): Promise<RunnerSummary> {
    let wallet: string | null = null;
    try {
      const { config, profile } = await this.profile(); wallet = walletIdentity(config.wallet);
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
      const setupFailure = entries.findLast(item => item.action === 'start' && item.expectedStop === generation)?.setupBlocked;
      const setupMessage = setupFailure ? setupFailures[setupFailure] : undefined;
      const setup = [...this.setups.values()].find(item => item.expectedStop === generation && !item.controller.signal.aborted);
      if (setup) return setup.phase === 'checking'
        ? { wallet, state: 'starting', message: 'Checking existing wallet batching before starting the portfolio.' }
        : { wallet, state: 'setting-up', calibur: this.cachedCalibur(profile, setup.implementation) };
      if (stopped !== null && (pending?.action !== 'start' || (run && saved?.armed === true))) {
        return { wallet, state: run || launch || spawning || inFlight ? 'stopping' : 'stopped',
          message: run || launch || spawning || inFlight ? messages['stop-requested'] : setupMessage,
          ...(config.mode === 'ledger' ? { calibur: { ...this.cachedCalibur(profile), ...(setupMessage ? { message: setupMessage } : {}) } } : {}) };
      }
      if (run) {
        const calibur = config.mode === 'ledger' ? this.cachedCalibur(profile) : undefined;
        const running = saved?.wallet?.toLowerCase() === wallet && saved.armed === true;
        if (!running && calibur && ['authorizing', 'signing', 'confirming'].includes(calibur.state)) return { wallet, state: 'setting-up', calibur };
        return { wallet, state: running ? 'running' : 'starting',
          ...(config.mode === 'ledger' && running ? { message: 'Ledger monitoring is active. The backend opens device prompts automatically; physical confirmation is required for every transaction.' } : {}) };
      }
      if (launch || spawning) return { wallet, state: 'starting', message: messages.starting };
      if (pending && !inFlight && config.mode === 'ledger' && ['calibur', 'simple7702'].includes(config.execution ?? '')) {
        const transaction = await readJson<PendingTransaction>(this.path('pending.json'));
        if (transaction?.kind === `${config.execution}-setup`) {
          validatePending(transaction, config);
          // Keep this barrier intact until a fresh explicit Start requests a
          // receipt-only continuation; passive UI reads must not consume it.
          const message = 'Setup outcome unconfirmed. Start checks its receipt before continuing.';
          return { wallet, state: 'stopped', message, calibur: { implementation: config.execution as BatchingImplementation, state: 'confirming', message } };
        }
      }
      if (pending) {
        if (inFlight) return { wallet, state: pending.action === 'start' ? 'starting' : 'stopping', message: messages.prepared };
        if (pending.action === 'start') return { ...unavailable(wallet), canCancelStart: true,
          message: 'An earlier Start could not be confirmed. Cancel that request before trying Start again. Any submitted transaction remains tracked.' };
        return unavailable(wallet);
      }
      return { wallet, state: 'stopped', ...(setupMessage ? { message: setupMessage } : {}),
        ...(config.mode === 'ledger' ? { calibur: { ...this.cachedCalibur(profile), ...(setupMessage ? { message: setupMessage } : {}) } } : {}) };
    } catch { return unavailable(wallet); }
  }
  /** An explicit retry belongs to one finished request on this already-running wallet. */
  async retry(input: LedgerRetryRequest) {
    if (!input || Object.keys(input).some(name => !['token','wallet','requestId','retryOf'].includes(name)) ||
        typeof input.token !== 'string' || typeof input.wallet !== 'string' || !/^0x[0-9a-f]{40}$/i.test(input.wallet) ||
        typeof input.requestId !== 'string' || !uuid.test(input.requestId) || typeof input.retryOf !== 'string' || !uuid.test(input.retryOf)) {
      throw new PortfolioControlError(400, 'Invalid Ledger retry request.');
    }
    try {
      const state = await viewState(this.rootDir, input.token);
      if (state.connectedWallet?.toLowerCase() !== input.wallet.toLowerCase()) throw new Error();
    } catch { throw new PortfolioControlError(403, 'Reconnect this chart to the selected wallet before controlling it.'); }
    const { config } = await this.profile();
    if (walletIdentity(config.wallet) !== input.wallet.toLowerCase()) throw new PortfolioControlError(403, 'This control belongs to another wallet chart.');
    if (config.mode !== 'ledger' || (await this.read()).state !== 'running') {
      throw new PortfolioControlError(409, 'Retry requires this Ledger portfolio to be running.');
    }
    try {
      const request = await requestLedgerRebalance(input.requestId, { dataDir: this.dataDir, isAlive: this.deps.alive,
        retryOf: input.retryOf, expectedWallet: input.wallet });
      return { wallet: request.wallet, requestId: request.id, retryOf: input.retryOf.toLowerCase(), outcome: 'requested' as const };
    } catch { throw new PortfolioControlError(409, 'The Ledger request changed or cannot be retried. Refresh its status; any pending transaction is preserved.'); }
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
    let accepted!: (result: RunnerResult) => void;
    const ready = new Promise<RunnerResult>(done => { accepted = done; });
    const operation = async (): Promise<RunnerResult> => {
      let dispatch = false;
      let receiptOnly = false;
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
          const activeStart = sinceStop.some(item => item.outcome === 'prepared' && this.active.has(key(item)));
          const pending = await readJson<{kind?:string}>(this.path('pending.json'));
          if (!activeStart && config.mode === 'ledger' && ['calibur', 'simple7702'].includes(config.execution ?? '') && pending?.kind === `${config.execution}-setup`) receiptOnly = true;
          else entry.outcome = activeStart ? 'busy' : 'uncertain';
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
        if (entry.action === 'stop') {
          // Stop is never queued behind a hardware prompt or receipt wait.
          for (const setup of this.setups.values()) setup.controller.abort(new Error('Stop requested'));
        } else if (config.mode === 'ledger' && !await this.ownsRunningPortfolio(entry.wallet)) {
          if (await this.liveLock('run.lock') || await this.liveLock('launch.lock') || await this.spawnedRunner()) {
            throw new SetupBusyError('Another operation currently owns this portfolio');
          }
          const controller = new AbortController();
          this.setups.set(id, { controller, expectedStop: entry.expectedStop, phase: 'checking' });
          accepted({ wallet: entry.wallet, requestId: entry.requestId, outcome: 'starting', state: 'starting',
            message: 'Checking existing wallet batching before starting the portfolio.' });
          try {
            const implementation = await this.prepareCalibur(profile, entry, controller.signal, receiptOnly);
            if (!implementation) throw new Error('Batching setup remains unresolved');
            controller.signal.throwIfAborted();
            if (await this.stopToken() !== entry.expectedStop) throw new Error('A newer Stop superseded this Start');
            const latest = (await this.profile()).config;
            if (latest.mode !== 'ledger' || latest.execution !== implementation || walletIdentity(latest.wallet) !== entry.wallet) {
              throw new Error('The selected Calibur execution configuration changed');
            }
          } finally { this.setups.delete(id); }
        }

        const result = await this.deps.execute(profile, entry.action === 'start'
          ? ['launch', '--request-id', `chart:${id}`, '--expected-stop', entry.expectedStop] : ['stop'], entry.sessionId);
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
      } catch (error) {
        if (error instanceof SetupBusyError) outcome = 'busy';
        if (error instanceof SetupBlockedError) { outcome = 'blocked'; entry.setupBlocked = error.reason; }
        if (entry.action === 'start' && await this.stopToken().catch(() => entry.expectedStop) !== entry.expectedStop) outcome = 'blocked';
        // Any other potentially dispatched setup/launch remains an uncertainty barrier.
      }
      await this.controlled(async () => {
        const entries = await this.entries();
        const saved = entries.find(item => key(item) === id);
        if (!saved || saved.outcome !== 'prepared') throw new Error('Runner request result could not be persisted');
        saved.outcome = outcome;
        if (entry.setupBlocked) saved.setupBlocked = entry.setupBlocked;
        await this.deps.persist(this.path(LOG), entries);
      });
      if (entry.action === 'start' && (outcome === 'armed' || outcome === 'starting')) {
        // A newly completed explicit Start can claim this selected chat's alerts.
        // Restoration and replay never pass this point; delivery still rechecks
        // selection and running state before dispatch. Notification failure does
        // not reinterpret an already persisted financial control outcome.
        try { await this.deps.selectedNotifications(profile, entry.sessionId, outcome === 'starting'); } catch { /* Available on the next selected view. */ }
      }
      return { ...await this.read(), requestId: entry.requestId, outcome, message: messages[outcome] };
    };
    // The journal is the durable guard; concurrent callers share only their exact
    // request. Stop uses its own request and is never queued behind slow launch.
    const current = this.active.get(id);
    if (current) {
      if (current.action !== entry.action) throw new PortfolioControlError(409, 'This request ID already belongs to another control action.');
      return current.promise.then(async result => {
        if (!['starting', 'setting-up'].includes(result.state)) return result;
        if (this.setups.has(id)) return { ...result, ...await this.read() };
        const saved = (await this.entries()).find(item => key(item) === id);
        return { ...await this.read(), requestId: entry.requestId, outcome: saved?.outcome === 'prepared' ? 'starting' : 'already-handled' };
      });
    }
    const running = operation();
    const response = Promise.race([running, ready]);
    this.active.set(id, { action: entry.action, promise: response });
    void running.catch(() => { /* Durable prepared entry retains uncertain background failures. */ }).finally(() => {
      if (this.active.get(id)?.promise === response) this.active.delete(id);
    });
    return response;
  }
}
