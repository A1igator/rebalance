import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { getAddress, isAddress } from 'viem';
import { readProfiles, validateProfileDirectory } from '../scripts/profile-routing.mjs';
import { readView, type SetupMode } from './view-session.js';
import { addPortfolio } from './profiles.js';
import { validateConfig } from './config.js';
import { ROBINHOOD } from './chain.js';
import { acquireLock, atomicWriteJson, readJson } from './storage.js';
import type { SetupWallet, WalletSetupContext, WalletSetupProgress } from './wallet-setup-types.js';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const modes = ['private-key', 'privy', 'ledger'] as const;
export type WalletSetupResult = {
  requestId: string; mode: SetupMode;
  state: WalletSetupProgress['state'] | 'ready' | 'failed';
  message: string; approval?: { url: string; code: string };
  wallet?: string; chartUrl?: string; reused?: boolean; tradingChanged: false;
};
type Record = WalletSetupResult & { version: 1; viewHash: string; sessionId: string; updatedAt: string; verified?: SetupWallet };
export type WalletSetupDependencies = {
  providers: { [mode in SetupMode]: (context: WalletSetupContext) => Promise<SetupWallet> };
};
const defaults: WalletSetupDependencies = { providers: {
  'private-key': async context => (await import('./hd-wallet.js')).createHdWallet(context.rootDir, context.requestKey),
  privy: async context => (await import('./privy-onboarding.js')).setupPrivyWallet(context),
  ledger: async context => (await import('./ledger-onboarding.js')).setupLedgerWallet(context),
} };
const invalid = () => new Error('Wallet setup request is unavailable or invalid.');
const publicResult = (record: Record): WalletSetupResult => ({ requestId: record.requestId, mode: record.mode,
  state: record.state, message: record.message, tradingChanged: false,
  ...(record.approval ? { approval: record.approval } : {}),
  ...(record.wallet ? { wallet: record.wallet, chartUrl: record.chartUrl, reused: record.reused } : {}) });
function validateApproval(approval: WalletSetupProgress['approval']) {
  if (approval === undefined) return;
  const url = new URL(approval.url);
  if (url.protocol !== 'https:' || url.hostname !== 'agents.privy.io' || url.port || url.username || url.password || url.hash ||
      !/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(approval.code) || approval.code.length < 4 || approval.code.length > 32 || url.pathname !== '/' || [...url.searchParams.keys()].length !== 1 || url.searchParams.get('user_code') !== approval.code) throw invalid();
}
function verifiedWallet(value: SetupWallet): SetupWallet {
  if (!value || !isAddress(value.address, { strict: false }) ||
      (value.accountIndex !== undefined && (!Number.isSafeInteger(value.accountIndex) || value.accountIndex < 0 || value.accountIndex >= 2 ** 31)) ||
      (value.derivationPath !== undefined && !/^(m\/)?44'\/60'\/(?:0'\/0\/\d+|\d+'\/0\/0)$/.test(value.derivationPath))) throw invalid();
  return { address: getAddress(value.address), ...(value.reused !== undefined ? { reused: Boolean(value.reused) } : {}),
    ...(value.accountIndex !== undefined ? { accountIndex: value.accountIndex } : {}),
    ...(value.derivationPath ? { derivationPath: value.derivationPath } : {}) };
}

