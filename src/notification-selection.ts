import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { connectionPath, readProfiles, resolveProfile, type RoutedProfile } from '../scripts/profile-routing.mjs';
import { acquireLock, readJson } from './storage.js';

export const isCodexSession = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
export async function withNotificationSelection<T>(root: string, sessionId: string, action: () => Promise<T>): Promise<T> {
  const name = `notification-selection-${createHash('sha256').update(sessionId).digest('hex')}.lock`;
  let release: (() => Promise<void>) | undefined;
  for (let attempt = 0; ; attempt++) {
    try { release = await acquireLock(root, name); break; }
    catch (error) {
      if (attempt >= 39 || !(error instanceof Error) || !error.message.startsWith(`Lock ${name} is held`)) throw error;
      await new Promise(done => setTimeout(done, 25));
    }
  }
  try { return await action(); } finally { await release(); }
}

/** Never use the sole-wallet fallback for a notification destination. */
export async function selectedNotificationProfile(root: string, sessionId: string): Promise<RoutedProfile | null> {
  const linked = await readJson<{ version?: number; chainId?: number; wallet?: string }>(connectionPath(root, sessionId));
  if (linked === null) return null;
  if (linked.version !== 1 || linked.chainId !== 4663 || typeof linked.wallet !== 'string') throw new Error('Notification selection is invalid');
  return resolveProfile(root, { wallet: linked.wallet });
}

/** Public ownership and running state only; unknown state never authorizes delivery. */
export async function selectedPortfolioRunning(root: string, sessionId: string, dataDir: string): Promise<boolean> {
  const selected = await selectedNotificationProfile(root, sessionId);
  if (!selected?.wallet || resolve(selected.dataDir) !== resolve(dataDir)) return false;
  const registered = (await readProfiles(root)).find(profile => profile.wallet === selected.wallet);
  if (!registered || registered.dataDir !== selected.dataDir) return false;
  const [config, state, lock, stopped] = await Promise.all([
    readJson<{ wallet?: string; chainId?: number; mode?: string }>(resolve(dataDir, 'config.json')),
    readJson<{ app?: string; wallet?: string; chain?: { id?: number }; mode?: string; armed?: boolean; updatedAt?: string }>(resolve(dataDir, 'status.json')),
    readJson<{ pid?: number; createdAt?: string; token?: string }>(resolve(dataDir, 'run.lock')),
    readJson(resolve(dataDir, 'stop.json')),
  ]);
  if (config?.chainId !== 4663 || !['private-key', 'privy', 'ledger'].includes(config.mode ?? '') || config.wallet?.toLowerCase() !== selected.wallet ||
      state?.app !== 'Rebalance' || state.chain?.id !== 4663 || state.mode !== config.mode ||
      state.wallet?.toLowerCase() !== selected.wallet || state.armed !== true || stopped !== null ||
      typeof lock?.createdAt !== 'string' || !Number.isFinite(Date.parse(lock.createdAt)) ||
      typeof lock.token !== 'string' || !lock.token || Object.keys(lock).some(key => !['pid', 'createdAt', 'token'].includes(key)) ||
      !Number.isSafeInteger(lock?.pid) || lock!.pid! <= 0 || lock!.pid! > 2_147_483_647) return false;
  try { process.kill(lock!.pid!, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') return true; if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}
