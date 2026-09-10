import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { DATA, validateConfig, type Config } from './config.js';
import { acquireLock, atomicWriteJson, readJson } from './storage.js';

const QUEUE_MS = 120_000;
const EXECUTION_MS = 600_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const OUTCOME = /^[a-z][a-z0-9-]{0,63}$/;
export const LEDGER_REQUEST_PATH = resolve(DATA, 'ledger-request.json');

export type LedgerRequest = {
  id: string;
  state: 'requested' | 'consumed' | 'finished';
  wallet: string;
  chainId: 4663;
  configFingerprint: string;
  runnerPid: number;
  runnerToken: string;
  createdAt: number;
  queueExpiresAt: number;
  expiresAt: number;
  consumedAt?: number;
  finishedAt?: number;
  outcome?: string;
};
export type LedgerRequestOptions = {
  dataDir?: string;
  now?: () => number;
  pid?: number;
  isAlive?: (pid: number) => boolean;
};
type Journal = { version: 1; records: LedgerRequest[] };
type Runner = { pid: number; token: string };

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw error;
  }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
export function ledgerConfigFingerprint(config: Config): string {
  const validated = validateConfig(config);
  return createHash('sha256').update(canonical({ ...validated, wallet: validated.wallet.toLowerCase() })).digest('hex');
}
function integer(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function validPid(value: unknown): value is number { return integer(value) && value > 0 && value <= 2_147_483_647; }
function validRecord(value: unknown): value is LedgerRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const r = value as LedgerRequest;
  const fields = ['id', 'state', 'wallet', 'chainId', 'configFingerprint', 'runnerPid', 'runnerToken',
    'createdAt', 'queueExpiresAt', 'expiresAt', 'consumedAt', 'finishedAt', 'outcome'];
  if (Object.keys(r).some(field => !fields.includes(field))) return false;
  if (typeof r.id !== 'string' || !UUID.test(r.id) || r.id !== r.id.toLowerCase() ||
      !['requested', 'consumed', 'finished'].includes(r.state) || typeof r.wallet !== 'string' ||
      !/^0x[0-9a-f]{40}$/.test(r.wallet) || r.chainId !== 4663 ||
      typeof r.configFingerprint !== 'string' || !HASH.test(r.configFingerprint) ||
      !validPid(r.runnerPid) || typeof r.runnerToken !== 'string' || !UUID.test(r.runnerToken) ||
      !integer(r.createdAt) || !integer(r.queueExpiresAt) || !integer(r.expiresAt) ||
      r.queueExpiresAt !== r.createdAt + QUEUE_MS || r.expiresAt !== r.createdAt + EXECUTION_MS) return false;
  if (r.consumedAt !== undefined && (!integer(r.consumedAt) || r.consumedAt < r.createdAt || r.consumedAt >= r.queueExpiresAt)) return false;
  if (r.state === 'requested' && r.consumedAt !== undefined) return false;
  if (r.state === 'consumed' && r.consumedAt === undefined) return false;
  if (r.state === 'finished') return integer(r.finishedAt) && typeof r.outcome === 'string' && OUTCOME.test(r.outcome);
  return r.finishedAt === undefined && r.outcome === undefined;
}

