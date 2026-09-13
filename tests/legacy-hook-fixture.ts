import { createHash } from 'node:crypto';
import { realpath, readFile, mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { assertTemporaryTestDirectory } from '../src/test-isolation.js';

type Selection = { requestId?: string; sessionId?: string; cwd?: string; blocked?: unknown };
type Profile = { wallet: string | null; dataDir: string; chartPort: number; rootDir: string };
/** Existing launch/recovery compatibility tests start with an explicit historical v1 route. */
export async function seedLegacyHookRoute(root: unknown, selected: Selection | null, overrides: Record<string, unknown>) {
  if (typeof root !== 'string' || !selected?.requestId || !selected.sessionId || !selected.cwd || selected.blocked) return;
  assertTemporaryTestDirectory(root);
  const cwd = relative(await realpath(root), await realpath(selected.cwd));
  if (cwd === '..' || cwd.startsWith('../') || isAbsolute(cwd)) return;
  const rootDir = resolve(root, '.local');
  const path = resolve(rootDir, 'hook-routes', `${selected.requestId}.json`);
  const digest = createHash('sha256').update(selected.requestId).digest('hex');
  try {
    for (const file of [path, resolve(rootDir, 'launch-requests', `${digest}.json`), resolve(rootDir, 'recovery-requests', `${digest}.json`)]) {
      try { await readFile(file); return; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return; }
    }
    const resolver = overrides.resolveProfile as undefined | ((root: string, context: { sessionId: string }) => Promise<Profile>);
    const profile = resolver ? await resolver(rootDir, { sessionId: selected.sessionId }) :
      { wallet: `0x${'1'.repeat(40)}`, dataDir: rootDir, chartPort: 4663, rootDir };
    await mkdir(resolve(rootDir, 'hook-routes'), { recursive: true, mode: 0o700 });
    await writeFile(path, JSON.stringify({ version: 1, requestId: selected.requestId, sessionId: selected.sessionId, profile }) + '\n', { flag: 'wx', mode: 0o600 });
  } catch { /* Corrupt route/storage cases are handled by the actual hook. */ }
}

/** Stub only local chart preparation while exercising the real cold CLI/app journal. */
export const isolatedViewPreload = `
  import { registerHooks } from 'node:module';
  const fixtureView = ${JSON.stringify(new URL('../src/view.ts', import.meta.url).href)};
  registerHooks({ resolve(specifier, context, nextResolve) {
    if (specifier === './view.js' && context.parentURL?.endsWith('/src/app-launch.ts')) return { url: fixtureView, shortCircuit: true };
    return nextResolve(specifier, context);
  }, load(url, context, nextLoad) {
    if (url === fixtureView) return { format: 'module', shortCircuit: true, source:
      "export async function ensurePortfolioChart() { throw new Error('Fixture must not start a chart'); } export async function prepareView(root, session) { return { state: 'ready', url: 'http://127.0.0.1:4663/#view=' + 'a'.repeat(64), connected: Boolean(session), tradingChanged: false }; }" };
    return nextLoad(url, context);
  } });
`;
