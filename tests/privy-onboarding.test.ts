import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { setupPrivyWallet, type PrivyOnboardingDependencies } from '../src/privy-onboarding.js';
import type { PrivyWallet } from '../src/privy.js';
import type { WalletSetupContext, WalletSetupProgress } from '../src/wallet-setup-types.js';

const wallet: PrivyWallet = { provider: 'privy', address: `0x${'1'.repeat(40)}`, walletId: 'public-id', session: 'cached', networkVerified: false };
const url = 'https://agents.privy.io/?user_code=ABC12-XYZ34';
const transcript = `\nOpen this URL to authorize:\n\n  ${url}\n\nYour code: ABC12-XYZ34\n\nWaiting for approval...\n`;
function deferred<T = void>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
class FakeClock {
  now = 0; next = 0;
  jobs = new Map<number, { at: number; callback: () => void }>();
  set = (callback: () => void, ms: number) => {
    const id = ++this.next; this.jobs.set(id, { at: this.now + ms, callback });
    return id as unknown as ReturnType<typeof setTimeout>;
  };
  clear = (id: ReturnType<typeof setTimeout>) => { this.jobs.delete(id as unknown as number); };
  advance(ms: number) {
    const until = this.now + ms;
    for (;;) {
      const entry = [...this.jobs].filter(([, job]) => job.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!entry) break;
      this.now = entry[1].at; this.jobs.delete(entry[0]); entry[1].callback();
    }
    this.now = until;
  }
}
class FakeChild extends EventEmitter {
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough();
  signals: string[] = []; ignoreKill = false; closed = false;
  kill(signal: string) {
    this.signals.push(signal);
    if (!this.ignoreKill) this.close(null);
    return true;
  }
  close(code: number | null) { if (!this.closed) { this.closed = true; this.emit('close', code); } }
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'rebalance-privy-approval-'));
  const lockPath = join(directory, 'user-runtime', 'privy-login.lock');
  const clock = new FakeClock(), child = new FakeChild(), controller = new AbortController();
  const spawned = deferred(), shown = deferred();
  let cached = false, reads = 0;
  const calls: { command: string; args: readonly string[]; options: Record<string, unknown> }[] = [];
  const progress: WalletSetupProgress[] = [];
  const context: WalletSetupContext = { rootDir: join(directory, 'portfolio-A'), requestKey: 'fixture', signal: controller.signal,
    onProgress: async value => { progress.push(value); if (value.state === 'awaiting-approval') shown.resolve(); } };
  const deps: Partial<PrivyOnboardingDependencies> = {
    lockPath, setTimer: clock.set, clearTimer: clock.clear,
    readWallet: async () => { reads++; if (!cached) throw new Error('PRIVATE upstream failure'); return wallet; },
    spawn: ((command: string, args: readonly string[], options: Record<string, unknown>) => {
      calls.push({ command, args, options }); spawned.resolve(); return child;
    }) as unknown as PrivyOnboardingDependencies['spawn'],
  };
  return { directory, lockPath, clock, child, controller, spawned, shown, calls, progress, context, deps,
    cache: () => { cached = true; }, reads: () => reads,
    close: () => rm(directory, { recursive: true, force: true }),
    begin: (extra: Partial<PrivyOnboardingDependencies> = {}) => setupPrivyWallet(context, { ...deps, ...extra }),
  };
}
const sanitized = (error: unknown) => error instanceof Error && !/PRIVATE|secret|access_token|refresh_token/.test(error.message);

test('cached public wallet is reused without login, lock creation, or authorization claims', async () => {
  const f = await fixture();
  try {
    f.cache();
    assert.deepEqual(await f.begin(), { address: wallet.address, reused: true });
    assert.equal(f.reads(), 1); assert.equal(f.calls.length, 0); assert.deepEqual(f.progress, []);
    assert.equal(existsSync(f.lockPath), false);
  } finally { await f.close(); }
});

test('rechecks cached wallet after acquiring the global lock before any browser opening', async () => {
  const f = await fixture();
  try {
    let reads = 0;
    assert.deepEqual(await f.begin({ readWallet: async () => { if (++reads === 1) throw new Error(); return wallet; } }),
      { address: wallet.address, reused: true });
    assert.equal(f.calls.length, 0); assert.equal(existsSync(f.lockPath), false);
  } finally { await f.close(); }
});

