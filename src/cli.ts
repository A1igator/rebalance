import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { open, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { type Hex } from 'viem';
import { ASSETS } from './assets.js';
import { createChain, ROBINHOOD } from './chain.js';
import { CONFIG_PATH, DATA, PENDING_PATH, createWallet, loadConfig, parseTargets, percentToBps, validateConfig, type Config } from './config.js';
import { redistributeTargets } from './core.js';
import { GRAPH } from './graph.js';
import { events, acknowledgeEvent, publishEvent } from './events.js';
import { STOP_PATH, monitor, status, tick } from './runtime.js';
import { serve } from './server.js';
import { acquireLock, atomicWriteJson, readJson, stringifyJson, type PendingTransaction } from './storage.js';
import { validatePending } from './transactions.js';
import { launch } from './launch.js';
import { recover } from './recovery.js';
import { configureCodexNotifications, codexNotificationStatus, prepareCodexNotifications,
  runCodexNotifications, stopCodexNotifications } from './codex-notifications.js';

const HELP = `Rebalance — agent commands, Robinhood mainnet 4663
  wallet create                        Create/reuse a local wallet; public address only
  status                               Read local graph/portfolio state
  configure --targets USDG=5,AAPL=23.75,NVDA=23.75,MSFT=23.75,AMD=23.75
                                       Set explicit percentages (example only)
    [--wallet 0x...] [--mode private-key|privy|ledger] [--rpc https://...]
    [--threshold 5] [--slippage 0.5] [--poll 30] [--rebalance-interval-seconds 3600]
  targets set AAPL 30                   Change one percentage; redistribute the rest
  targets replace <ASSET=percent,...>   Replace all five targets explicitly
  check                                Fresh read/plan/quote; never sign
  launch [--setup-only]                 Prepare/reuse chart and arm/reuse the runner
    [--targets <ASSET=percent,...>]      Initial allocation only; preserve saved targets
  recover                              Read-only assessment of a pending transaction
  recover --cancel                     Explicit same-nonce self-cancellation and verified recovery
  start [--background]                 Arm deterministic automatic rebalancing
  stop                                 Stop before the next dispatch
  chart [--background]                 Serve the read-only chart at 127.0.0.1:4663
  acknowledge-revert                   Unblock only a mined, reverted transaction
  graph                                Print the app graph edges
  events                               Read retained notification events
  events ack <id>                      Mark an event handled in the agent session
  notifications configure --thread <id> [--codex <executable>]
                                       Bind notification delivery to the existing Codex conversation
  notifications start [--background]   Enable/reuse the notification-only listener
  notifications status                 Read listener preference and delivery state
  notifications test                   Publish a connection test; never perform trading
  notifications stop                   Pause notification delivery; leave trading unchanged
Native ETH is gas-only; select USDG + four stocks from the verified manifest.
Supported stocks: ${Object.keys(ASSETS).filter(id => id !== 'USDG').join(', ')}.
Privy and Ledger execution are deferred. Never pass a private key as a CLI argument.
`;

const { values, positionals: args } = parseArgs({ allowPositionals: true, options: {
  background: { type: 'boolean', default: false }, targets: { type: 'string' }, wallet: { type: 'string' },
  mode: { type: 'string' }, rpc: { type: 'string' }, threshold: { type: 'string' },
  slippage: { type: 'string' }, poll: { type: 'string' }, help: { type: 'boolean' },
  'rebalance-interval-seconds': { type: 'string' },
  'resume-start': { type: 'boolean', default: false },
  'setup-only': { type: 'boolean', default: false }, 'request-id': { type: 'string' },
  'expected-stop': { type: 'string' },
  cancel: { type: 'boolean', default: false },
  thread: { type: 'string' }, codex: { type: 'string' },
  'enabled-only': { type: 'boolean', default: false }, 'notification-token': { type: 'string' },
} });
const print = (value: unknown) => process.stdout.write(stringifyJson(value));
const requiredConfig = async () => { const c = await loadConfig(); if (!c) throw new Error('Configure explicit targets through the agent first'); return c; };

async function inLock<T>(name: string, action: () => Promise<T>): Promise<T> {
  const release = await acquireLock(DATA, name);
  try { return await action(); } finally { await release(); }
}

// Stop and the start command's older-stop removal must be ordered. In
// particular, a slow launch must not erase a newer user stop during setup.
async function control<T>(action: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    let release: (() => Promise<void>) | undefined;
    try { release = await acquireLock(DATA, 'control.lock'); }
    catch (error) {
      if (attempt >= 99 || !(error instanceof Error) || !/^Lock control\.lock is held/.test(error.message)) throw error;
      await delay(20); continue;
    }
    try { return await action(); } finally { await release(); }
  }
}

