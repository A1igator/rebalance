import { lstat } from 'node:fs/promises';
import { encodeFunctionData, erc20Abi, formatUnits, getAddress, isAddress, parseAbi, toHex, zeroAddress, type Address } from 'viem';
import { createChain, ROUTER, type ChainTransaction } from './chain.js';
import { CONFIG_PATH, DATA, PENDING_PATH, loadConfig, validateConfig, type Config } from './config.js';
import { acquireConfigLock } from './config-lock.js';
import { atomicWriteJson, readJson } from './storage.js';
import { providerKeyPath, saveProviderKey, validatePaymasterConfig, type PaymasterConfig } from './paymaster-config.js';
import { PAYMASTER_ACCOUNT_ABI, PAYMASTER_ENTRY_POINT, PAYMASTER_NONCE_KEY, PAYMASTER_USDG } from './paymaster-protocol.js';
import { alchemyRpc, type PaymasterRpc } from './paymaster-rpc.js';

export const DELEGATION_NOTICE = 'USDG execution uses EIP-7702 on this same wallet address. Disabling this transport does not revoke an existing on-chain delegation.';
const USE = 'Use paymaster status, setup, check, configure <policy-uuid> [public-paymaster-address], or disable. Never pass API keys as arguments.';
export type ProviderCredentialStatus = 'missing' | 'file-present' | 'environment-present' | 'unavailable';
export type PaymasterCheck = {
  state: 'estimate-verified'; observedAt: string; feeTokenAmount: string; feeUSDG: string;
  requiresDelegation: boolean; scope: 'USDG approval probe; not a rebalance fee or execution result';
};
export type PaymasterCommandResult = {
  state: 'configured' | 'disabled' | 'checked' | 'credential-saved'; message?: string;
  wallet?: Address; chainId?: 4663; gasPayment?: PaymasterConfig | null; transport?: 'alchemy-usdg' | 'native-eth';
  delegationNotice?: string; credential?: ProviderCredentialStatus; readiness?: 'not-checked';
  pendingReceiptPreserved?: boolean; check?: PaymasterCheck;
};
export type PaymasterCommandDependencies = {
  load: () => Promise<Config | null>;
  save: (config: Config) => Promise<void>;
  pending: () => Promise<unknown>;
  lock: () => Promise<() => Promise<void>>;
  check: (config: Config) => Promise<PaymasterCheck>;
  discover: (config: Config, policyId: string) => Promise<Address>;
  credentialStatus: () => Promise<ProviderCredentialStatus>;
  setup: () => Promise<void>;
};

/** Check presence/permissions only. Status never reads or emits the credential. */
export async function paymasterCredentialStatus(): Promise<ProviderCredentialStatus> {
  if (process.env.REBALANCE_ALCHEMY_API_KEY !== undefined) return 'environment-present';
  try {
    const info = await lstat(providerKeyPath());
    return info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && !(info.mode & 0o077) && info.size > 0 && info.size <= 512
      ? 'file-present' : 'unavailable';
  } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unavailable'; }
}

