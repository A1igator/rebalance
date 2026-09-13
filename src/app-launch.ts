import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readProfiles, sessionIdentity, validateProfileDirectory, type RoutedProfile } from '../scripts/profile-routing.mjs';
import { readAppEntryInputs } from '../scripts/app-entry-inputs.mjs';
import { acquireLock, atomicWriteJson } from './storage.js';
import { captureRunnerPreference, runnerPreferenceMatches, withRunnerControl } from './runner-preference.js';
import { prepareView } from './view.js';

type Entry = { profile: RoutedProfile; generation: string | null; expectedStop: string | null; problem?: string };
type Journal = { version: 1; requestId: string; sessionId: string | null; entries: Entry[] };
type PublicResult = { app: string; outcome: string; status: { armed: boolean; wallet: string | null; chain: { id: number }; error?: string | null } | null; messages?: string[] };
export type AppLaunchDependencies = {
  capture: typeof captureRunnerPreference;
  matches: (profile: RoutedProfile, generation: string, expectedStop: string) => Promise<boolean>;
  view: typeof prepareView;
  launch: (profile: RoutedProfile, requestId: string, generation: string, expectedStop: string, sessionId?: string) => Promise<PublicResult>;
};
const repository = fileURLToPath(new URL('..', import.meta.url));
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const defaults: AppLaunchDependencies = {
  capture: captureRunnerPreference,
  matches: (profile, generation, expectedStop) => withRunnerControl(profile.dataDir,
    () => runnerPreferenceMatches(profile.dataDir, profile.wallet!, generation, expectedStop)),
  view: prepareView,
  launch: (profile, requestId, generation, expectedStop, sessionId) => new Promise((done, fail) => {
    execFile(process.execPath, ['--import', 'tsx', resolve(repository, 'src/cli.ts'), 'launch',
      '--request-id', requestId, '--expected-stop', expectedStop, '--expected-runner-generation', generation], {
      cwd: repository, timeout: 240_000, maxBuffer: 1_048_576,
      env: { ...process.env, REBALANCE_ROOT_DIR: profile.rootDir, REBALANCE_DATA_DIR: profile.dataDir,
        REBALANCE_CHART_PORT: String(profile.chartPort), REBALANCE_PROFILE_PINNED: '1',
        REBALANCE_PROFILE_WALLET: profile.wallet!, REBALANCE_SESSION_ID: sessionId ?? '' },
    }, (_error, stdout) => {
      try { done(JSON.parse(stdout)); }
      catch { fail(new Error('Portfolio restoration could not be verified.')); }
    });
  }),
};
function validateJournal(value: unknown, root: string, requestId: string, sessionId: string | null): Journal {
  const j = value as Journal | null;
  if (!j || j.version !== 1 || j.requestId !== requestId || j.sessionId !== sessionId || !Array.isArray(j.entries)) throw new Error('Invalid app entry record; no restoration was attempted.');
  const wallets = new Set<string>(), ports = new Set<number>();
  for (const entry of j.entries) {
    const p = entry?.profile;
    if (!p || p.rootDir !== root || typeof p.wallet !== 'string' || !/^0x[a-f0-9]{40}$/.test(p.wallet) || p.chainId !== 4663 ||
        !['.', `wallets/${p.wallet}`].includes(p.directory) || p.dataDir !== resolve(root, p.directory) ||
        !Number.isInteger(p.chartPort) || p.chartPort < 4663 || p.chartPort > 65535 || (p.directory === '.' ? p.chartPort !== 4663 : p.chartPort === 4663) ||
        wallets.has(p.wallet) || ports.has(p.chartPort) ||
        !(entry.generation === null && entry.expectedStop === null || typeof entry.generation === 'string' && uuid.test(entry.generation) &&
          typeof entry.expectedStop === 'string' && /^(none|[a-f0-9]{64})$/.test(entry.expectedStop)) ||
        (entry.problem !== undefined && entry.problem !== 'Running preference could not be verified.')) throw new Error('Invalid app entry record; no restoration was attempted.');
    wallets.add(p.wallet); ports.add(p.chartPort);
  }
  return j;
}

