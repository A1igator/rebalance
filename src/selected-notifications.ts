import { portfolioNotificationsEnabled } from './notification-delivery.js';
import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectedNotificationProfile, selectedPortfolioRunning, withNotificationSelection, isCodexSession } from './notification-selection.js';
import { codexNotificationStatus, prepareCodexNotifications, selectCodexNotifications } from './codex-notifications.js';
import { acquireLock, atomicWriteJson, readJson } from './storage.js';
import type { RoutedProfile } from '../scripts/profile-routing.mjs';

const repository = fileURLToPath(new URL('..', import.meta.url));
const alive = (pid: unknown) => {
  if (!Number.isSafeInteger(pid) || Number(pid) <= 0 || Number(pid) > 2_147_483_647) return false;
  try { process.kill(Number(pid), 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
};
export type SelectedNotificationDependencies = {
  start: (profile: RoutedProfile) => Promise<void>;
};
async function startSelectedWorker(profile: RoutedProfile): Promise<void> {
  const deps = { rootDir: profile.rootDir, dataDir: profile.dataDir, projectDir: repository };
  const release = await acquireLock(profile.dataDir, 'codex-notifications-launch.lock');
  try {
    let prepared = await prepareCodexNotifications({ restoreOnly: true }, deps);
    if (!prepared.token || !prepared.status.enabled) return;
    // A destination handoff changes the token. Wait only for that old notification
    // process to release its own lock, without touching its signal or user Pause.
    for (let attempt = 0; attempt < 320; attempt++) {
      const previous = await readJson<{ pid: number; token: string }>(resolve(profile.dataDir, 'codex-notifications-process.json'));
      const status = await codexNotificationStatus(deps);
      if (previous?.token === prepared.token && (status.running || alive(previous.pid))) return;
      if (!status.running && !alive(previous?.pid)) break;
      if (attempt === 319) throw new Error('Previous notification worker is still closing');
      await new Promise(done => setTimeout(done, 50));
    }
    // A newer selection or explicit Pause may arrive while the old native send settles.
    prepared = await prepareCodexNotifications({ restoreOnly: true }, deps);
    if (!prepared.token || !prepared.status.enabled) return;
    const log = await open(resolve(profile.dataDir, 'codex-notifications.log'), 'a', 0o600);
    try {
      const child = spawn(process.execPath, ['--import', 'tsx', resolve(repository, 'src/cli.ts'),
        'notifications', 'run', '--notification-token', prepared.token], {
        cwd: repository, detached: true, stdio: ['ignore', log.fd, log.fd], env: { ...process.env,
          REBALANCE_ROOT_DIR: profile.rootDir, REBALANCE_DATA_DIR: profile.dataDir,
          REBALANCE_PROFILE_PINNED: '1', REBALANCE_PROFILE_WALLET: profile.wallet!, REBALANCE_CHART_PORT: String(profile.chartPort) },
      });
      await new Promise<void>((done, fail) => { child.once('spawn', done); child.once('error', fail); });
      child.unref();
      await atomicWriteJson(resolve(profile.dataDir, 'codex-notifications-process.json'), { pid: child.pid, token: prepared.token });
    } finally { await log.close(); }
  } finally { await release(); }
}

/** A trusted native attachment may prepare chat delivery, never financial execution. */
export async function ensureSelectedCodexNotifications(root: string, sessionId: string | undefined,
  options: { dataDir?: string; command?: string; starting?: boolean; explicitSelection?: boolean } = {},
  overrides: Partial<SelectedNotificationDependencies> = {}) {
  if (!isCodexSession(sessionId)) return { state: 'not-applicable' as const };
  if (!await portfolioNotificationsEnabled(root)) return { state: 'paused' as const };
  const id = sessionId.toLowerCase();
  const profile = await withNotificationSelection(root, id, async () => {
    const selected = await selectedNotificationProfile(root, id);
    if (!selected || (options.dataDir && resolve(options.dataDir) !== selected.dataDir)) return null;
    if (!options.starting && !await selectedPortfolioRunning(root, id, selected.dataDir)) return null;
    const binding = await selectCodexNotifications({ threadId: id, explicitSelection: options.explicitSelection, ...(options.command ? { command: options.command } : {}) },
      { rootDir: root, dataDir: selected.dataDir, projectDir: repository });
    if (binding.threadId !== id) return null;
    return selected;
  });
  if (!profile) return { state: 'inactive' as const };
  await (overrides.start ?? startSelectedWorker)(profile);
  return codexNotificationStatus({ rootDir: root, dataDir: profile.dataDir, projectDir: repository });
}