/** Read-only simulation of a zero allowance, never a request to change it on-chain. */
export function paymasterProbe(): ChainTransaction {
  return { to: PAYMASTER_USDG, kind: 'approval', value: 0n,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [ROUTER, 0n] }) };
}
function policyId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new Error('Provide the public Alchemy policy UUID, never an API key.');
  return value.toLowerCase();
}
const NONCE_ABI = parseAbi(['function getNonce(address sender, uint192 key) view returns (uint256)']);
/** Stub discovery supplies an address only; configure still requires full estimation afterwards. */
export async function discoverPaymaster(config: Config, requestedPolicy: string, overrides: { createChain?: typeof createChain; provider?: PaymasterRpc } = {}): Promise<Address> {
  const policy = policyId(requestedPolicy);
  try {
    const chain = (overrides.createChain ?? createChain)(config);
    if (await chain.publicClient.getChainId() !== 4663) throw new Error();
    const nonce = await chain.publicClient.readContract({ address: PAYMASTER_ENTRY_POINT, abi: NONCE_ABI,
      functionName: 'getNonce', args: [config.wallet, PAYMASTER_NONCE_KEY] });
    if (typeof nonce !== 'bigint' || nonce < 0n || nonce >= 2n ** 256n) throw new Error();
    const probe = paymasterProbe();
    const operation = { sender: config.wallet, nonce: toHex(nonce),
      callData: encodeFunctionData({ abi: PAYMASTER_ACCOUNT_ABI, functionName: 'execute', args: [probe.to, probe.value, probe.data] }) };
    const result = await (overrides.provider ?? alchemyRpc())('pm_getPaymasterStubData', [operation, PAYMASTER_ENTRY_POINT, toHex(4663),
      { policyId: policy, erc20Context: { tokenAddress: PAYMASTER_USDG } }], 'bundler');
    if (!result || typeof result !== 'object' || Array.isArray(result) || !('paymaster' in result) ||
        typeof result.paymaster !== 'string' || !isAddress(result.paymaster, { strict: false }) || result.paymaster.toLowerCase() === zeroAddress ||
        !('paymasterData' in result) || typeof result.paymasterData !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(result.paymasterData) || result.paymasterData.length > 131074) throw new Error();
    return getAddress(result.paymaster);
  } catch { throw new Error('Could not discover this policy’s Robinhood paymaster. Check the local app key and active canonical USDG policy; no settings were changed.'); }
}
export async function checkPaymaster(config: Config, overrides: { createChain?: typeof createChain; prepare?: typeof import('./paymaster.js').preparePaymaster } = {}): Promise<PaymasterCheck> {
  const { preparePaymaster, PaymasterBalanceError } = await import('./paymaster.js');
  try {
    const quote = await (overrides.prepare ?? preparePaymaster)(config, (overrides.createChain ?? createChain)(config), paymasterProbe(), true);
    return { state: 'estimate-verified', observedAt: new Date(quote.observedAt).toISOString(),
      feeTokenAmount: quote.prepared.feeTokenAmount.toString(), feeUSDG: formatUnits(quote.prepared.feeTokenAmount, 6),
      requiresDelegation: quote.state.requireAuthorization, scope: 'USDG approval probe; not a rebalance fee or execution result' };
  } catch (error) {
    if (error instanceof PaymasterBalanceError) throw new Error(`The selected wallet needs at least ${formatUnits(error.reserve, 6)} USDG for this fee probe. No settings or transactions changed.`);
    throw new Error('Read-only USDG paymaster verification failed. Check the local API key, Robinhood app, active USDG policy, verified paymaster address and funding. Existing settings were preserved.');
  }
}

type HiddenInput = Pick<NodeJS.ReadStream, 'isTTY' | 'isRaw' | 'setRawMode' | 'on' | 'off' | 'resume' | 'pause'>;
type PromptOutput = Pick<NodeJS.WriteStream, 'isTTY' | 'write'>;
/** User-owned local terminal only: do not run this prompt through a model tool or log its input. */
export async function readHiddenProviderKey(input: HiddenInput = process.stdin, output: PromptOutput = process.stderr, timeoutMs = 120_000): Promise<string> {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') {
    throw new Error('Run paymaster setup yourself in a local terminal for its hidden API-key prompt. Piped input and command arguments are not accepted.');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new Error('Invalid local setup timeout');
  return new Promise((resolve, reject) => {
    let value = '', finished = false;
    const priorRaw = input.isRaw ?? false;
    const timer = setTimeout(() => finish(new Error('Local provider setup timed out; no credential was saved.')), timeoutMs);
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      input.off('data', data); input.off('end', end); input.off('error', end);
      process.off('SIGINT', interrupted); process.off('SIGTERM', interrupted);
      try { input.setRawMode(priorRaw); input.pause(); output.write('\n'); } catch { /* No secret is printed. */ }
      const result = value; value = '';
      if (error) reject(error); else resolve(result);
    };
    const interrupted = () => finish(new Error('Local provider setup cancelled; no credential was saved.'));
    const end = () => finish(new Error('Local provider setup ended; no credential was saved.'));
    const data = (chunk: Buffer | string) => {
      for (const character of chunk.toString()) {
        if (character === '\u0003' || character === '\u0004' || character === '\u001b') { finish(new Error('Local provider setup cancelled; no credential was saved.')); return; }
        if (character === '\r' || character === '\n') { finish(); return; }
        if (character === '\u007f' || character === '\b') { value = value.slice(0, -1); continue; }
        if (!/^[A-Za-z0-9_-]$/.test(character) || value.length >= 256) { finish(new Error('Invalid local API key; no credential was saved.')); return; }
        value += character;
      }
    };
    try {
      output.write('Alchemy API key (hidden, local only): ');
      input.setRawMode(true); process.once('SIGINT', interrupted); process.once('SIGTERM', interrupted); input.on('data', data); input.on('end', end); input.on('error', end); input.resume();
    } catch { finish(new Error('Could not open the hidden local prompt; no credential was saved.')); }
  });
}
export async function setupPaymasterCredential(): Promise<void> {
  const existing = await paymasterCredentialStatus();
  if (existing !== 'missing') throw new Error('An Alchemy credential is already present or its storage needs inspection. Setup will not overwrite it.');
  const key = await readHiddenProviderKey();
  try { await saveProviderKey(key); }
  catch { throw new Error('The local Alchemy credential could not be saved. Existing credentials were preserved.'); }
}

