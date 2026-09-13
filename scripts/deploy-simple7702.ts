/** One-off canonical deployment, deliberately outside the portfolio CLI/runtime. */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, getAddress, http, isAddress, keccak256, parseTransaction, serializeTransaction, type Address, type Hex } from 'viem';
import { resolveProfile } from './profile-routing.mjs';
import { validateConfig, type Config } from '../src/config.js';
import { acquireConfigLock } from '../src/config-lock.js';
import { ledgerSigner, LedgerSigningError, preparedLedgerTransaction, verifiedLedgerTransaction } from '../src/ledger-signing.js';
import { acquireLock, atomicWriteJson } from '../src/storage.js';
import type { LegacyPreparedTransaction } from '../src/privy.js';
import type { Chain } from '../src/transactions.js';
import { SIMPLE7702_ADDRESS } from '../src/simple7702.js';
import { buildSimple7702DeploymentTransaction, readSimple7702Deployment, verifySimple7702DeploymentReceipt,
  type DeploymentRecord } from './simple7702-deployment-proof.js';

export type Options = { wallet: Address; rootDir: string; journal: string; send: boolean; maxFeeWei?: bigint; signal?: AbortSignal };
export type Journal = DeploymentRecord & { version: 1; createdAt: string; gas: string; gasPrice: string; maxFeeWei: string; payloadHash: Hex };
type Signer = Pick<Awaited<ReturnType<typeof ledgerSigner>>, 'address' | 'signTransaction'>;
export type Dependencies = { chain?: Chain; signer?: (wallet: Address, options: { rootDir: string; signal: AbortSignal }) => Promise<Signer>;
  persist?: typeof atomicWriteJson };
class DeploymentError extends Error {}
function fail(message: string): never { throw new DeploymentError(message); }
const uint = (value: unknown): value is bigint => typeof value === 'bigint' && value >= 0n && value < 2n ** 256n;
const quantity = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value) && uint(BigInt(value));
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const inside = (root: string, path: string) => { const r = relative(root, path); return r === '' || (!r.startsWith(`..${sep}`) && r !== '..' && !isAbsolute(r)); };
const fingerprint = (tx: LegacyPreparedTransaction) => keccak256(serializeTransaction(tx));

export function parseDeploymentArgs(args: string[]): Options {
  const saved = new Map<string, string>(); let send = false;
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (key === '--send' && !send) { send = true; continue; }
    if (!['--wallet', '--root-dir', '--journal', '--max-fee-wei'].includes(key) || saved.has(key) || !args[i + 1] || args[i + 1]!.startsWith('--')) fail('Invalid deployment arguments. No operation was attempted.');
    saved.set(key, args[++i]!);
  }
  const wallet = saved.get('--wallet'), rootDir = saved.get('--root-dir'), journal = saved.get('--journal'), fee = saved.get('--max-fee-wei');
  if (!wallet || !isAddress(wallet, { strict: false }) || !rootDir || !journal || !isAbsolute(rootDir) || !isAbsolute(journal) ||
      [rootDir, journal].some(p => /[\0\r\n]/.test(p)) || !journal.endsWith('.json') || (fee !== undefined && (!quantity(fee) || BigInt(fee) === 0n)) || (send && fee === undefined)) {
    fail('Use --wallet ADDRESS --root-dir /absolute/portfolio-root --journal /absolute/separate-directory/deployment.json. Sending additionally requires --send --max-fee-wei INTEGER.');
  }
  return { wallet: getAddress(wallet), rootDir: resolve(rootDir), journal: resolve(journal), send,
    ...(fee === undefined ? {} : { maxFeeWei: BigInt(fee) }) };
}