async function clearOlderStop() {
  await control(async () => {
    const stop = await readJson(STOP_PATH);
    const token = stop === null ? 'none' : createHash('sha256').update(JSON.stringify(stop)).digest('hex');
    if (values['expected-stop'] !== undefined && values['expected-stop'] !== token) {
      throw new Error('A newer stop arrived during launch; no runner was started and the stop was preserved');
    }
    await rm(STOP_PATH, { force: true });
  });
}

async function background(command: string): Promise<void> {
  await mkdir(DATA, { recursive: true, mode: 0o700 });
  const log = await open(resolve(DATA, `${command}.log`), 'a', 0o600);
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), command,
    ...(command === 'start' ? ['--resume-start'] : [])], {
    cwd: process.cwd(), detached: true, stdio: ['ignore', log.fd, log.fd], env: process.env,
  });
  child.unref();
  await log.close();
  print({ status: 'starting', command, pid: child.pid, log: `.local/${command}.log` });
}

function notificationPidAlive(value: unknown): value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) return false;
  try { process.kill(value, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true;
    throw error;
  }
}

async function notificationWorker(token: string) {
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try { await runCodexNotifications({ token, signal: abort.signal }); }
  finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}

async function notificationStart() {
  let release: (() => Promise<void>) | undefined;
  try { release = await acquireLock(DATA, 'codex-notifications-launch.lock'); }
  catch (error) {
    if (!(error instanceof Error) || !/^Lock codex-notifications-launch\.lock is held/.test(error.message)) throw error;
    print({ ...await codexNotificationStatus(), state: 'starting', message: 'Another notification launch is in progress; no second worker was started.' });
    return;
  }
  let foregroundToken: string | null = null;
  try {
    const prepared = await prepareCodexNotifications({ restoreOnly: values['enabled-only'] });
    if (!prepared.token || !prepared.status.enabled || prepared.status.running) {
      print({ ...prepared.status, state: !prepared.status.configured ? 'unconfigured' : !prepared.status.enabled
        ? (prepared.status.running ? 'stopping' : 'paused') : 'running' });
      return;
    }
    const recordPath = resolve(DATA, 'codex-notifications-process.json');
    const previous = await readJson<{ pid: number; token: string }>(recordPath);
    if (previous && notificationPidAlive(previous.pid)) {
      print({ ...prepared.status, state: 'starting', pid: previous.pid,
        message: 'An existing notification worker is starting or stopping; it was not duplicated.' });
      return;
    }
    if (!values.background) {
      foregroundToken = prepared.token;
      await atomicWriteJson(recordPath, { pid: process.pid, token: prepared.token });
    }
    else {
      const log = await open(resolve(DATA, 'codex-notifications.log'), 'a', 0o600);
      try {
        const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url),
          'notifications', 'run', '--notification-token', prepared.token], {
          cwd: process.cwd(), detached: true, stdio: ['ignore', log.fd, log.fd], env: process.env,
        });
        await new Promise<void>((resolveStarted, reject) => { child.once('spawn', resolveStarted); child.once('error', reject); });
        child.unref();
        await atomicWriteJson(recordPath, { pid: child.pid, token: prepared.token });
        // A spawn is not readiness. Observe only this notifier's own public state.
        let current = await codexNotificationStatus();
        for (let attempt = 0; attempt < 20 && current.enabled && !current.running && notificationPidAlive(child.pid); attempt++) {
          await delay(50); current = await codexNotificationStatus();
        }
        print({ ...current, pid: child.pid, state: !current.enabled ? 'paused' : current.running ? 'running'
          : notificationPidAlive(child.pid) ? 'starting' : 'unavailable' });
      } finally { await log.close(); }
    }
  } finally { await release(); }
  if (foregroundToken) await notificationWorker(foregroundToken);
}

