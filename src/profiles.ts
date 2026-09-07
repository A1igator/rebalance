import { resolve } from 'node:path';
import { getAddress } from 'viem';
import { acquireLock, atomicWriteJson, readJson } from './storage.js';
import { validateConfig, type Config } from './config.js';
import { connectionPath, readProfiles, resolveProfile, validateProfileDirectory, walletIdentity, type RoutedProfile } from '../scripts/profile-routing.mjs';

export async function portfolios(root: string) {
  return Promise.all((await readProfiles(root)).map(async profile => {
    let config: Config;
    try {
      await validateProfileDirectory(root, profile.directory);
      config = validateConfig(await readJson(resolve(profile.dataDir, 'config.json')));
      if (walletIdentity(config.wallet) !== profile.wallet) throw new Error();
    } catch {
      return { wallet: getAddress(profile.wallet!), chainId: 4663, mode: null, targets: null, running: null,
        chartUrl: `http://127.0.0.1:${profile.chartPort}/`, error: 'This wallet configuration is unavailable; other portfolios are unaffected.' };
    }
    const lock = await readJson<{pid:number}>(resolve(profile.dataDir, 'run.lock'));
    const stopped = await readJson(resolve(profile.dataDir, 'stop.json'));
    let running = false;
    if (Number.isSafeInteger(lock?.pid) && lock!.pid > 0) {
      try { process.kill(lock!.pid, 0); running = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') running = true; }
    }
    return { wallet: getAddress(profile.wallet!), chainId: 4663, mode: config.mode, targets: config.targets,
      running: running && !stopped, chartUrl: `http://127.0.0.1:${profile.chartPort}/` };
  }));
}

export async function addPortfolio(root: string, input: unknown): Promise<RoutedProfile> {
  const config = validateConfig(input);
  const id = walletIdentity(config.wallet);
  const release = await acquireLock(root, 'portfolios.lock');
  try {
    const existing = await readProfiles(root);
    if (existing.some(profile => profile.wallet === id)) throw new Error('This wallet already has a portfolio. Connect to it; do not create a second runner.');
    let chartPort = 4664;
    const ports = new Set(existing.map(profile => profile.chartPort));
    while (ports.has(chartPort)) chartPort++;
    if (chartPort > 65535) throw new Error('No chart port is available in the wallet registry.');
    const directory = `wallets/${id}`;
    await validateProfileDirectory(root, directory);
    const dataDir = resolve(root, directory);
    const path = resolve(dataDir, 'config.json');
    const previous = await readJson<Config>(path);
    // An interrupted registration may be resumed only for its exact original configuration.
    if (previous && JSON.stringify(validateConfig(previous)) !== JSON.stringify(config)) throw new Error('Unregistered wallet state already exists; preserve it for inspection.');
    if (!previous) await atomicWriteJson(path, config);
    const profile = { wallet: id, chainId: 4663 as const, directory, chartPort };
    await atomicWriteJson(resolve(root, 'portfolios.json'), { version: 1,
      profiles: [...existing.map(({wallet, chainId, directory, chartPort}) => ({wallet, chainId, directory, chartPort})), profile] });
    return { ...profile, dataDir, rootDir: root };
  } finally { await release(); }
}

export async function connectPortfolio(root: string, sessionId: string, wallet: string) {
  const profile = await resolveProfile(root, { wallet });
  const path = connectionPath(root, sessionId);
  await atomicWriteJson(path, { version: 1, wallet: profile.wallet, chainId: 4663 });
  return { sessionId, wallet: getAddress(profile.wallet!), chainId: 4663,
    chartUrl: `http://127.0.0.1:${profile.chartPort}/`, tradingChanged: false };
}