test('pinned native subprocess captures only approved display fields and waits for durable progress', async () => {
  const f = await fixture(), gate = deferred();
  try {
    f.context.onProgress = async value => {
      f.progress.push(value);
      if (value.state === 'awaiting-approval') { f.shown.resolve(); await gate.promise; }
    };
    const result = f.begin(); await f.spawned.promise;
    const call = f.calls[0]!;
    assert.equal(call.command, process.execPath);
    assert.match(call.args[0]!, /@privy-io\/agent-wallet-cli\/dist\/index\.js$/);
    assert.deepEqual(call.args.slice(1), ['login']);
    assert.equal(call.options.shell, false); assert.equal(call.options.stdio, 'pipe');
    assert.equal(call.options.windowsHide, true); assert.equal(f.child.stdin.writableEnded, true);
    const env = call.options.env as NodeJS.ProcessEnv;
    assert.equal(env.PRIVY_AGENT_URL, undefined); assert.equal(env.PRIVY_API_BASE_URL, undefined); assert.equal(env.PRIVY_APP_ID, undefined);
    for (const chunk of [transcript.slice(0, 35), transcript.slice(35, 87), transcript.slice(87)]) f.child.stdout.write(chunk);
    f.child.stderr.write('PRIVATE access_token=secret');
    await f.shown.promise;
    f.cache(); f.child.stdout.write('Logged in successfully.\nethereum: public-address\n'); f.child.close(0);
    assert.equal(f.reads(), 2, 'success must wait for approval progress persistence');
    assert.equal(existsSync(f.lockPath), true);
    gate.resolve();
    assert.deepEqual(await result, { address: wallet.address, reused: false });
    assert.deepEqual(f.progress, [
      { state: 'preparing', message: 'Starting Privy browser approval.' },
      { state: 'awaiting-approval', message: 'Approve Privy access in the browser and verify the displayed code.', approval: { url, code: 'ABC12-XYZ34' } },
    ]);
    assert.equal(f.reads(), 3); assert.equal(existsSync(f.lockPath), false); assert.equal(f.clock.jobs.size, 0);
  } finally { await f.close(); }
});

test('different portfolio roots cannot run concurrent logins for the same OS-user session', async () => {
  const f = await fixture();
  try {
    const first = f.begin(); await f.spawned.promise;
    assert.deepEqual(Object.keys(JSON.parse(await readFile(f.lockPath, 'utf8'))).sort(), ['pid', 'token']);
    await assert.rejects(setupPrivyWallet({ ...f.context, rootDir: '/different/portfolio', requestKey: 'other' }, f.deps), /local login lock/);
    assert.equal(f.calls.length, 1);
    f.controller.abort(); await assert.rejects(first, /cancelled/);
    assert.equal(existsSync(f.lockPath), false);
  } finally { await f.close(); }
});

for (const bad of [
  'https://agents.privy.io.attacker.invalid/?user_code=ABC12-XYZ34',
  'http://agents.privy.io/?user_code=ABC12-XYZ34',
  'https://name:secret@agents.privy.io/?user_code=ABC12-XYZ34',
  'https://agents.privy.io:8443/?user_code=ABC12-XYZ34',
  'https://agents.privy.io/other?user_code=ABC12-XYZ34',
  'https://agents.privy.io/?user_code=WRONG-CODE',
  'https://agents.privy.io/?user_code=ABC12-XYZ34&access_token=secret',
  'https://agents.privy.io/?user_code=ABC12-XYZ34&user_code=ABC12-XYZ34',
  'https://agents.privy.io/?user_code=ABC12-XYZ34#secret',
]) test(`unapproved URL never reaches UI: ${bad.replace(/secret/g, '[fixture]')}`, async () => {
  const f = await fixture();
  try {
    const result = f.begin(); await f.spawned.promise;
    f.child.stdout.write(transcript.replace(url, bad)); f.child.close(0);
    await assert.rejects(result, sanitized);
    assert.equal(f.progress.some(value => value.approval), false);
    assert.equal(existsSync(f.lockPath), false);
  } finally { await f.close(); }
});

test('preparing persistence failure fails closed before spawning any CLI', async () => {
  const f = await fixture();
  try {
    f.context.onProgress = async () => { throw new Error('PRIVATE database error'); };
    await assert.rejects(f.begin(), sanitized);
    assert.equal(f.calls.length, 0); assert.equal(existsSync(f.lockPath), false);
  } finally { await f.close(); }
});