/** Public control/journal data only; never follow a link to another file. */
async function publicFile(path: string): Promise<{ text: string; generation: string } | null> {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  try {
    const a = await file.stat({ bigint: true });
    if (!a.isFile() || a.nlink !== 1n || a.size > 65_536n) fail('Invalid public deployment/control record; existing data was preserved.');
    const text = await file.readFile('utf8'), b = await file.stat({ bigint: true });
    if (a.mtimeNs !== b.mtimeNs || a.ctimeNs !== b.ctimeNs || a.size !== b.size) fail('Public control data changed while being read.');
    return { text, generation: createHash('sha256').update(JSON.stringify([a.dev.toString(), a.ino.toString(), a.mtimeNs.toString(), a.ctimeNs.toString(), text])).digest('hex') };
  } finally { await file.close(); }
}
function journalValue(value: unknown, wallet: Address): Journal {
  const j = value as Journal;
  if (!j || typeof j !== 'object' || Array.isArray(j) || Object.keys(j).sort().join(',') !== 'chainId,createdAt,gas,gasPrice,hash,kind,maxFeeWei,nonce,payloadHash,version,wallet' ||
      j.version !== 1 || j.kind !== 'simple7702-deploy' || j.chainId !== 4663 || typeof j.wallet !== 'string' || !same(j.wallet, wallet) ||
      !/^0x[0-9a-f]{64}$/.test(j.hash) || !/^0x[0-9a-f]{64}$/.test(j.payloadHash) || !Number.isSafeInteger(j.nonce) || j.nonce < 0 ||
      typeof j.createdAt !== 'string' || !Number.isFinite(Date.parse(j.createdAt)) || !quantity(j.gas) || BigInt(j.gas) === 0n ||
      !quantity(j.gasPrice) || BigInt(j.gasPrice) === 0n || !quantity(j.maxFeeWei) || BigInt(j.gas) * BigInt(j.gasPrice) > BigInt(j.maxFeeWei)) fail('Invalid or mismatched deployment journal; preserve it for review.');
  const tx = { ...buildSimple7702DeploymentTransaction(), chainId: 4663 as const, type: 'legacy' as const, nonce: j.nonce, gas: BigInt(j.gas), gasPrice: BigInt(j.gasPrice) };
  if (fingerprint(tx) !== j.payloadHash) fail('Deployment journal payload differs from the pinned transaction.');
  return j;
}
async function observe(config: Config, chain: Chain, journal: Journal) {
  const rpc = chain.publicClient;
  if (await rpc.getChainId() !== 4663) fail('The RPC is not Robinhood mainnet.');
  let receipt;
  try { receipt = await rpc.getTransactionReceipt({ hash: journal.hash as Hex }); }
  catch { return { outcome: 'unresolved', hash: journal.hash, message: 'No verified receipt. The journal remains a barrier; no resend or signing was attempted.' }; }
  const block = await rpc.getBlock({ blockNumber: receipt.blockNumber }), head = await rpc.getBlockNumber({ cacheTime: 0 });
  if (block.hash !== receipt.blockHash || head < receipt.blockNumber + 1n) return { outcome: 'confirming', hash: journal.hash };
  if (!['success', 'reverted'].includes(receipt.status)) fail('Unrecognized deployment receipt status.');
  await verifySimple7702DeploymentReceipt(config, chain, journal, receipt);
  const tx = await rpc.getTransaction({ hash: journal.hash as Hex });
  if (tx.gas !== BigInt(journal.gas) || tx.gasPrice !== BigInt(journal.gasPrice)) fail('The receipt transaction fee fields differ from the journal.');
  return { outcome: receipt.status === 'success' ? 'confirmed' : 'reverted', hash: journal.hash, address: SIMPLE7702_ADDRESS,
    message: 'Receipt checked only. The deployment journal is retained and this command will never resend it.' };
}

