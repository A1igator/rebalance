import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { watch } from 'node:fs';
import { mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectionPath, portfolioRoot, readProfiles, resolveProfile } from '../scripts/profile-routing.mjs';
import { acquireLock, atomicWriteJson, readJson } from './storage.js';
import { createOpenCodeNotifications } from './opencode-notifications.js';

const repository = fileURLToPath(new URL('..', import.meta.url));
const sessionPattern = /^ses_[A-Za-z0-9]{1,128}$/;
const messagePattern = /^msg_[A-Za-z0-9]{1,128}$/;
type Part = { type: string; text?: string; metadata?: Record<string, unknown>; [key: string]: unknown };
type Message = { id: string; sessionID: string; role: string; agent: string };
type NotificationOptions = Parameters<typeof createOpenCodeNotifications>[0];
type Context = {
  directory: string;
  client: NotificationOptions['client'] & {
    session: NotificationOptions['client']['session'] & {
      get: (input: { path: { id: string } }) => Promise<{ data?: { id: string; parentID?: string; directory?: string }; error?: unknown }>;
    };
  };
};
type Binding = { version: 1; sessionId: string; enabled: boolean; wallets: string[] };
type Hooks = {
  'command.execute.before': (input: { command: string; sessionID: string; arguments: string }, output: { parts: Part[] }) => Promise<void>;
  'chat.message': (input: { sessionID: string; messageID?: string }, output: { message: Message; parts: Part[] }) => Promise<void>;
  'shell.env': (input: { sessionID?: string }, output: { env: Record<string, string> }) => Promise<void>;
  'experimental.chat.system.transform': (input: { sessionID?: string }, output: { system: string[] }) => Promise<void>;
  event: (input: { event: { type: string; properties?: { info?: { id?: string }; sessionID?: string } } }) => Promise<void>;
  dispose: () => Promise<void>;
};
type Overrides = {
  repository?: string; rootDir?: string;
  launch?: (input: Record<string, unknown>, env: NodeJS.ProcessEnv) => Promise<unknown>;
  notify?: typeof createOpenCodeNotifications;
  watchConnection?: (rootDir: string, changed: () => void) => () => void;
  now?: () => number;
};
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const namespaced = (id: string) => `opencode:${id}`;
const inside = (root: string, path: string) => {
  const child = relative(root, path);
  return child !== '..' && !child.startsWith('../') && !isAbsolute(child);
};

/** The embedded OpenCode runtime is not Node. Always run the shared launcher
 * through the user's Node executable, with a fixed script and bounded JSON stdin. */
