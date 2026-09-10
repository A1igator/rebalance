import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_OUTPUT = 65_536;
const cmuxPath = '/Applications/cmux.app/Contents/Resources/bin/cmux';
const hostRequired = { host: 'host', opened: false, reason: 'native-pane-required' };

function uuid(value) { return typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null; }

/** Only local Rebalance URLs supplied by the view command may reach a browser. */
function localUrl(value) {
  if (typeof value !== 'string' || value.length > 8192 || /[\u0000-\u0020\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
      !url.username && !url.password ? url : null;
  } catch { return null; }
}

async function readRecord(path) {
  try {
    if ((await stat(path)).size > 8192) throw new Error('Invalid view record');
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function saveRecord(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

/**
 * cmux is a companion browser, not a trading or message transport.
 * Documented CLI: https://cmux.com/docs/browser-automation
 * Explicit source/workspace + --focus false are also in the installed CLI help.
 * JSON UUID output avoids short handles being reassigned after an app restart.
 */
export async function openCompanionView({ url: value, rootDir, sessionId }, overrides = {}) {
  const url = localUrl(value);
  if (!url) return { host: 'host', opened: false, reason: 'invalid-view-url' };
  const env = overrides.env ?? process.env;
  const workspaceId = uuid(env.CMUX_WORKSPACE_ID);
  const sourceId = uuid(env.CMUX_SURFACE_ID);
  if (!workspaceId || !sourceId) return { ...hostRequired };
  if (typeof rootDir !== 'string' || !isAbsolute(rootDir) ||
      typeof sessionId !== 'string' || !sessionId || sessionId.length > 2048 || /[\u0000-\u001f\u007f]/.test(sessionId)) {
    return { host: 'cmux', opened: false, reason: 'invalid-view-context' };
  }
  const execute = overrides.execute ?? executeFile;
  const command = overrides.command ?? (existsSync(cmuxPath) ? cmuxPath : 'cmux');
  const request = async args => {
    const result = await execute(command, ['--json', '--id-format', 'uuids', ...args], {
      env, timeout: 5000, killSignal: 'SIGKILL', maxBuffer: MAX_OUTPUT, encoding: 'utf8', windowsHide: true,
    });
    if (typeof result.stdout !== 'string' || Buffer.byteLength(result.stdout) > MAX_OUTPUT) throw new Error('Invalid view response');
    const parsed = JSON.parse(result.stdout);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.error !== undefined || parsed.ok === false) {
      throw new Error('Invalid view response');
    }
    return parsed;
  };
  const identify = async surfaceId => {
    const result = await request(['identify', '--workspace', workspaceId, '--surface', surfaceId]);
    return result.caller && uuid(result.caller.workspace_id) === workspaceId &&
      uuid(result.caller.surface_id) === surfaceId;
  };
  const directory = join(rootDir, 'companion-views');
  const digest = createHash('sha256').update(JSON.stringify([sessionId, workspaceId, sourceId])).digest('hex');
  const path = join(directory, `${digest}.json`);
  const lockPath = `${path}.lock`;
  let lock;
  try {
    // A moved/stale terminal identity never falls back to the focused workspace.
    if (!await identify(sourceId)) return { host: 'cmux', opened: false, reason: 'workspace-unavailable' };
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try { lock = await open(lockPath, 'wx', 0o600); }
    catch (error) {
      if (error.code === 'EEXIST') return { host: 'cmux', opened: false, reason: 'view-busy' };
      throw error;
    }
    const saved = await readRecord(path);
    if (saved !== null && (saved.version !== 1 || saved.workspaceId !== workspaceId || saved.sourceId !== sourceId ||
        !['ready', 'opening'].includes(saved.state) || !localUrl(saved.origin) ||
        new URL(saved.origin).origin !== saved.origin || saved.state === 'ready' && !uuid(saved.surfaceId))) {
      return { host: 'cmux', opened: false, reason: 'view-record-unavailable' };
    }
    // A native create may have succeeded before its response or receipt was lost.
    // Preserve this barrier instead of repeatedly opening extra browser panes.
    if (saved?.state === 'opening') return { host: 'cmux', opened: false, reason: 'open-unverified' };
    if (saved?.state === 'ready' && await identify(saved.surfaceId)) {
      const current = await request(['browser', '--surface', saved.surfaceId, 'url']);
      if (localUrl(current.url)?.origin !== saved.origin) {
        return { host: 'cmux', opened: false, reason: 'view-repurposed' };
      }
      await request(['browser', '--surface', saved.surfaceId, 'navigate', url.href]);
      await saveRecord(path, { ...saved, origin: url.origin });
      return { host: 'cmux', opened: true, reused: true };
    }
    const record = { version: 1, state: 'opening', workspaceId, sourceId, origin: url.origin };
    await saveRecord(path, record);
    const created = await request(['browser', '--surface', sourceId, 'open-split', url.href,
      '--workspace', workspaceId, '--focus', 'false']);
    const surfaceId = uuid(created.surface_id);
    if (!surfaceId || surfaceId === sourceId || uuid(created.workspace_id) !== workspaceId) throw new Error('Invalid view response');
    await saveRecord(path, { ...record, state: 'ready', surfaceId });
    return { host: 'cmux', opened: true, reused: false };
  } catch {
    // Do not return native output, local file paths, tokens, environment or errors.
    return { host: 'cmux', opened: false, reason: 'view-unavailable' };
  } finally {
    if (lock) { await lock.close().catch(() => {}); await rm(lockPath, { force: true }).catch(() => {}); }
  }
}