export async function deploySimple7702(options: Options, dependencies: Dependencies = {}) {
  options = { ...options };
  if (!isAddress(options.wallet, { strict: false }) || !isAbsolute(options.rootDir) || !isAbsolute(options.journal) ||
      (options.send && (!uint(options.maxFeeWei) || options.maxFeeWei === 0n))) fail('Invalid explicit deployment options.');
  const rootDir = await realpath(options.rootDir), journalDir = await realpath(dirname(options.journal));
  const journalPath = resolve(journalDir, basename(options.journal));
  if (!journalPath.endsWith('.json') || inside(rootDir, journalPath)) fail('The one-off journal must be outside all portfolio storage, in a separate existing directory.');
  const profile = await resolveProfile(rootDir, { wallet: options.wallet }), dataDir = profile.dataDir;
  const configPath = resolve(dataDir, 'config.json'), stopPath = resolve(dataDir, 'stop.json'), pendingPath = resolve(dataDir, 'pending.json');
  const configFile = await publicFile(configPath); if (!configFile) fail('The selected public wallet configuration is missing.');
  const config = validateConfig(JSON.parse(configFile.text));
  if (config.mode !== 'ledger' || !same(config.wallet, options.wallet)) fail('Choose the matching existing Ledger portfolio.');
  const chain = dependencies.chain ?? ({ publicClient: createPublicClient({ transport: http(config.rpcUrl, { retryCount: 0, timeout: 15_000 }) }) } as Chain);
  const existing = await publicFile(journalPath);
  if (existing) return observe(config, chain, journalValue(JSON.parse(existing.text), options.wallet));
  if (await readSimple7702Deployment(chain) === 'deployed') return { outcome: 'already-deployed', address: SIMPLE7702_ADDRESS };
  const rpc = chain.publicClient, call = buildSimple7702DeploymentTransaction();
  const nonce = async () => {
    const [latest, pending] = await Promise.all([rpc.getTransactionCount({ address: config.wallet, blockTag: 'latest' }), rpc.getTransactionCount({ address: config.wallet, blockTag: 'pending' })]);
    if (!Number.isSafeInteger(latest) || latest < 0 || latest !== pending) fail('The wallet has an invalid or pending nonce. No deployment can be prepared.');
    return latest;
  };
  const fees = async () => {
    const result = await rpc.call({ account: config.wallet, ...call });
    if (!result.data || !same(result.data, SIMPLE7702_ADDRESS)) fail('The factory simulation did not return the canonical deployment address.');
    const [estimate, gasPrice, balance] = await Promise.all([rpc.estimateGas({ account: config.wallet, ...call }), rpc.getGasPrice(), rpc.getBalance({ address: config.wallet })]);
    if (!uint(estimate) || estimate === 0n || !uint(gasPrice) || gasPrice === 0n || !uint(balance)) fail('Invalid deployment gas/balance response.');
    return { estimate, gasPrice, balance };
  };
  const preview = async () => {
    const n = await nonce(), f = await fees();
    const gas = (f.estimate * 120n + 99n) / 100n, gasPrice = (f.gasPrice * 120n + 99n) / 100n, maximum = gas * gasPrice;
    if (!uint(gas) || !uint(gasPrice) || !uint(maximum)) fail('Deployment fee quantities overflow.');
    return { nonce: n, gas, gasPrice, maximum, balance: f.balance };
  };
  if (!options.send) {
    const p = await preview();
    return { outcome: 'ready', chainId: 4663, wallet: config.wallet, address: SIMPLE7702_ADDRESS, factory: call.to, valueWei: '0',
      calldataHash: keccak256(call.data), nonce: p.nonce, gasLimit: p.gas.toString(), gasPriceWei: p.gasPrice.toString(),
      maximumNetworkFeeWei: p.maximum.toString(), balanceWei: p.balance.toString(), funded: p.balance >= p.maximum,
      withinRequestedFee: options.maxFeeWei === undefined ? null : p.maximum <= options.maxFeeWei, journal: journalPath,
      message: 'Read-only preparation. No Ledger prompt, journal write or transaction was made.' };
  }
  const releaseRun = await acquireLock(dataDir, 'run.lock');
  let releaseJournal: (() => Promise<void>) | undefined, timer: ReturnType<typeof setInterval> | undefined;
  const controller = new AbortController(), signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  const deadline = setTimeout(() => controller.abort(new DeploymentError('Deployment signing timed out; no automatic resend.')), 180_000); deadline.unref();
  try {
    releaseJournal = await acquireLock(journalDir, `${basename(journalPath)}.lock`);
    const replay = await publicFile(journalPath);
    if (replay) return observe(config, chain, journalValue(JSON.parse(replay.text), options.wallet));
    const stop = await publicFile(stopPath); if (!stop) fail('Stop the Ledger portfolio before the one-off deployment. This command never stops or starts it.');
    const lock = await publicFile(resolve(dataDir, 'run.lock')); if (!lock) fail('Wallet execution lock is unavailable.');
    const guard = async () => {
      signal.throwIfAborted();
      if ((await publicFile(configPath))?.generation !== configFile.generation || (await publicFile(stopPath))?.generation !== stop.generation ||
          (await publicFile(resolve(dataDir, 'run.lock')))?.generation !== lock.generation || await publicFile(pendingPath) ||
          (await resolveProfile(rootDir, { wallet: config.wallet })).dataDir !== dataDir) fail('Wallet configuration, Stop, lock or pending state changed. Preserve the deployment journal if present.');
      signal.throwIfAborted();
    };
    await guard();
    if (await readSimple7702Deployment(chain) === 'deployed') return { outcome: 'already-deployed', address: SIMPLE7702_ADDRESS };
    const p = await preview();
    if (p.maximum > options.maxFeeWei! || p.balance < p.maximum) fail('The buffered deployment fee exceeds the explicit limit or available ETH.');
    const prepared = preparedLedgerTransaction({ ...call, chainId: 4663, type: 'legacy', nonce: p.nonce, gas: p.gas, gasPrice: p.gasPrice }) as LegacyPreparedTransaction;
    let checking = false;
    timer = setInterval(() => { if (checking) return; checking = true; void guard().catch(error => controller.abort(error)).finally(() => { checking = false; }); }, 200); timer.unref();
    await guard();
    const signer = await (dependencies.signer ?? ledgerSigner)(config.wallet, { rootDir, signal });
    if (!same(signer.address, config.wallet)) fail('Ledger signer identity does not match the selected wallet.');
    const raw = await signer.signTransaction(prepared);
    const decoded = parseTransaction(raw);
    const verified = await verifiedLedgerTransaction({ r: decoded.r, s: decoded.s, v: Number(decoded.v) }, config.wallet, prepared);
    if (verified.toLowerCase() !== raw.toLowerCase()) fail('Signed deployment bytes differ from the verified transaction.');
    const releaseConfig = await acquireConfigLock(dataDir, { signal });
    try {
      await guard();
      if (await readSimple7702Deployment(chain) !== 'undeployed' || await nonce() !== prepared.nonce) fail('Deployment or wallet nonce changed while Ledger was reviewing.');
      const fresh = await fees();
      if (fresh.estimate > prepared.gas || fresh.gasPrice > prepared.gasPrice || fresh.balance < p.maximum) fail('Fresh deployment gas or balance no longer fits the signed transaction.');
      // Gas simulation may wait on the provider. Revalidate public identity and
      // nonce after it completes, before persisting an intent to broadcast.
      const [deployment, finalNonce] = await Promise.all([readSimple7702Deployment(chain), nonce()]);
      if (deployment !== 'undeployed' || finalNonce !== prepared.nonce) fail('Deployment or wallet nonce changed during the final fee check.');
      await guard();
      const record: Journal = { version: 1, kind: 'simple7702-deploy', chainId: 4663, wallet: config.wallet, hash: keccak256(verified),
        nonce: prepared.nonce, createdAt: new Date().toISOString(), gas: prepared.gas.toString(), gasPrice: prepared.gasPrice.toString(),
        maxFeeWei: options.maxFeeWei!.toString(), payloadHash: fingerprint(prepared) };
      await (dependencies.persist ?? atomicWriteJson)(journalPath, record);
      const saved = await publicFile(journalPath);
      if (!saved || JSON.stringify(journalValue(JSON.parse(saved.text), config.wallet)) !== JSON.stringify(record)) fail('Deployment journal could not be verified. No broadcast was attempted.');
      await guard();
      // The immutable public journal is a durable uncertainty barrier. Never
      // persist raw signed bytes or retry this call, even when the RPC times out.
      try {
        const sent = await rpc.sendRawTransaction({ serializedTransaction: verified });
        if (!same(sent, record.hash)) return { outcome: 'unresolved', hash: record.hash, message: 'Broadcast returned a different hash. Keep the journal and check receipts; never resend automatically.' };
        return { outcome: 'broadcast', hash: record.hash, address: SIMPLE7702_ADDRESS, message: 'Submission accepted. Re-run without --send to verify the receipt; deployment is not yet confirmed.' };
      } catch { return { outcome: 'unresolved', hash: record.hash, message: 'Broadcast outcome is unknown. Keep the journal and check receipts; never resend automatically.' }; }
    } finally { await releaseConfig(); }
  } finally { clearTimeout(deadline); clearInterval(timer); await releaseJournal?.(); await releaseRun(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  const cancel = () => controller.abort(new DeploymentError('Deployment interrupted. Preserve any journal and check receipts before further action.'));
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try { console.log(JSON.stringify(await deploySimple7702({ ...parseDeploymentArgs(process.argv.slice(2)), signal: controller.signal }), null, 2)); }
  catch (error) { console.error(JSON.stringify({ outcome: 'blocked', message: error instanceof DeploymentError || error instanceof LedgerSigningError
    ? error.message : 'Deployment preparation or verification failed. Existing records were preserved; no automatic retry was made.' })); process.exitCode = 1; }
  finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
}
