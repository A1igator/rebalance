import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { privyWallet, type PrivyWallet } from './privy.js';
import type { SetupWallet, WalletSetupContext } from './wallet-setup-types.js';

const FAILURE = 'Privy approval did not complete. The existing session was preserved; retry setup or review authorization through the agent.';
const CANCELLED = 'Privy setup was cancelled.';
const BUSY = 'Another Privy setup holds the local login lock. Finish that approval first; an interrupted login requires inspection before retrying.';
const APPROVAL_TIMEOUT = 599_000;
const KILL_WAIT = 1_000;
const OUTPUT_LIMIT = 65_536;

type Timer = ReturnType<typeof setTimeout>;
export type PrivyOnboardingDependencies = {
  readWallet: () => Promise<PrivyWallet>;
  spawn: typeof spawn;
  cliPath: () => string;
  lockPath: string;
  timeoutMs: number;
  setTimer: (callback: () => void, ms: number) => Timer;
  clearTimer: (timer: Timer) => void;
};
const defaults: PrivyOnboardingDependencies = {
  readWallet: privyWallet,
  spawn,
  cliPath: () => {
    const require = createRequire(import.meta.url);
    if (require('@privy-io/agent-wallet-cli/package.json').version !== '0.3.6') throw new Error(FAILURE);
    return require.resolve('@privy-io/agent-wallet-cli');
  },
  // One CLI session belongs to the OS user, so this lock is independent of portfolio roots.
  // No credential directory is read. Interrupted locks are retained rather than risking
  // a second login while an orphaned first CLI still polls and may save its session.
  lockPath: join(homedir(), '.cache', 'rebalance', 'privy-login.lock'),
  timeoutMs: APPROVAL_TIMEOUT,
  setTimer: (callback, ms) => setTimeout(callback, ms),
  clearTimer: timer => clearTimeout(timer),
};

async function lockLogin(path: string): Promise<() => Promise<void>> {
  const token = randomUUID();
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const handle = await open(path, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify({ pid: process.pid, token })); await handle.sync(); }
    finally { await handle.close(); }
  } catch { throw new Error(BUSY); }
  return async () => {
    try {
      const record = JSON.parse(await readFile(path, 'utf8'));
      if (record.token === token) await unlink(path);
    } catch { throw new Error(BUSY); }
  };
}

function checkSignal(signal: AbortSignal): void {
  if (signal.aborted) throw new Error(CANCELLED);
}

// Official skill: https://agents.privy.io/skill.md. Pinned CLI 0.3.6 defaults to
// this browser origin and prints verification_uri_complete + user_code separately.
// Only these display fields cross into the UI; device codes and tokens never do.
function approval(urlText: string, code: string): { url: string; code: string } {
  try {
    const url = new URL(urlText);
    if (!/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(code) || code.length < 4 || code.length > 32 ||
        urlText.length > 512 || url.origin !== 'https://agents.privy.io' || url.username || url.password ||
        url.hash || url.pathname !== '/' || [...url.searchParams.keys()].length !== 1 ||
        url.searchParams.get('user_code') !== code) throw new Error();
    return { url: url.toString(), code };
  } catch { throw new Error(FAILURE); }
}

class LoginFailure extends Error {
  constructor(message: string, readonly mayStillRun = false) { super(message); }
}

