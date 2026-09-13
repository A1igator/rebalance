// Resolve the conversation once, before modules capture DATA. Child services pin
// their directory and never follow later changes to a conversation's attachment.
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { portfolioRoot, readProfiles, resolveProfile, sessionIdentity, walletIdentity, type RoutedProfile } from '../scripts/profile-routing.mjs';

const repository = fileURLToPath(new URL('..', import.meta.url));
const cli = fileURLToPath(import.meta.url);
const print = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + '\n');
function option(args: string[], name: string) {
  let result: string | undefined;
  for (let index = 0; index < args.length; index++) {
    if (args[index] !== name && !args[index]!.startsWith(name + '=')) continue;
    if (result !== undefined) throw new Error(`Duplicate ${name}`);
    const value = args[index] === name ? args.splice(index, 2)[1] : args.splice(index, 1)[0]!.slice(name.length + 1);
    if (!value || value.startsWith('--')) throw new Error(`Missing ${name} value`);
    result = value; index--;
  }
  return result;
}
function pin(profile: RoutedProfile, sessionId?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, REBALANCE_ROOT_DIR: profile.rootDir, REBALANCE_DATA_DIR: profile.dataDir,
    REBALANCE_CHART_PORT: String(profile.chartPort), REBALANCE_PROFILE_PINNED: '1', REBALANCE_PROFILE_WALLET: profile.wallet ?? '' };
  if (sessionId) env.REBALANCE_SESSION_ID = sessionId;
  return env;
}
function child(args: string[], profile: RoutedProfile, sessionId?: string): Promise<unknown> {
  return new Promise((done, fail) => execFile(process.execPath, ['--import', 'tsx', cli, ...args], {
    cwd: repository, env: pin(profile, sessionId), timeout: 120_000, maxBuffer: 1_048_576,
  }, (error, stdout) => {
    try { const result = JSON.parse(stdout); if (error && !result?.app) throw new Error(); done(result); }
    catch { fail(new Error('The selected wallet command could not be verified. Inspect its public status before retrying.')); }
  }));
}

async function main() {
  const args = process.argv.slice(2);
  const explicit = option(args, '--profile');
  const sessionId = sessionIdentity(option(args, '--session'));
  const root = portfolioRoot();
  if (args[0] === 'view') {
    if (args.length !== 1) throw new Error('Use view with optional --profile and --session.');
    const { prepareView } = await import('./view.js');
    print(await prepareView(root, sessionId, explicit)); return;
  }
  const bareLaunch = args[0] === 'launch' && (args.length === 1 || args.length === 2 && args[1] === '--setup-only');
  if (args.includes('--restore') || bareLaunch && !explicit && process.env.REBALANCE_PROFILE_PINNED !== '1') {
    if (explicit || process.env.REBALANCE_PROFILE_PINNED === '1') throw new Error('App restoration cannot use a pinned or explicitly selected portfolio.');
    const requestId = option(args, '--request-id');
    if (args[0] !== 'launch' || args.some(arg => !['launch', '--restore', '--setup-only'].includes(arg)) ||
        new Set(args).size !== args.length) throw new Error('Use launch --restore with optional --request-id, --session and --setup-only.');
    const { restoreApp } = await import('./app-launch.js');
    print(await restoreApp(root, sessionId, { requestId, setupOnly: args.includes('--setup-only') })); return;
  }
  if (args[0] === 'wallet' && ['list','add','connect'].includes(args[1] ?? '')) {
    const { portfolios, addPortfolio, connectPortfolio } = await import('./profiles.js');
    if (args[1] === 'list') { if (args.length !== 2) throw new Error('Use wallet list'); print({ portfolios: await portfolios(root), sessionId: sessionId ?? null }); return; }
    if (args[1] === 'connect') {
      if (args.length !== 3 || !sessionId) throw new Error('Use wallet connect <address> with this conversation’s --session identity.');
      const { prepareView } = await import('./view.js');
      // Connection can prepare the view, but never arms or stops a trading runner.
      const view = await prepareView(root, sessionId, args[2]);
      const connected = await connectPortfolio(root, sessionId, args[2]!);
      print({ ...connected, view }); return;
    }
    const wallet = option(args, '--wallet'); const mode = option(args, '--mode'); const targets = option(args, '--targets');
    const rpcUrl = option(args, '--rpc');
    if (args.length !== 2 || !wallet || !mode || !targets) throw new Error('Use wallet add --wallet <address> --mode private-key|privy|ledger --targets <five allocations>');
    const { parseTargets } = await import('./config.js');
    const { ROBINHOOD } = await import('./chain.js');
    const profile = await addPortfolio(root, { version: 1, chainId: 4663, wallet, mode,
      targets: parseTargets(targets), rpcUrl: rpcUrl ?? ROBINHOOD.rpcUrls.default.http[0],
      driftThresholdBps: 500, slippageBps: 50, deadlineSeconds: 120, pollSeconds: 30, rebalanceIntervalSeconds: 3600 });
    print({ wallet: profile.wallet, chainId: 4663, chartUrl: `http://127.0.0.1:${profile.chartPort}/`, armed: false, connected: false }); return;
  }
  if (args[0] === 'launch' && args.includes('--all')) {
    if (explicit || args.some(arg => !['launch','--all','--setup-only'].includes(arg))) throw new Error('Use launch --all with optional --setup-only; allocation changes are per wallet.');
    const profiles = await readProfiles(root);
    const results = [];
    for (const profile of profiles) {
      try { results.push({ wallet: profile.wallet, result: await child(args.filter(arg => arg !== '--all'), profile, sessionId) }); }
      catch { results.push({ wallet: profile.wallet, result: { app: 'Rebalance', outcome: 'unknown', status: null,
        message: 'This wallet launch could not be verified. Inspect its status before retrying; other portfolios were handled independently.' } }); }
    }
    print({ app: 'Rebalance', portfolios: results }); return;
  }
  let profile: RoutedProfile;
  if (process.env.REBALANCE_PROFILE_PINNED === '1') {
    const dataDir = resolve(process.env.REBALANCE_DATA_DIR || root);
    const wallet = process.env.REBALANCE_PROFILE_WALLET || null;
    if (explicit && walletIdentity(explicit) !== wallet) throw new Error('A pinned wallet worker cannot switch portfolios.');
    profile = { rootDir: root, dataDir, wallet, chainId: 4663, directory: '', chartPort: Number(process.env.REBALANCE_CHART_PORT || 4663) };
  } else if (['help', undefined].includes(args[0]) || args.includes('--help')) {
    profile = { rootDir: root, dataDir: root, wallet: null, chainId: 4663, directory: '.', chartPort: 4663 };
  } else profile = await resolveProfile(root, { wallet: explicit, sessionId });
  Object.assign(process.env, pin(profile, sessionId));
  process.argv.splice(2, process.argv.length - 2, ...args);
  await import('./commands.js');
}
main().catch(error => {
  process.stderr.write(JSON.stringify({ error: error instanceof Error && error.constructor === Error ? error.message : 'Wallet routing failed; existing portfolios were preserved.' }) + '\n');
  process.exitCode = 1;
});