class RequestStore {
  readonly directory: string;
  readonly now: () => number;
  readonly pid: number;
  readonly alive: (pid: number) => boolean;
  constructor(options: LedgerRequestOptions = {}) {
    this.directory = resolve(options.dataDir ?? DATA);
    this.now = options.now ?? Date.now;
    this.pid = options.pid ?? process.pid;
    this.alive = options.isAlive ?? isAlive;
    if (!validPid(this.pid)) throw new Error('Invalid Ledger runner PID');
  }
  path(name: string) { return resolve(this.directory, name); }
  async journal(): Promise<Journal> {
    let value: Journal | null;
    try { value = await readJson<Journal>(this.path('ledger-request.json')); }
    catch { throw new Error('Ledger request journal is unavailable or invalid; signing remains unavailable'); }
    if (value === null) return { version: 1, records: [] };
    if (!value || Object.keys(value).some(field => !['version', 'records'].includes(field)) ||
        value.version !== 1 || !Array.isArray(value.records) || !value.records.every(validRecord) ||
        new Set(value.records.map(record => record.id)).size !== value.records.length ||
        value.records.filter(record => record.state !== 'finished').length > 1) {
      throw new Error('Invalid Ledger request journal; signing remains unavailable');
    }
    return value;
  }
  async config(): Promise<Config> {
    let config: Config;
    try {
      const value = await readJson<unknown>(this.path('config.json'));
      if (value === null) throw new Error('No portfolio is configured');
      config = validateConfig(value);
    } catch { throw new Error('Ledger portfolio configuration is unavailable or invalid'); }
    const pinnedWallet = process.env.REBALANCE_PROFILE_WALLET;
    if (pinnedWallet && pinnedWallet.toLowerCase() !== config.wallet.toLowerCase()) throw new Error('Configured wallet differs from the pinned portfolio');
    return config;
  }
  async runner(): Promise<Runner | null> {
    let value: Runner | null;
    try { value = await readJson<Runner>(this.path('run.lock')); }
    catch { throw new Error('Ledger runner identity is unavailable or invalid'); }
    if (value === null) return null;
    if (!validPid(value.pid) || typeof value.token !== 'string' || !UUID.test(value.token)) throw new Error('Invalid Ledger runner identity');
    return this.alive(value.pid) ? value : null;
  }
  async stopped() {
    try { return (await readJson(this.path('stop.json'))) !== null; }
    catch { throw new Error('Ledger stop state is unavailable or invalid'); }
  }
  async write(journal: Journal) { await atomicWriteJson(this.path('ledger-request.json'), journal); }
  async locked<T>(work: () => Promise<T>): Promise<T> {
    const release = await acquireLock(this.directory, 'ledger-request.lock');
    try { return await work(); } finally { await release(); }
  }
  terminal(record: LedgerRequest, outcome: string) {
    record.state = 'finished'; record.outcome = outcome; record.finishedAt = this.now();
  }
  async invalidReason(record: LedgerRequest, config: Config, owned: boolean): Promise<string | null> {
    const now = this.now();
    if (now < record.createdAt || now >= (record.state === 'requested' ? record.queueExpiresAt : record.expiresAt)) return 'expired';
    if (await this.stopped()) return 'stopped';
    const saved = await this.config();
    if (config.mode !== 'ledger' || saved.mode !== 'ledger' || record.wallet !== config.wallet.toLowerCase() ||
        record.chainId !== config.chainId || ledgerConfigFingerprint(config) !== record.configFingerprint ||
        ledgerConfigFingerprint(saved) !== record.configFingerprint) return 'configuration-changed';
    const runner = await this.runner();
    if (!runner || runner.pid !== record.runnerPid || runner.token !== record.runnerToken ||
        (owned && runner.pid !== this.pid)) return 'runner-changed';
    return null;
  }
}

/** Explicit user intent only. This never starts a runner, touches hardware or signs. */
export async function requestLedgerRebalance(requestId: string = randomUUID(), options: LedgerRequestOptions = {}): Promise<LedgerRequest> {
  if (!UUID.test(requestId)) throw new Error('Ledger request ID must be a UUID');
  const id = requestId.toLowerCase();
  const store = new RequestStore(options);
  return store.locked(async () => {
    const journal = await store.journal();
    if (journal.records.some(record => record.id === id)) throw new Error('Ledger request ID was already used; a replay cannot authorize signing');
    const now = store.now();
    const previous = journal.records.find(record => record.state !== 'finished');
    if (previous) {
      if (now < (previous.state === 'requested' ? previous.queueExpiresAt : previous.expiresAt)) {
        throw new Error('A Ledger rebalance request is already pending or active');
      }
      store.terminal(previous, 'expired');
      await store.write(journal);
    }
    const config = await store.config();
    if (config.mode !== 'ledger') throw new Error('This portfolio does not use Ledger');
    if (await store.stopped()) throw new Error('Portfolio has a stop request; no Ledger signing request queued');
    const runner = await store.runner();
    if (!runner) throw new Error('Start this Ledger portfolio monitor before requesting a rebalance');
    const record: LedgerRequest = { id, state: 'requested', wallet: config.wallet.toLowerCase(), chainId: 4663,
      configFingerprint: ledgerConfigFingerprint(config), runnerPid: runner.pid, runnerToken: runner.token,
      createdAt: now, queueExpiresAt: now + QUEUE_MS, expiresAt: now + EXECUTION_MS };
    journal.records.push(record);
    await store.write(journal);
    return { ...record };
  });
}

/** Public local journal projection only; this does not consume queued intent. */
export async function readLedgerRequest(options: LedgerRequestOptions = {}): Promise<LedgerRequest | null> {
  return (await new RequestStore(options).journal()).records.at(-1) ?? null;
}

/** In-memory capability belongs only to the runner that durably consumed this intent. */
export class LedgerExecution {
  private readonly store: RequestStore;
  private current: LedgerRequest | undefined;
  private boundCycle: { startedAt: number; activeUntil: number } | undefined;
  private generation = 0;
  constructor(options: LedgerRequestOptions = {}) { this.store = new RequestStore(options); }
  get active(): boolean { return !!this.current && this.store.now() >= this.current.createdAt && this.store.now() < this.expiresAt!; }
  get expiresAt(): number | undefined {
    return this.current && Math.min(this.current.expiresAt, this.boundCycle?.activeUntil ?? this.current.expiresAt);
  }

