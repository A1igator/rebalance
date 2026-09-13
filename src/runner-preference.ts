import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { validateConfig } from './config.js';
import { runnerInputMatches, type RunnerInput } from '../scripts/app-entry-inputs.mjs';
import { acquireLock, atomicWriteJson, isLiveLockContention, readJson } from './storage.js';

export type RunnerPreference = {
  version: 1; wallet: string; chainId: 4663; enabled: boolean; generation: string;
};
export type RunnerPreferenceSnapshot = {
  preference: RunnerPreference | null; expectedStop: string; eligible: boolean;
};
export const RUNNER_GENERATION = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const address = /^0x[0-9a-f]{40}$/i;
const filename = 'runner-preference.json';

function identity(wallet: string): string {
  if (typeof wallet !== 'string' || !address.test(wallet)) throw new Error('Invalid runner preference wallet');
  return wallet.toLowerCase();
}

/** Only a missing preference is unknown. Invalid records never become running intent. */
export async function readRunnerPreference(dataDir: string, wallet: string): Promise<RunnerPreference | null> {
  const expected = identity(wallet);
  let value: RunnerPreference;
  try { value = JSON.parse(await readFile(resolve(dataDir, filename), 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== 5 || Object.keys(value).some(key => !['version', 'wallet', 'chainId', 'enabled', 'generation'].includes(key)) ||
      value.version !== 1 || value.chainId !== 4663 || typeof value.wallet !== 'string' || value.wallet !== expected ||
      typeof value.enabled !== 'boolean' || typeof value.generation !== 'string' || !RUNNER_GENERATION.test(value.generation)) {
    throw new Error('Invalid runner preference; preserve the saved record for review');
  }
  return value;
}

/** Short shared boundary for explicit Start/Stop and restoration snapshots. */
export async function withRunnerControl<T>(dataDir: string, action: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    let release: () => Promise<void>;
    try { release = await acquireLock(dataDir, 'control.lock'); }
    catch (error) {
      if (attempt >= 99 || (!isLiveLockContention(error) && !(error instanceof SyntaxError))) throw error;
      await delay(20); continue;
    }
    try { return await action(); } finally { await release(); }
  }
}

/** Caller holds control.lock. Record true only at a real start while holding run.lock.
 * A repeated start of the same enabled intent preserves its frozen generation.
 * Stop always gets a fresh generation and can safely replace a malformed preference. */
export async function writeRunnerPreference(dataDir: string, wallet: string, enabled: boolean): Promise<RunnerPreference> {
  const normalized = identity(wallet);
  const previous = enabled ? await readRunnerPreference(dataDir, normalized) : null;
  if (previous?.enabled) return previous;
  const preference: RunnerPreference = { version: 1, wallet: normalized, chainId: 4663, enabled, generation: randomUUID() };
  await atomicWriteJson(resolve(dataDir, filename), preference);
  return preference;
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true;
    throw error;
  }
}

async function stopToken(dataDir: string): Promise<string> {
  let stopped: unknown;
  try { stopped = JSON.parse(await readFile(resolve(dataDir, 'stop.json'), 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'none';
    throw error;
  }
  return createHash('sha256').update(JSON.stringify(stopped)).digest('hex');
}

async function liveLegacyRunner(dataDir: string, wallet: string, alive: (pid: number) => boolean): Promise<boolean> {
  const [lock, saved, rawConfig] = await Promise.all([
    readJson<{ pid: number; createdAt: string; token: string }>(resolve(dataDir, 'run.lock')),
    readJson<{ app: string; wallet: string; chain: { id: number }; mode: string; armed: boolean }>(resolve(dataDir, 'status.json')),
    readJson(resolve(dataDir, 'config.json')),
  ]);
  if (!lock || typeof lock !== 'object' || Array.isArray(lock) ||
      Object.keys(lock).some(key => !['pid', 'createdAt', 'token'].includes(key)) ||
      !Number.isSafeInteger(lock.pid) || lock.pid <= 0 || lock.pid > 2_147_483_647 ||
      typeof lock.createdAt !== 'string' || !Number.isFinite(Date.parse(lock.createdAt)) ||
      typeof lock.token !== 'string' || lock.token.length === 0 || !alive(lock.pid)) return false;
  if (!saved || saved.app !== 'Rebalance' || saved.chain?.id !== 4663 || saved.armed !== true ||
      typeof saved.wallet !== 'string' || saved.wallet.toLowerCase() !== wallet || rawConfig === null) return false;
  const config = validateConfig(rawConfig);
  return config.wallet.toLowerCase() === wallet && saved.mode === config.mode;
}

/** Freeze intent and Stop together; a missing preference may adopt only a live owned legacy runner. */
export async function captureRunnerPreference(dataDir: string, wallet: string,
  options: { alive?: (pid: number) => boolean; expectedInput?: RunnerInput } = {}): Promise<RunnerPreferenceSnapshot> {
  const normalized = identity(wallet);
  return withRunnerControl(dataDir, async () => {
    if (options.expectedInput && !await runnerInputMatches(dataDir, options.expectedInput)) {
      return { preference: null, expectedStop: 'none', eligible: false };
    }
    let preference = await readRunnerPreference(dataDir, normalized);
    const expectedStop = await stopToken(dataDir);
    if (!preference && expectedStop === 'none' && await liveLegacyRunner(dataDir, normalized, options.alive ?? processAlive)) {
      preference = await writeRunnerPreference(dataDir, normalized, true);
    }
    return { preference, expectedStop, eligible: preference?.enabled === true && expectedStop === 'none' };
  });
}

/** Caller holds control.lock at the final start boundary. A Stop always wins. */
export async function runnerPreferenceMatches(dataDir: string, wallet: string, generation: string, expectedStop: string): Promise<boolean> {
  if (!RUNNER_GENERATION.test(generation) || expectedStop !== 'none') return false;
  const preference = await readRunnerPreference(dataDir, wallet);
  return preference?.enabled === true && preference.generation === generation && await stopToken(dataDir) === expectedStop;
}