/** Public configuration commands never load a signer, arm a runner, or send a transaction. */
export async function runPaymasterCommand(args: readonly string[], overrides: Partial<PaymasterCommandDependencies> = {}): Promise<PaymasterCommandResult> {
  const action = args[0];
  if (!action || !['status', 'setup', 'check', 'configure', 'disable'].includes(action) || (action === 'configure' ? ![2, 3].includes(args.length) : args.length !== 1)) throw new Error(USE);
  const deps: PaymasterCommandDependencies = {
    load: loadConfig, save: config => atomicWriteJson(CONFIG_PATH, config), pending: () => readJson(PENDING_PATH),
    lock: () => acquireConfigLock(DATA), check: checkPaymaster, discover: discoverPaymaster, credentialStatus: paymasterCredentialStatus, setup: setupPaymasterCredential,
    ...overrides,
  };
  if (action === 'setup') {
    await deps.setup();
    return { state: 'credential-saved', message: 'Local credential saved. Portfolio settings and trading were unchanged; configure a public policy next.' };
  }
  const original = await deps.load();
  if (!original) throw new Error('Select and configure a wallet portfolio before setting its gas transport.');
  const snapshot = JSON.stringify(original);
  const current = () => ({ wallet: original.wallet, chainId: original.chainId, gasPayment: original.gasPayment ?? null,
    transport: original.gasPayment ? 'alchemy-usdg' as const : 'native-eth' as const, delegationNotice: DELEGATION_NOTICE });
  if (action === 'status') return { ...current(), state: original.gasPayment ? 'configured' : 'disabled',
    credential: await deps.credentialStatus(), readiness: 'not-checked', message: 'Saved settings and credential presence only; use paymaster check for a fresh read-only estimate.' };
  if (action === 'check') {
    if (!original.gasPayment) throw new Error('No USDG gas transport is configured for this wallet.');
    return { ...current(), state: 'checked', check: await deps.check(original), delegationNotice: DELEGATION_NOTICE };
  }
  const policy = action === 'configure' ? policyId(args[1]) : undefined;
  const gasPayment = policy ? validatePaymasterConfig({ provider: 'alchemy', token: 'USDG', policyId: policy,
    paymaster: args[2] ?? await deps.discover(original, policy) }) : undefined;
  const { gasPayment: _previous, ...rest } = original;
  const next = validateConfig({ ...rest, ...(gasPayment ? { gasPayment } : {}) });
  // Never hold the short broadcast/configuration lock across network requests.
  const check = gasPayment ? await deps.check(next) : undefined;
  const release = await deps.lock();
  let pendingReceiptPreserved = false;
  try {
    if (JSON.stringify(await deps.load()) !== snapshot) throw new Error('Portfolio settings changed during verification. Retry against the current settings; nothing was overwritten.');
    pendingReceiptPreserved = Boolean(await deps.pending());
    await deps.save(next);
  } finally { await release(); }
  return { wallet: next.wallet, chainId: next.chainId, state: gasPayment ? 'configured' : 'disabled',
    gasPayment: gasPayment ?? null, transport: gasPayment ? 'alchemy-usdg' : 'native-eth',
    ...(check ? { check } : {}), pendingReceiptPreserved, delegationNotice: DELEGATION_NOTICE,
    message: 'Settings saved for the next graph evaluation; runner state and targets were preserved. No signing or transaction was performed.' };
}
