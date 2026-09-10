import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { get } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { readProfiles, resolveProfile, type RoutedProfile } from '../scripts/profile-routing.mjs';
import { acquireLock, readJson } from './storage.js';
import { issueView } from './view-session.js';

const repository = fileURLToPath(new URL('..', import.meta.url));
const execute = promisify(execFile);
type Probe = 'ready' | 'absent' | 'unavailable';
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
      response.on('data', chunk => { body += chunk; if (body.length > 4096) request.destroy(); });
      response.on('error', () => finish('unavailable'));
      response.on('end', () => {
        try {
          const value = JSON.parse(body);
          finish(response.statusCode === 200 && value.app === 'Rebalance' && value.viewVersion === 1 &&
            value.scope === createHash('sha256').update(resolve(profile.dataDir)).digest('hex') ? 'ready' : 'unavailable');
        } catch { finish('unavailable'); }
      });
    });
    request.setTimeout(1000, () => request.destroy());
    request.on('error', error => finish((error as NodeJS.ErrnoException).code === 'ECONNREFUSED' ? 'absent' : 'unavailable'));
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
      if (lock !== null && (!Number.isSafeInteger(lock.pid) || lock.pid <= 0 || lock.pid > 2_147_483_647)) throw new Error('Chart ownership is unavailable.');
      const owned = lock !== null && deps.alive(lock.pid);
      const state = await deps.probe(profile);
      if (state === 'ready') {
        if (!owned) throw new Error('The chart listener is not owned by this portfolio.');
        return { state: 'ready' as const, url: `http://127.0.0.1:${profile.chartPort}/chart` };
      }
      if (state === 'unavailable') throw new Error('The chart listener is unavailable or needs a view update.');
      if (!owned && !spawned) { spawned = true; await deps.spawnChart(profile); }
      await deps.pause();
    }
    throw new Error('Chart startup is not yet verified; no duplicate was started.');
  } finally { await release(); }
}

/** Selection-free entry for an empty registry or an unattached conversation. */
export async function prepareView(rootDir: string, sessionId: string | undefined, wallet?: string,
  overrides: Partial<ViewDependencies> = {}) {
  const profiles = await readProfiles(rootDir);
  const profile = wallet ? await resolveProfile(rootDir, { wallet }) : profiles.find(p => p.directory === '.') ?? {
    rootDir, dataDir: rootDir, directory: '.', wallet: null, chainId: 4663 as const, chartPort: 4663,
  };
  await ensurePortfolioChart(profile, overrides);
  const handle = sessionId ? await issueView(rootDir, sessionId) : null;
  const path = wallet ? '/chart' : '/';
  return { state: 'ready' as const, url: `http://127.0.0.1:${profile.chartPort}${path}${handle ? '#view=' + handle.token : ''}`,
    connected: Boolean(handle), tradingChanged: false };
}