async function runLogin(context: WalletSetupContext, deps: PrivyOnboardingDependencies): Promise<void> {
  checkSignal(context.signal);
  let child: ChildProcessWithoutNullStreams;
  try {
    const env = { ...process.env };
    // This UI flow targets the owner-selected official agent sandbox. Preserve
    // the CLI's own browser opening, but do not inherit alternate Privy endpoints.
    delete env.PRIVY_AGENT_URL; delete env.PRIVY_API_BASE_URL; delete env.PRIVY_APP_ID;
    child = deps.spawn(process.execPath, [deps.cliPath(), 'login'], {
      stdio: 'pipe', shell: false, windowsHide: true, env,
    }) as ChildProcessWithoutNullStreams;
  } catch { throw new Error(FAILURE); }

  await new Promise<void>((resolve, reject) => {
    let settled = false, closed = false, exitCode: number | null = null;
    let failure: string | undefined, progressStarted = false, progressDone = false;
    let outputBytes = 0, errorBytes = 0, pending = '', urlText: string | undefined, code: string | undefined;
    let killTimer: Timer | undefined;
    const timer = deps.setTimer(() => fail(FAILURE), deps.timeoutMs);
    const cleanup = () => {
      deps.clearTimer(timer);
      if (killTimer !== undefined) deps.clearTimer(killTimer);
      context.signal.removeEventListener('abort', abort);
      pending = ''; urlText = undefined; code = undefined;
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true; cleanup();
      if (error) reject(error); else resolve();
    };
    const complete = () => {
      if (!closed || settled) return;
      if (failure) finish(new LoginFailure(failure));
      else if (exitCode !== 0 || !progressStarted) finish(new LoginFailure(FAILURE));
      else if (progressDone) finish();
    };
    const fail = (message: string) => {
      if (settled || failure) return;
      failure = message;
      if (closed) { complete(); return; }
      // Do not release the global lock until close confirms process termination.
      // If the OS never confirms it, retain the lock until the original process can be inspected.
      try { child.kill('SIGKILL'); } catch { /* Retain the lock if termination stays unknown. */ }
      if (!closed) killTimer = deps.setTimer(() => finish(new LoginFailure(message, true)), KILL_WAIT);
    };
    const abort = () => fail(CANCELLED);
    const publish = () => {
      if (progressStarted || !urlText || !code || failure || settled) return;
      let fields: { url: string; code: string };
      try { fields = approval(urlText, code); } catch { fail(FAILURE); return; }
      progressStarted = true;
      Promise.resolve().then(async () => {
        checkSignal(context.signal);
        await context.onProgress({ state: 'awaiting-approval',
          message: 'Approve Privy access in the browser and verify the displayed code.', approval: fields });
        checkSignal(context.signal);
      }).then(() => { progressDone = true; complete(); }, () => fail(context.signal.aborted ? CANCELLED : FAILURE));
    };
    const line = (value: string) => {
      const trimmed = value.trim();
      if (trimmed.startsWith('https://')) {
        if (urlText && urlText !== trimmed) { fail(FAILURE); return; }
        urlText = trimmed;
      } else if (trimmed.startsWith('Your code: ')) {
        const next = trimmed.slice('Your code: '.length);
        if (code && code !== next) { fail(FAILURE); return; }
        code = next;
      }
      publish();
    };
    child.stdout.on('data', (chunk: Buffer | string) => {
      if (settled || failure) return;
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > OUTPUT_LIMIT) { fail(FAILURE); return; }
      pending += chunk.toString();
      let index: number;
      while ((index = pending.indexOf('\n')) >= 0 && !failure) {
        const next = pending.slice(0, index); pending = pending.slice(index + 1); line(next);
      }
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      errorBytes += Buffer.byteLength(chunk);
      if (errorBytes > OUTPUT_LIMIT) fail(FAILURE);
      // Never retain or return native errors, which can contain upstream bodies.
    });
    child.stdin.on('error', () => fail(FAILURE));
    child.stdout.on('error', () => fail(FAILURE));
    child.stderr.on('error', () => fail(FAILURE));
    child.once('error', () => fail(FAILURE));
    child.once('close', (status: number | null) => {
      closed = true; exitCode = status;
      if (pending && !failure) line(pending);
      complete();
    });
    context.signal.addEventListener('abort', abort, { once: true });
    child.stdin.end();
    if (context.signal.aborted) abort();
  });
}

/** Official CLI owns browser approval and credentials. This adapter never signs or logs out. */
export async function setupPrivyWallet(context: WalletSetupContext,
  overrides: Partial<PrivyOnboardingDependencies> = {}): Promise<SetupWallet> {
  const deps = { ...defaults, ...overrides };
  if (!Number.isSafeInteger(deps.timeoutMs) || deps.timeoutMs < 1 || deps.timeoutMs > APPROVAL_TIMEOUT) throw new Error(FAILURE);
  checkSignal(context.signal);
  try {
    const wallet = await deps.readWallet(); checkSignal(context.signal);
    return { address: wallet.address, reused: true };
  } catch { checkSignal(context.signal); }
  const release = await lockLogin(deps.lockPath);
  let safeToRelease = true;
  try {
    checkSignal(context.signal);
    // A different setup may have completed while the first cached read was pending.
    try {
      const wallet = await deps.readWallet(); checkSignal(context.signal);
      return { address: wallet.address, reused: true };
    } catch { checkSignal(context.signal); }
    await context.onProgress({ state: 'preparing', message: 'Starting Privy browser approval.' });
    checkSignal(context.signal);
    await runLogin(context, deps);
    checkSignal(context.signal);
    const wallet = await deps.readWallet();
    checkSignal(context.signal);
    return { address: wallet.address, reused: false };
  } catch (error) {
    if (error instanceof LoginFailure && error.mayStillRun) safeToRelease = false;
    throw new Error(context.signal.aborted ? CANCELLED : FAILURE);
  } finally {
    if (safeToRelease) await release();
  }
}
