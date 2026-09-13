import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { get } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { readProfiles, resolveProfile, validateProfileDirectory, type RoutedProfile } from '../scripts/profile-routing.mjs';
import { acquireLock, readJson } from './storage.js';
import { issueView } from './view-session.js';
import { ViewError } from './view-error.js';

const repository = fileURLToPath(new URL('..', import.meta.url));
const execute = promisify(execFile);
type Probe = 'ready' | 'absent' | 'unavailable' | 'local-access-denied' | 'listener-incompatible';
const accessDenied = (error: unknown) => ['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException | null)?.code ?? '');
export type ViewDependencies = {
  probe: (profile: RoutedProfile) => Promise<Probe>;
  spawnChart: (profile: RoutedProfile) => Promise<void>;
  alive: (pid: number) => boolean;
  pause: () => Promise<void>;
};
const defaults: ViewDependencies = {
  probe: profile => new Promise(done => {
    let finished = false;
    const finish = (state: Probe) => { if (!finished) { finished = true; done(state); } };
    const request = get(`http://127.0.0.1:${profile.chartPort}/api/view/identity`, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; if (body.length > 4096) { finish('listener-incompatible'); request.destroy(); } });
      response.on('error', error => finish(accessDenied(error) ? 'local-access-denied' : 'unavailable'));
      response.on('end', () => {
        try {
          const value = JSON.parse(body);
          finish(response.statusCode === 200 && value.app === 'Rebalance' && value.viewVersion === 1 &&
            value.scope === createHash('sha256').update(resolve(profile.dataDir)).digest('hex') ? 'ready' : 'listener-incompatible');
        } catch { finish('listener-incompatible'); }
      });
    });
    request.setTimeout(1000, () => request.destroy());
    request.on('error', error => finish(accessDenied(error) ? 'local-access-denied' :
      (error as NodeJS.ErrnoException).code === 'ECONNREFUSED' ? 'absent' : 'unavailable'));
    request.on('close', () => finish('unavailable'));
  }),
  spawnChart: async profile => {
    await execute(process.execPath, ['--import', 'tsx', resolve(repository, 'src/cli.ts'), 'chart', '--background'], {
      cwd: repository, timeout: 10_000, maxBuffer: 16_384,
      env: { ...process.env, REBALANCE_ROOT_DIR: profile.rootDir, REBALANCE_DATA_DIR: profile.dataDir,
        REBALANCE_PROFILE_PINNED: '1', REBALANCE_PROFILE_WALLET: profile.wallet ?? '', REBALANCE_CHART_PORT: String(profile.chartPort) },
    });
  },
  alive: pid => { try { process.kill(pid, 0); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true;
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  } },
  pause: () => new Promise(done => setTimeout(done, 80)),
};

/** Starts only a read-only chart, never the launch/trading path. */
export async function ensurePortfolioChart(profile: RoutedProfile, overrides: Partial<ViewDependencies> = {}) {
  const deps = { ...defaults, ...overrides };
  const release = await acquireLock(profile.rootDir, `view-start-${profile.chartPort}.lock`);
  try {
    let spawned = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      const lock = await readJson<{pid: number}>(resolve(profile.dataDir, 'chart.lock'));
      if (lock !== null && (!Number.isSafeInteger(lock.pid) || lock.pid <= 0 || lock.pid > 2_147_483_647)) throw new ViewError('ownership-unverified');
      const owned = lock !== null && deps.alive(lock.pid);
      const state = await deps.probe(profile);
      if (state === 'ready') {
        if (!owned) throw new ViewError('ownership-unverified');
        return { state: 'ready' as const, url: `http://127.0.0.1:${profile.chartPort}/chart` };
      }
      if (state !== 'absent') throw new ViewError(state);
      if (!owned && !spawned) {
        spawned = true;
        try { await deps.spawnChart(profile); } catch { throw new ViewError('startup-unverified'); }
      }
      await deps.pause();
    }
    throw new ViewError('startup-unverified');
  } finally { await release(); }
}

/** Selection-free entry for an empty registry or an unattached conversation. */
export async function prepareView(rootDir: string, sessionId: string | undefined, wallet?: string,
  overrides: Partial<ViewDependencies> = {}) {
  const profiles = await readProfiles(rootDir);
  const rootProfile = profiles.find(p => p.directory === '.') ?? {
    rootDir, dataDir: rootDir, directory: '.', wallet: null, chainId: 4663 as const, chartPort: 4663,
  };
  let profile = wallet ? await resolveProfile(rootDir, { wallet }) : rootProfile;
  if (!wallet) {
    const deps = { ...defaults, ...overrides };
    // Every owned chart serves this root's selector. Reuse a ready one without
    // attaching its wallet or replacing an obsolete/foreign default listener.
    for (const candidate of [rootProfile, ...profiles.filter(p => p.directory !== '.')]) {
      await validateProfileDirectory(rootDir, candidate.directory);
      const lock = await readJson<{ pid: number }>(resolve(candidate.dataDir, 'chart.lock'));
      if (lock === null || !Number.isSafeInteger(lock.pid) || lock.pid <= 0 || lock.pid > 2_147_483_647 || !deps.alive(lock.pid)) continue;
      const state = await deps.probe(candidate);
      if (state === 'local-access-denied') throw new ViewError(state);
      if (state === 'ready') { profile = candidate; break; }
    }
  }
  await ensurePortfolioChart(profile, overrides);
  const handle = sessionId ? await issueView(rootDir, sessionId) : null;
  const path = wallet ? '/chart' : '/';
  return { state: 'ready' as const, url: `http://127.0.0.1:${profile.chartPort}${path}${handle ? '#view=' + handle.token : ''}`,
    connected: Boolean(handle), tradingChanged: false };
}