function launchInNode(root: string, input: Record<string, unknown>, env: NodeJS.ProcessEnv): Promise<unknown> {
  return new Promise((done, fail) => {
    const child = execFile('node', [resolve(root, 'scripts/rebalance-opencode-hook.mjs')], {
      cwd: root, env, timeout: 300_000, maxBuffer: 1_048_576, killSignal: 'SIGTERM', encoding: 'utf8',
    }, (error, stdout) => {
      if (error) { fail(new Error('The native launch result is unavailable; do not retry automatically.')); return; }
      try { done(JSON.parse(stdout)); } catch { fail(new Error('The native launch result could not be read.')); }
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(JSON.stringify(input));
  });
}

/** Loaded as a local OpenCode plugin. Import/loading never launches a wallet. */
export async function createRebalanceOpenCodePlugin(context: Context, overrides: Overrides = {}): Promise<Hooks> {
  const root = await realpath(overrides.repository ?? repository);
  const directory = await realpath(context.directory);
  if (!inside(root, directory)) throw new Error('Rebalance plugin must be loaded inside its repository.');
  const rootDir = resolve(overrides.rootDir ?? portfolioRoot(process.env, root));
  const now = overrides.now ?? Date.now;
  const notify = overrides.notify ?? createOpenCodeNotifications;
  let disposed = false;
  const markers = new Map<string, { sessionId: string; command: string; text: string; at: number }>();
  const active = new Map<string, { watchers: Map<string, Awaited<ReturnType<typeof createOpenCodeNotifications>>>; unwatch: () => void; refreshing?: Promise<void>; closed: boolean; dirty: boolean }>();
  const bindingPath = (id: string) => resolve(rootDir, 'opencode-sessions', `${hash(namespaced(id))}.json`);

  function environment(id: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, REBALANCE_ROOT_DIR: rootDir, REBALANCE_DATA_DIR: rootDir,
      REBALANCE_SESSION_ID: namespaced(id) };
    for (const name of ['REBALANCE_PROFILE_PINNED', 'REBALANCE_PROFILE_WALLET', 'REBALANCE_CHART_PORT', 'CODEX_THREAD_ID', 'CLAUDE_CODE_SESSION_ID']) delete env[name];
    return env;
  }
  async function verifiedSession(id: string): Promise<boolean> {
    const session = await context.client.session.get({ path: { id } });
    return !session.error && session.data?.id === id && !session.data.parentID &&
      typeof session.data.directory === 'string' && await realpath(session.data.directory) === directory;
  }
  async function readBinding(id: string): Promise<Binding | null> {
    const binding = await readJson<Binding>(bindingPath(id));
    if (!binding) return null;
    if (binding.version !== 1 || binding.sessionId !== namespaced(id) || typeof binding.enabled !== 'boolean' ||
        !Array.isArray(binding.wallets) || binding.wallets.length > 128 || new Set(binding.wallets).size !== binding.wallets.length ||
        binding.wallets.some(wallet => !/^0x[a-f0-9]{40}$/.test(wallet))) throw new Error('OpenCode notification preferences are invalid.');
    return binding;
  }
  async function updateBinding(id: string, edit: (value: Binding) => void): Promise<Binding> {
    const path = resolve(rootDir, 'opencode-sessions');
    const release = await acquireLock(path, `${hash(namespaced(id))}.lock`);
    try {
      const current = await readBinding(id) ?? { version: 1, sessionId: namespaced(id), enabled: true, wallets: [] };
      edit(current);
      await atomicWriteJson(bindingPath(id), current);
      return current;
    } finally { await release(); }
  }
  async function bindLaunchRoute(id: string, messageId: string) {
    // Use the request's immutable route, not a selection that may have changed
    // while startup was in flight. This also covers the sole-profile fallback.
    const requestId = hash(JSON.stringify([namespaced(id), messageId]));
    const route = await readJson<{ version?: number; requestId?: string; sessionId?: string;
      selectionRequired?: boolean; profile?: { wallet?: string; dataDir?: string; rootDir?: string; chartPort?: number } }>(
      resolve(rootDir, 'hook-routes', `${requestId}.json`));
    if (!route) return;
    if (route.version !== 1 || route.requestId !== requestId || route.sessionId !== namespaced(id)) throw new Error('Invalid launch route');
    if (route.selectionRequired === true || !route.profile?.wallet) return;
    const profile = (await readProfiles(rootDir)).find(entry => entry.wallet === route.profile!.wallet);
    if (!profile?.wallet || route.profile.rootDir !== rootDir || route.profile.dataDir !== profile.dataDir ||
        route.profile.chartPort !== profile.chartPort) throw new Error('Launch route no longer matches a registered wallet');
    const wallet = profile.wallet;
    await updateBinding(id, value => { if (!value.wallets.includes(wallet)) value.wallets.push(wallet); });
  }
  async function closeSession(id: string) {
    const record = active.get(id);
    if (!record) return;
    record.closed = true; record.unwatch(); active.delete(id);
    const closing = [...record.watchers.values()].map(watcher => watcher.close());
    await Promise.all([record.refreshing?.catch(() => {}), ...closing]);
  }
  async function refreshBindings(id: string) {
    const record = active.get(id);
    if (!record || record.closed || disposed) return;
    record.dirty = true;
    if (record.refreshing) return record.refreshing;
    const refresh = async () => {
      let binding = await readBinding(id);
      if (!binding || !binding.enabled || record.closed || disposed) return;
      // Selection changes are ordinary public local records. No model turn is
      // needed to synchronize the next CLI call or attach another event stream.
      const linked = await readJson<{ wallet?: string }>(connectionPath(rootDir, namespaced(id)));
      if (linked?.wallet) {
        const profile = await resolveProfile(rootDir, { sessionId: namespaced(id) });
        if (profile.wallet && !binding.wallets.includes(profile.wallet)) {
          binding = await updateBinding(id, value => { if (!value.wallets.includes(profile.wallet!)) value.wallets.push(profile.wallet!); });
        }
      }
      const profiles = await readProfiles(rootDir);
      for (const [wallet, watcher] of record.watchers) {
        if (!profiles.some(profile => profile.wallet === wallet)) { await watcher.close(); record.watchers.delete(wallet); }
      }
      for (const wallet of binding.wallets) {
        if (record.closed || disposed || !binding.enabled) break;
        if (record.watchers.has(wallet)) continue;
        const profile = profiles.find(candidate => candidate.wallet === wallet);
        if (!profile) continue;
        const watcher = await notify({ sessionId: id, projectDir: root, sessionDirectory: directory, rootDir, dataDir: profile.dataDir, wallet, client: context.client });
        if (record.closed || disposed) await watcher.close();
        else record.watchers.set(wallet, watcher);
      }
    };
    record.refreshing = (async () => {
      while (record.dirty && !record.closed && !disposed) { record.dirty = false; await refresh(); }
    })().finally(() => { record.refreshing = undefined; });
    return record.refreshing;
  }
  async function restoreSession(id: string) {
    if (disposed) return;
    const binding = await readBinding(id);
    if (!binding?.enabled) return;
    if (!await verifiedSession(id)) throw new Error('A matching root conversation is required.');
    if (active.has(id)) { await refreshBindings(id); return; }
    await mkdir(resolve(rootDir, 'connections'), { recursive: true, mode: 0o700 });
    if (disposed || active.has(id)) return;
    const changed = () => { void refreshBindings(id).catch(() => {}); };
    const unwatch = overrides.watchConnection ? overrides.watchConnection(rootDir, changed) : (() => {
      const expected = `${hash(namespaced(id))}.json`;
      let watcher: ReturnType<typeof watch> | undefined, timer: ReturnType<typeof setTimeout> | undefined;
      let stopped = false, delay = 1000;
      const retry = () => {
        watcher?.removeAllListeners(); watcher?.close(); watcher = undefined;
        if (!stopped && !timer) { timer = setTimeout(() => { timer = undefined; attach(); }, delay); delay = Math.min(delay * 2, 30_000); }
      };
      const attach = () => {
        if (stopped) return;
        try {
          watcher = watch(resolve(rootDir, 'connections'), (_event, filename) => {
            if (filename === null || filename === expected) { delay = 1000; changed(); }
          });
          watcher.on('error', retry); watcher.on('close', retry);
          changed(); // Catch changes missed during a failed watcher.
        } catch { retry(); }
      };
      attach();
      return () => { stopped = true; clearTimeout(timer); watcher?.removeAllListeners(); watcher?.close(); };
    })();
    active.set(id, { watchers: new Map(), unwatch, closed: false, dirty: false });
    await refreshBindings(id);
  }
  function report(output: { parts: Part[] }, part: Part, text: string) {
    part.text = text;
    delete part.metadata?.rebalanceInvocation;
  }
  const blocked = (message: string) => `Rebalance did not launch: ${message} Do not substitute a second launch command.`;

  return {
    async 'command.execute.before'(input, output) {
      if (disposed || input.command !== 'rebalance' || !sessionPattern.test(input.sessionID) || typeof input.arguments !== 'string') return;
      const command = input.arguments.trim();
      if (!['', 'notifications pause', 'notifications resume', 'notifications status'].includes(command)) return;
      // Commands with attachments/subtasks never acquire launch authority.
      if (output.parts.length !== 1 || output.parts[0]?.type !== 'text') return;
      for (const [key, entry] of markers) if (now() - entry.at > 120_000) markers.delete(key);
      if (markers.size >= 128) return;
      const token = randomUUID();
      const text = `Rebalance native command ${token}. Waiting for deterministic handling.`;
      markers.set(token, { sessionId: input.sessionID, command, text, at: now() });
      output.parts[0]!.text = text;
      output.parts[0]!.metadata = { ...output.parts[0]!.metadata, rebalanceInvocation: token };
    },
    async 'chat.message'(input, output) {
      if (disposed || !sessionPattern.test(input.sessionID)) return;
      const marked = output.parts.filter(part => typeof part.metadata?.rebalanceInvocation === 'string');
      if (!marked.length) {
        if (output.message.role === 'user' && output.message.sessionID === input.sessionID && messagePattern.test(output.message.id) &&
            (input.messageID === undefined || input.messageID === output.message.id)) {
          await restoreSession(input.sessionID).catch(() => {});
        }
        return;
      }
      const part = marked[0]!;
      const token = part.metadata!.rebalanceInvocation as string;
      const marker = markers.get(token);
      markers.delete(token);
      if (!marker || marked.length !== 1 || output.parts.length !== 1 || part.text !== marker.text ||
          marker.sessionId !== input.sessionID || now() - marker.at > 120_000 || output.message.role !== 'user' ||
          output.message.sessionID !== input.sessionID || !messagePattern.test(output.message.id) ||
          (input.messageID !== undefined && input.messageID !== output.message.id)) {
        report(output, part, blocked('The native command identity could not be verified.')); return;
      }
      try {
        if (!await verifiedSession(input.sessionID)) {
          report(output, part, blocked('A matching root conversation is required.')); return;
        }
        if (output.message.agent !== 'build') {
          report(output, part, blocked('Use OpenCode’s Build agent for the native command.')); return;
        }
        if (marker.command) {
          const action = marker.command.split(' ')[1];
          if (action === 'pause') { await updateBinding(input.sessionID, binding => { binding.enabled = false; }); await closeSession(input.sessionID); }
          if (action === 'resume') { await updateBinding(input.sessionID, binding => { binding.enabled = true; }); await restoreSession(input.sessionID); }
          const binding = await readBinding(input.sessionID);
          report(output, part, `Rebalance notifications are ${binding ? binding.enabled ? 'enabled' : 'paused' : 'not connected'} for this OpenCode conversation. This command did not change trading. Report this result once.`);
          return;
        }
        const native = { hook_event_name: 'OpenCodeCommand', command: 'rebalance', arguments: '', cwd: directory,
          session_id: input.sessionID, message_id: output.message.id, agent: output.message.agent,
          parent_session_id: null, direct_user_command: true };
        const result = await (overrides.launch ?? ((value, env) => launchInNode(root, value, env)))(native, environment(input.sessionID));
        const reply = result as { hookSpecificOutput?: { additionalContext?: unknown } } | null;
        if (typeof reply?.hookSpecificOutput?.additionalContext !== 'string') throw new Error('Invalid launch response');
        report(output, part, reply.hookSpecificOutput.additionalContext);
        // Explicit invocation connects notifications; a previously paused choice
        // remains paused. Plugin setup failures cannot reinterpret launch success.
        try { await updateBinding(input.sessionID, () => {}); await bindLaunchRoute(input.sessionID, output.message.id); await restoreSession(input.sessionID); await refreshBindings(input.sessionID); }
        catch { part.text += '\nOpenCode event delivery could not be connected; local events are retained.'; }
      } catch {
        report(output, part, 'Rebalance could not verify the native command result. Inspect status through the skill; do not repeat launch automatically. No completed trade is established.');
      }
    },
    async 'shell.env'(input, output) {
      if (disposed || !input.sessionID || !sessionPattern.test(input.sessionID)) return;
      Object.assign(output.env, { REBALANCE_SESSION_ID: namespaced(input.sessionID), REBALANCE_ROOT_DIR: rootDir,
        REBALANCE_DATA_DIR: rootDir, REBALANCE_PROFILE_PINNED: '', REBALANCE_PROFILE_WALLET: '', REBALANCE_CHART_PORT: '',
        CODEX_THREAD_ID: '', CLAUDE_CODE_SESSION_ID: '' });
    },
    async 'experimental.chat.system.transform'(input, output) {
      if (disposed || !input.sessionID || !sessionPattern.test(input.sessionID)) return;
      try {
        const wallet = (await resolveProfile(rootDir, { sessionId: namespaced(input.sessionID) })).wallet;
        output.system.push(`Rebalance conversation identity: ${namespaced(input.sessionID)}. ${wallet ? `The CLI currently resolves wallet ${wallet} for this conversation.` : 'No wallet is selected for this conversation.'} Run the Rebalance CLI in this project; its session environment follows this selection. Do not infer a wallet from a different chat or old screenshot. Read skills/rebalance/SKILL.md for requested operations.`);
      } catch { output.system.push('Rebalance conversation selection is unavailable. Read status before any wallet operation; do not guess a wallet.'); }
    },
    async event({ event }) {
      if (event.type === 'session.deleted') {
        const id = event.properties?.info?.id;
        if (id && sessionPattern.test(id)) await closeSession(id);
      }
    },
    async dispose() {
      disposed = true; markers.clear();
      await Promise.all([...active.keys()].map(closeSession));
    },
  };
}