  /** Bind the first dispatched cycle. A later approval receipt cannot renew its window. */
  async bindCycle(cycle: { startedAt: string; activeUntil: string }): Promise<void> {
    try {
      if (!this.current || !this.active) throw new Error('No active Ledger rebalance request');
      const startedAt = typeof cycle.startedAt === 'string' ? Date.parse(cycle.startedAt) : NaN;
      const activeUntil = typeof cycle.activeUntil === 'string' ? Date.parse(cycle.activeUntil) : NaN;
      if (!integer(startedAt) || !integer(activeUntil) || activeUntil <= startedAt || activeUntil > startedAt + EXECUTION_MS ||
          this.store.now() < startedAt || this.store.now() >= activeUntil) throw new Error('Invalid or expired Ledger rebalance cycle');
      if (this.boundCycle && (startedAt !== this.boundCycle.startedAt || activeUntil !== this.boundCycle.activeUntil)) {
        throw new Error('Ledger rebalance cycle changed');
      }
      this.boundCycle = { startedAt, activeUntil };
    } catch (error) {
      try { await this.finish('cycle-invalidated'); } catch { /* Permission was already cleared. */ }
      throw error;
    }
  }

  async prepare(config: Config): Promise<void> {
    if (this.current) {
      try { await this.assertReady(config); } catch { /* Invalid intent remains consumed/terminal. */ }
      return;
    }
    const generation = this.generation;
    await this.store.locked(async () => {
      const journal = await this.store.journal();
      const record = journal.records.at(-1);
      if (!record || record.state === 'finished') return;
      let reason: string | null;
      try { reason = await this.store.invalidReason(record, config, true); }
      catch (error) {
        this.store.terminal(record, 'invalidated');
        await this.store.write(journal);
        throw error;
      }
      if (reason || record.state === 'consumed') {
        this.store.terminal(record, reason ?? 'runner-restarted');
        await this.store.write(journal);
        return;
      }
      const consumedAt = this.store.now();
      if (consumedAt < record.createdAt || consumedAt >= record.queueExpiresAt) {
        this.store.terminal(record, 'expired'); await this.store.write(journal); return;
      }
      record.state = 'consumed'; record.consumedAt = consumedAt;
      // Persist BEFORE establishing any in-memory permission to quote/sign.
      await this.store.write(journal);
      const claimedAt = this.store.now();
      if (generation !== this.generation || claimedAt < record.createdAt || claimedAt >= record.queueExpiresAt) {
        this.store.terminal(record, generation !== this.generation ? 'invalidated' : 'expired');
        await this.store.write(journal);
        return;
      }
      this.current = { ...record };
      this.boundCycle = undefined;
    });
  }

  async assertReady(config: Config): Promise<void> {
    const current = this.current;
    if (!current) throw new Error('No active Ledger rebalance request');
    try {
      const journal = await this.store.journal();
      const saved = journal.records.at(-1);
      if (!saved || canonical(saved) !== canonical(current)) throw new Error('Ledger request changed or was already consumed elsewhere');
      const reason = await this.store.invalidReason(saved, config, true);
      if (reason) throw new Error(`Ledger rebalance request is no longer valid: ${reason}`);
      if (this.boundCycle) {
        let cycle: { wallet: string; startedAt: number; activeUntil: number } | null;
        try { cycle = await readJson(this.store.path('cycle.json')); }
        catch { throw new Error('Ledger rebalance cycle is unavailable or invalid'); }
        if (!cycle || typeof cycle.wallet !== 'string' || cycle.wallet.toLowerCase() !== current.wallet ||
            cycle.startedAt !== this.boundCycle.startedAt || cycle.activeUntil !== this.boundCycle.activeUntil) {
          throw new Error('Ledger rebalance cycle changed');
        }
      }
      // Async file reads must not outlive a concurrent finish or the bound deadline.
      if (this.current !== current) throw new Error('Ledger rebalance request ended during validation');
      if (!this.active) throw new Error('Ledger rebalance request or cycle expired');
    } catch (error) {
      if (this.current === current) {
        try { await this.finish('invalidated'); } catch { this.current = undefined; }
      }
      throw error;
    }
  }

  async finish(outcome: string): Promise<void> {
    const current = this.current;
    this.current = undefined; // Fail closed even if the terminal write itself fails.
    this.boundCycle = undefined; this.generation++;
    if (!OUTCOME.test(outcome)) throw new Error('Ledger outcome must be a short status code');
    if (!current) return;
    await this.store.locked(async () => {
      const journal = await this.store.journal();
      const saved = journal.records.find(record => record.id === current.id);
      if (!saved || canonical(saved) !== canonical(current)) return;
      this.store.terminal(saved, outcome);
      await this.store.write(journal);
    });
  }
}