test('approval persistence failure terminates the child and never adopts the wallet', async () => {
  const f = await fixture();
  try {
    f.context.onProgress = async value => { if (value.approval) throw new Error('PRIVATE database error'); };
    const result = f.begin(); await f.spawned.promise;
    f.child.stdout.write(transcript);
    await assert.rejects(result, sanitized);
    assert.deepEqual(f.child.signals, ['SIGKILL']); assert.equal(f.reads(), 2);
    assert.equal(existsSync(f.lockPath), false); assert.equal(f.clock.jobs.size, 0);
  } finally { await f.close(); }
});

test('abort while awaiting persisted approval prevents adoption even after successful CLI close', async () => {
  const f = await fixture(), gate = deferred();
  try {
    f.context.onProgress = async value => { if (value.approval) { f.shown.resolve(); await gate.promise; } };
    const result = f.begin(); await f.spawned.promise;
    f.child.stdout.write(transcript); await f.shown.promise;
    f.cache(); f.child.close(0); f.controller.abort();
    await assert.rejects(result, /cancelled/); gate.resolve();
    assert.equal(f.reads(), 2); assert.equal(existsSync(f.lockPath), false);
  } finally { await f.close(); }
});

test('already-aborted setup neither reads cached session metadata nor launches a subprocess', async () => {
  const f = await fixture();
  try {
    f.controller.abort(); await assert.rejects(f.begin(), /cancelled/);
    assert.equal(f.reads(), 0); assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test('fixed approval deadline kills the child; output does not extend it', async () => {
  const f = await fixture();
  try {
    const result = f.begin(); await f.spawned.promise;
    f.clock.advance(598_999); f.child.stdout.write(transcript); await f.shown.promise;
    assert.deepEqual(f.child.signals, []);
    f.clock.advance(1); await assert.rejects(result, sanitized);
    assert.deepEqual(f.child.signals, ['SIGKILL']); assert.equal(f.clock.jobs.size, 0);
    assert.equal(existsSync(f.lockPath), false);
  } finally { await f.close(); }
});

test('unconfirmed child termination retains a durable global barrier after bounded kill wait', async () => {
  const f = await fixture();
  try {
    f.child.ignoreKill = true;
    const result = f.begin(); await f.spawned.promise;
    f.controller.abort(); f.clock.advance(1_000);
    await assert.rejects(result, /cancelled/);
    assert.deepEqual(f.child.signals, ['SIGKILL']); assert.equal(existsSync(f.lockPath), true);
    await assert.rejects(setupPrivyWallet({ ...f.context, signal: new AbortController().signal }, f.deps), /local login lock/);
    assert.equal(f.calls.length, 1); assert.equal(f.clock.jobs.size, 0);
    f.child.close(null);
    assert.equal(existsSync(f.lockPath), true, 'late close does not erase an unresolved durable lock');
  } finally { await f.close(); }
});

for (const stream of ['stdout', 'stderr'] as const) test(`${stream} has a bounded discarded buffer and sanitized overflow error`, async () => {
  const f = await fixture();
  try {
    const result = f.begin(); await f.spawned.promise;
    f.child[stream].write(`PRIVATE${'x'.repeat(65_536)}`);
    await assert.rejects(result, sanitized);
    assert.deepEqual(f.child.signals, ['SIGKILL']); assert.equal(f.reads(), 2);
    assert.equal(existsSync(f.lockPath), false);
  } finally { await f.close(); }
});

test('native failures preserve cached session and never issue logout or any RPC', async () => {
  const f = await fixture();
  try {
    const result = f.begin(); await f.spawned.promise;
    f.child.stderr.write('Already logged in. Run logout first. PRIVATE refresh_token=secret');
    f.child.close(1);
    await assert.rejects(result, sanitized);
    assert.deepEqual(f.calls.map(call => call.args.slice(1)), [['login']]);
    assert.equal(f.reads(), 2); assert.equal(existsSync(f.lockPath), false);
  } finally { await f.close(); }
});

test('successful exit without verified approval output or public wallet fails closed', async () => {
  for (const show of [false, true]) {
    const f = await fixture();
    try {
      const result = f.begin(); await f.spawned.promise;
      if (show) { f.child.stdout.write(transcript); await f.shown.promise; }
      f.child.close(0);
      await assert.rejects(result, sanitized);
      assert.equal(existsSync(f.lockPath), false);
    } finally { await f.close(); }
  }
});

test('spawn exceptions and invalid deadline overrides do not leak native errors', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.begin({ spawn: (() => { throw new Error('PRIVATE spawn environment'); }) as PrivyOnboardingDependencies['spawn'] }), sanitized);
    assert.equal(existsSync(f.lockPath), false);
    await assert.rejects(f.begin({ timeoutMs: 600_000 }), sanitized);
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});