async function notificationCommand() {
  if (args.length !== 2 || !['configure', 'start', 'run', 'status', 'stop', 'test'].includes(args[1]!)) {
    throw new Error('Use notifications configure, start, status, test or stop');
  }
  for (const key of ['targets', 'wallet', 'mode', 'rpc', 'threshold', 'slippage', 'poll', 'rebalance-interval-seconds'] as const) {
    if (values[key] !== undefined) throw new Error('Portfolio options do not apply to notifications');
  }
  const action = args[1];
  if (values.background && action !== 'start') throw new Error('--background applies only to notifications start');
  if (values['enabled-only'] && action !== 'start') throw new Error('--enabled-only applies only to notifications start');
  if ((values.thread !== undefined || values.codex !== undefined) && action !== 'configure') {
    throw new Error('Notification binding options apply only to notifications configure');
  }
  if (values['notification-token'] !== undefined && action !== 'run') throw new Error('Notification continuation token applies only to its worker');
  if (action === 'configure') {
    if (!values.thread) throw new Error('Specify the existing conversation --thread');
    print(await configureCodexNotifications({ threadId: values.thread, command: values.codex }));
  } else if (action === 'status') print(await codexNotificationStatus());
  else if (action === 'stop') {
    await stopCodexNotifications();
    const current = await codexNotificationStatus();
    print({ ...current, state: current.running ? 'stopping' : 'paused' });
  } else if (action === 'test') {
    const current = await codexNotificationStatus();
    if (!current.configured || !current.enabled || !current.running) {
      throw new Error('Start a configured notification listener before publishing a connection test');
    }
    const id = `notification-test-${randomUUID()}`;
    await publishEvent({ id, type: 'notification-test', createdAt: new Date().toISOString(),
      message: 'Rebalance notification connection test; no trading action or financial outcome.' });
    print({ eventId: id, status: 'published',
      message: 'Connection test retained locally; agent acknowledgement and phone delivery are not yet verified.' });
  } else if (action === 'start') await notificationStart();
  else {
    const token = values['notification-token'];
    if (!token || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(token)) throw new Error('Invalid notification worker continuation token');
    await notificationWorker(token);
  }
}