/** User-click setup only. No native model queue, runner launch, recovery or transaction API. */
export class WalletSetups {
  readonly directory: string;
  private jobs = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private closed = false;
  constructor(readonly rootDir: string, private deps: WalletSetupDependencies = defaults) {
    this.rootDir = resolve(rootDir); this.directory = resolve(this.rootDir, 'wallet-setups');
  }
  private async scope(token: string, requestId: string) {
    if (typeof requestId !== 'string' || !uuid.test(requestId)) throw invalid();
    const view = await readView(this.rootDir, token);
    if (!view.delivery) throw invalid();
    await validateProfileDirectory(this.rootDir, '.');
    try { const info = await lstat(this.directory); if (!info.isDirectory() || info.isSymbolicLink()) throw invalid(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const viewHash = hash(token), normalized = requestId.toLowerCase();
    const id = hash(`${viewHash}\0${normalized}`);
    return { sessionId: view.sessionId, viewHash, requestId: normalized, id, path: resolve(this.directory, `${id}.json`) };
  }
  private async record(scope: Awaited<ReturnType<WalletSetups['scope']>>): Promise<Record | null> {
    try {
      const info = await lstat(scope.path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 16_384 || (info.mode & 0o077)) throw invalid();
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    const value = await readJson<Record>(scope.path);
    if (!value || value.version !== 1 || value.viewHash !== scope.viewHash || value.sessionId !== scope.sessionId ||
        value.requestId !== scope.requestId || !modes.includes(value.mode) || value.tradingChanged !== false ||
        !['preparing', 'awaiting-approval', 'awaiting-device', 'ready', 'failed'].includes(value.state) ||
        typeof value.message !== 'string' || value.message.length > 300 || !Number.isFinite(Date.parse(value.updatedAt))) throw invalid();
    validateApproval(value.approval);
    if (value.verified) value.verified = verifiedWallet(value.verified);
    if (value.state === 'ready' && (!value.wallet || !isAddress(value.wallet, { strict: false }) ||
        !/^http:\/\/127\.0\.0\.1:\d{1,5}\/chart$/.test(value.chartUrl ?? ''))) throw invalid();
    return value;
  }
  async read(token: string, requestId: string): Promise<WalletSetupResult> {
    const record = await this.record(await this.scope(token, requestId));
    if (!record) throw invalid();
    return publicResult(record);
  }
  async begin(token: string, mode: SetupMode, requestId: string): Promise<WalletSetupResult> {
    if (this.closed || !modes.includes(mode)) throw invalid();
    const scope = await this.scope(token, requestId);
    const saved = await this.record(scope);
    if (this.closed) throw invalid();
    if (saved && saved.mode !== mode) throw invalid();
    if (saved?.state === 'ready' || (saved && this.jobs.has(scope.id))) return publicResult(saved);
    let release: () => Promise<void>;
    try { release = await acquireLock(this.directory, `${scope.id}.lock`); }
    catch {
      const current = await this.record(scope);
      if (current?.mode === mode) return publicResult(current);
      throw invalid();
    }
    let record: Record;
    try {
      const current = await this.record(scope);
      if (this.closed) throw invalid();
      if (current?.mode !== undefined && current.mode !== mode) throw invalid();
      if (current?.state === 'ready') { await release(); return publicResult(current); }
      record = { version: 1, sessionId: scope.sessionId, viewHash: scope.viewHash, requestId: scope.requestId,
        mode, state: 'preparing', message: 'Preparing your wallet…', tradingChanged: false, updatedAt: new Date().toISOString(),
        ...(current?.verified ? { verified: current.verified } : {}) };
      await atomicWriteJson(scope.path, record);
      if (this.closed) throw invalid();
    } catch (error) { await release(); throw error; }
    const initial = publicResult(record), controller = new AbortController();
    const promise = Promise.resolve().then(async () => {
      let finished = false;
      let writes = Promise.resolve();
      const persist = () => { record.updatedAt = new Date().toISOString(); return atomicWriteJson(scope.path, record); };
      const onProgress = (progress: WalletSetupProgress) => writes = writes.then(async () => {
        if (finished || controller.signal.aborted) return;
        if (!['preparing', 'awaiting-approval', 'awaiting-device'].includes(progress.state) ||
            typeof progress.message !== 'string' || progress.message.length > 300) throw invalid();
        validateApproval(progress.approval);
        record.state = progress.state; record.message = progress.message;
        delete record.approval;
        if (progress.approval) record.approval = progress.approval;
        await persist();
      });
      try {
        const context = { rootDir: this.rootDir, requestKey: scope.id, signal: controller.signal, onProgress };
        // Local derivation is replay-safe and also verifies its provisioned key.
        const wallet = record.verified && mode !== 'private-key' ? record.verified : verifiedWallet(await this.deps.providers[mode](context));
        await writes;
        if (controller.signal.aborted) throw invalid();
        record.verified = wallet; record.state = 'preparing'; record.message = 'Preparing your portfolio…';
        delete record.approval; await persist();
        if (controller.signal.aborted) throw invalid();
        let profile = (await readProfiles(this.rootDir)).find(p => p.wallet === wallet.address.toLowerCase());
        const reused = Boolean(profile);
        if (profile) {
          await validateProfileDirectory(this.rootDir, profile.directory);
          const config = validateConfig(await readJson(resolve(profile.dataDir, 'config.json')));
          if (config.wallet.toLowerCase() !== wallet.address.toLowerCase() || config.mode !== mode) throw invalid();
        } else {
          if (controller.signal.aborted) throw invalid();
          profile = await addPortfolio(this.rootDir, { version: 1, chainId: 4663, wallet: wallet.address, mode,
            rpcUrl: ROBINHOOD.rpcUrls.default.http[0], targets: { USDG: 500, AAPL: 2375, NVDA: 2375, MSFT: 2375, AMD: 2375 },
            driftThresholdBps: 500, slippageBps: 50, deadlineSeconds: 120, pollSeconds: 30, rebalanceIntervalSeconds: 3600 });
        }
        finished = true;
        record.state = 'ready'; record.message = reused ? 'Wallet ready. Opening its portfolio…' : 'Wallet created. Opening its portfolio…';
        record.wallet = wallet.address; record.chartUrl = `http://127.0.0.1:${profile.chartPort}/chart`; record.reused = reused;
        await persist();
      } catch {
        finished = true;
        await writes.catch(() => {});
        record.state = 'failed'; delete record.approval;
        record.message = mode === 'ledger' ? 'Connect and unlock your Ledger, open Ethereum, then try again.'
          : mode === 'privy' ? 'Privy setup did not finish. Complete sign-in or try again.'
            : 'Local account setup was interrupted. Try again to resume the same account.';
        await persist().catch(() => {});
      } finally { await release(); }
    });
    this.jobs.set(scope.id, { controller, promise });
    void promise.finally(() => { this.jobs.delete(scope.id); }).catch(() => {});
    return initial;
  }
  async close() {
    this.closed = true;
    for (const job of this.jobs.values()) job.controller.abort();
    await Promise.allSettled([...this.jobs.values()].map(job => job.promise));
  }
}