/** A user app-entry request restores only remembered running intent, never every registered wallet. */
export async function restoreApp(rootDir: string, sessionId: string | undefined,
  options: { requestId?: string; setupOnly?: boolean } = {}, overrides: Partial<AppLaunchDependencies> = {}) {
  const root = resolve(rootDir), session = sessionIdentity(sessionId, {});
  const deps = { ...defaults, ...overrides };
  const view = async () => {
    try { return await deps.view(root, session); }
    catch { return { state: 'unavailable' as const, message: 'The portfolio selector could not be opened.' }; }
  };
  if (options.setupOnly) return { app: 'Rebalance', outcome: 'select-portfolio', status: null,
    portfolios: [], restoration: 'not-requested', messages: [], view: await view() };
  const requestId = options.requestId ?? `app:${randomUUID()}`;
  if (!requestId || requestId.length > 2048 || /[\0\r\n]/.test(requestId)) throw new Error('Invalid app entry request.');
  const path = resolve(root, 'app-launch-requests', `${digest(requestId)}.json`);
  const release = await acquireLock(root, `app-entry-${digest(requestId)}.lock`);
  let journal: Journal, replay = false;
  try {
    let saved: unknown;
    let exists = true;
    try { saved = JSON.parse(await readFile(path, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; exists = false; }
    if (exists) { journal = validateJournal(saved, root, requestId, session ?? null); replay = true; }
    else {
      const entries: Entry[] = [];
      const inputs = await readAppEntryInputs(root, requestId, session ?? null);
      const profiles = await readProfiles(root);
      // Native hooks freeze public inputs before dependency bootstrap. Direct
      // CLI entries reach this boundary without any bootstrap side effects.
      const candidates = inputs?.entries ?? profiles.map(profile => ({ profile, input: undefined }));
      for (const candidate of candidates) {
        const { profile, input } = candidate;
        let entry: Entry = { profile, generation: null, expectedStop: null };
        try {
          if (input === null) throw new Error('Unavailable frozen inputs');
          const current = profiles.find(p => p.wallet === profile.wallet);
          if (!current || current.dataDir !== profile.dataDir || current.chartPort !== profile.chartPort) throw new Error('Portfolio changed during bootstrap');
          await validateProfileDirectory(root, profile.directory);
          const snapshot = await deps.capture(profile.dataDir, profile.wallet!, input ? { expectedInput: input } : {});
          if (snapshot.eligible && snapshot.preference?.enabled) entry = {
            profile, generation: snapshot.preference.generation, expectedStop: snapshot.expectedStop,
          };
        } catch { entry.problem = 'Running preference could not be verified.'; }
        entries.push(entry);
      }
      journal = validateJournal({ version: 1, requestId, sessionId: session ?? null, entries }, root, requestId, session ?? null);
      // This immutable snapshot is consumed before any view or runner startup.
      // An interrupted request is not a reason to expand or replay its starts.
      await atomicWriteJson(path, journal);
    }
  } finally { await release(); }
  if (replay) return { app: 'Rebalance', outcome: 'already-handled', status: null, portfolios: [],
    restoration: 'not-repeated', messages: [], view: await view() };
  const viewResult = await view();
  const portfolios = await Promise.all(journal.entries.map(async entry => {
    const { profile } = entry;
    const result = (outcome: string, message?: string) => ({ wallet: profile.wallet, result: {
      app: 'Rebalance', outcome, status: null, messages: message ? [message] : [],
    } as PublicResult });
    if (entry.problem) return result('blocked', entry.problem);
    if (entry.generation === null) return result('not-requested');
    try {
      const current = (await readProfiles(root)).find(p => p.wallet === profile.wallet);
      if (!current || current.dataDir !== profile.dataDir || current.chartPort !== profile.chartPort) return result('blocked', 'The portfolio changed during startup.');
      await validateProfileDirectory(root, profile.directory);
      if (!await deps.matches(profile, entry.generation, entry.expectedStop!)) return result('not-requested');
      const restored = await deps.launch(profile, `restore:${digest(JSON.stringify([requestId, profile.wallet]))}`,
        entry.generation, entry.expectedStop!, session);
      if (restored?.app !== 'Rebalance' || typeof restored.outcome !== 'string' ||
          (restored.status !== null && (!restored.status || typeof restored.status.armed !== 'boolean' ||
            restored.status.wallet?.toLowerCase() !== profile.wallet || restored.status.chain?.id !== 4663)) ||
          (restored.outcome === 'armed' && restored.status?.armed !== true)) throw new Error('Invalid restore result');
      return { wallet: profile.wallet, result: restored };
    } catch { return result('unknown', 'Portfolio startup could not be verified. Do not repeat this request.'); }
  }));
  const pending = portfolios.some(p => ['starting', 'busy', 'unknown'].includes(p.result.outcome));
  const blocked = portfolios.some(p =>
    (p.result.outcome !== 'not-requested' && p.result.status?.armed !== true) || p.result.status?.error);
  return { app: 'Rebalance', outcome: pending ? 'starting' : blocked || viewResult.state !== 'ready' ? 'partial' : 'ready',
    status: null, portfolios, restoration: 'checked', messages: [], view: viewResult };
}