async function main() {
  const command = args[0];
  if (!command || command === 'help' || values.help) { process.stdout.write(HELP); return; }
  if (values['resume-start'] && (command !== 'start' || values.background)) throw new Error('Invalid background-start continuation');
  if (values['setup-only'] && command !== 'launch') throw new Error('--setup-only applies only to launch');
  if (values['request-id'] !== undefined && !['launch', 'recover'].includes(command)) throw new Error('--request-id applies only to launch or recover');
  if (values.cancel && command !== 'recover') throw new Error('--cancel applies only to recover');
  if (values['expected-stop'] !== undefined && (!['start', 'launch', 'recover'].includes(command) || values['resume-start'] ||
      !/^(none|[a-f0-9]{64})$/.test(values['expected-stop']))) throw new Error('Invalid conditional-start token');
  if (command !== 'notifications' && (values.thread !== undefined || values.codex !== undefined ||
      values['notification-token'] !== undefined || values['enabled-only'])) throw new Error('Notification options apply only to notifications');
  if (command === 'notifications') { await notificationCommand(); return; }
  if (values.background) {
    if (!['start', 'chart'].includes(command)) throw new Error('--background applies only to start or chart');
    if (command === 'start') {
      await requiredConfig();
      // Do not clear a stop belonging to an existing runner. Clear the older
      // request before spawning; the child preserves any subsequently issued stop.
      await inLock('run.lock', clearOlderStop);
    }
    await background(command); return;
  }
  switch (command) {
    case 'wallet':
      if (args[1] !== 'create') throw new Error('Use wallet create');
      print(await createWallet()); return;
    case 'status': print(await status()); return;
    case 'launch': {
      const result = await launch({ setupOnly: values['setup-only'], targets: values.targets,
        requestId: values['request-id'], expectedStop: values['expected-stop'] });
      print(result);
      if (result.outcome === 'blocked') process.exitCode = 1;
      return;
    }
    case 'recover': {
      const result = await recover({ cancel: values.cancel, requestId: values['request-id'], expectedStop: values['expected-stop'] });
      print(result);
      if (result.outcome === 'blocked') process.exitCode = 1;
      return;
    }
    case 'graph': print({ interface: 'one existing agent conversation', edges: GRAPH, state: (await status()).graph }); return;
    case 'events':
      if (args[1] === 'ack' && args[2]) { await acknowledgeEvent(args[2]); print({ acknowledged: args[2] }); }
      else print(await events());
      return;
    case 'configure':
      await inLock('config.lock', async () => {
        if (await readJson(PENDING_PATH)) throw new Error('Reconcile the pending operation before changing wallet or configuration');
        const previous = await loadConfig();
        const wallet = await readJson<{ address: string }>(resolve(DATA, 'wallet.json'));
        if (!values.targets && !previous) throw new Error('Specify the target percentages');
        const config = validateConfig({ version: 1, chainId: 4663,
          wallet: values.wallet ?? previous?.wallet ?? wallet?.address,
          mode: values.mode ?? previous?.mode ?? 'private-key',
          rpcUrl: values.rpc ?? previous?.rpcUrl ?? ROBINHOOD.rpcUrls.default.http[0],
          targets: values.targets ? parseTargets(values.targets) : previous?.targets,
          driftThresholdBps: values.threshold ? percentToBps(values.threshold) : previous?.driftThresholdBps ?? 500,
          slippageBps: values.slippage ? percentToBps(values.slippage) : previous?.slippageBps ?? 50,
          deadlineSeconds: previous?.deadlineSeconds ?? 120,
          pollSeconds: values.poll ? Number(values.poll) : previous?.pollSeconds ?? 30,
          rebalanceIntervalSeconds: values['rebalance-interval-seconds'] !== undefined
            ? Number(values['rebalance-interval-seconds']) : previous?.rebalanceIntervalSeconds ?? 3600,
        });
        await atomicWriteJson(CONFIG_PATH, config);
        print({ wallet: config.wallet, mode: config.mode, targets: config.targets, chainId: 4663,
          driftThresholdBps: config.driftThresholdBps, rebalanceIntervalSeconds: config.rebalanceIntervalSeconds });
      }); return;
    case 'targets':
      await inLock('config.lock', async () => {
        const config = await requiredConfig();
        let targets: Config['targets'];
        if (args[1] === 'set' && args[2] && args[3]) targets = redistributeTargets(config.targets, args[2], percentToBps(args[3]));
        else if (args[1] === 'replace' && args[2]) targets = parseTargets(args[2]);
        else throw new Error('Use targets set AAPL 30 or targets replace with all five percentages');
        await atomicWriteJson(CONFIG_PATH, validateConfig({ ...config, targets }));
        print({ targets, effective: 'next graph evaluation; an already-broadcast transaction still settles' });
      }); return;
    case 'check':
      await inLock('run.lock', async () => { const current = await tick(false); print(current); if (current.error) process.exitCode = 1; }); return;
    case 'start': {
      await requiredConfig();
      await inLock('run.lock', async () => {
        if (!values['resume-start']) await clearOlderStop();
        const abort = new AbortController();
        const stop = () => abort.abort();
        process.once('SIGINT', stop); process.once('SIGTERM', stop);
        print({ status: 'armed', chainId: 4663, control: 'this agent conversation; stop with the stop command' });
        try { await monitor(abort.signal); }
        finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
      }); return;
    }
    case 'stop':
      await control(() => atomicWriteJson(STOP_PATH, { requestedAt: new Date().toISOString(), requestId: randomUUID() }));
      print({ status: 'stop-requested', message: 'No new work after the current dispatch boundary; any submitted transaction still settles.' }); return;
    case 'chart': {
      await inLock('chart.lock', async () => {
        const server = await serve(); print({ url: 'http://127.0.0.1:4663', viewOnly: true });
        await new Promise<void>((resolve, reject) => {
          const close = () => { void server.closeChart().then(resolve, reject); };
          process.once('SIGINT', close); process.once('SIGTERM', close);
        });
      }); return;
    }
    case 'acknowledge-revert':
      await inLock('run.lock', async () => {
        const config = await requiredConfig(); const pending = await readJson<PendingTransaction>(PENDING_PATH);
        if (!pending) throw new Error('No pending transaction');
        validatePending(pending, config); const chain = createChain(config);
        if (await chain.publicClient.getChainId() !== 4663) throw new Error('Wrong RPC chain');
        const receipt = await chain.publicClient.getTransactionReceipt({ hash: pending.hash as Hex });
        if (receipt.status !== 'reverted' || receipt.from.toLowerCase() !== config.wallet.toLowerCase()) throw new Error('Only a mined reverted transaction can be acknowledged');
        await rm(PENDING_PATH);
        print({ status: 'revert-acknowledged', hash: pending.hash });
      }); return;
    default: throw new Error('Unknown command. Use help for the typed command interface');
  }
}

main().catch(error => {
  const message = error instanceof Error && error.constructor === Error ? error.message : 'Operation failed; no credential or provider payload has been printed';
  process.stderr.write(stringifyJson({ error: message })); process.exitCode = 1;
});
