import { createHash } from 'node:crypto';
import type { Subscription } from 'rxjs';
import { LedgerDiagnostics, type LedgerDiagnostic } from './ledger-diagnostics.js';
import { getAddress, hexToBytes, isAddress, parseTransaction, recoverTransactionAddress, serializeTransaction,
  type Address, type Hex, type SignedAuthorization, type TransactionSerialized } from 'viem';
import { recoverAuthorizationAddress } from 'viem/utils';
import { portfolioRoot } from '../scripts/profile-routing.mjs';
import { completedAddress, findLedgerAccount, withLedgerDevice,
  type LedgerAddressAction, type LedgerDevice, type LedgerOnboardingDependencies } from './ledger-onboarding.js';
import type { CaliburAuthorizationRequest, PreparedTransaction } from './privy.js';
import { CALIBUR_ADDRESS } from './calibur.js';

export type LedgerSigningOutcome = 'rejected' | 'cancelled' | 'timeout' | 'unavailable' |
  'account-mismatch' | 'invalid-transaction' | 'invalid-signature' | 'unsupported';
const MESSAGES: Record<LedgerSigningOutcome, string> = {
  rejected: 'Action cancelled on the Ledger. Reconnect the device or retry explicitly when ready.',
  cancelled: 'Ledger signing was cancelled. No transaction was broadcast.',
  timeout: 'Ledger signing timed out. Reconnect and unlock the device, then open Ethereum to retry.',
  unavailable: 'Ledger signing could not complete. Check the device and Ethereum app, then reconnect or retry explicitly.',
  'account-mismatch': 'The verified Ledger account does not match the selected wallet. No fallback account was used.',
  'invalid-transaction': 'The prepared Ledger transaction is invalid. No transaction was signed.',
  'invalid-signature': 'Ledger returned an invalid signature or one for a different account or transaction. No transaction was broadcast.',
  unsupported: 'Ledger requested a signing fallback. Review the device display support before making a new request.',
};
export class LedgerSigningError extends Error {
  override name = 'LedgerSigningError';
  constructor(readonly outcome: LedgerSigningOutcome, readonly diagnostic?: LedgerDiagnostic) {
    const context = diagnostic ? [diagnostic.phase, diagnostic.step, diagnostic.interaction, diagnostic.errorTag, diagnostic.deviceCode,
      diagnostic.httpStatus ? `HTTP ${diagnostic.httpStatus}` : undefined].filter(Boolean).join('; ') : '';
    const message = outcome === 'unavailable' && diagnostic?.errorTag === 'NodeHidSendReportError'
      ? 'Ledger USB communication failed before the command could complete. Check the USB connection and Ethereum app, then use Retry.'
      : MESSAGES[outcome];
    super(`${message}${context ? ` [${context}]` : ''}`);
  }
}
export type LedgerSigningOptions = LedgerOnboardingDependencies & { rootDir?: string; signal?: AbortSignal };
const MAX_TIMEOUT_MS = 120_000;
const ANCHOR_PATH = "44'/60'/0'/0/0";
const CURVE_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const readOptions = { checkOnDevice: false, returnChainCode: false } as const;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const fingerprint = (wallet: Address) => createHash('sha256').update(wallet.toLowerCase()).digest('hex');

const uint256 = (value: unknown): value is bigint => typeof value === 'bigint' && value >= 0n && value < 2n ** 256n;

/** This adapter can authorize only the pinned Calibur deployment on Robinhood. */
export function preparedLedgerAuthorization(request: CaliburAuthorizationRequest): CaliburAuthorizationRequest {
  if (!object(request) || Object.keys(request).some(key => !['chainId', 'address', 'nonce'].includes(key)) ||
      request.chainId !== 4663 || typeof request.address !== 'string' || request.address.toLowerCase() !== CALIBUR_ADDRESS.toLowerCase() ||
      !Number.isSafeInteger(request.nonce) || request.nonce < 0) throw new LedgerSigningError('invalid-transaction');
  return Object.freeze({ chainId: 4663, address: CALIBUR_ADDRESS, nonce: request.nonce });
}

function signatureScalars(output: Record<string, unknown>): { r: Hex; s: Hex } {
  if (typeof output.r !== 'string' || !/^0x[a-fA-F0-9]{64}$/.test(output.r) ||
      typeof output.s !== 'string' || !/^0x[a-fA-F0-9]{64}$/.test(output.s)) throw new Error();
  const r = BigInt(output.r), s = BigInt(output.s);
  if (r <= 0n || r >= CURVE_ORDER || s <= 0n || s > CURVE_ORDER / 2n) throw new Error();
  return { r: output.r.toLowerCase() as Hex, s: output.s.toLowerCase() as Hex };
}

/** Nonlegacy SDK responses contain parity or the conventional 27/28 recovery byte. */
function sdkParity(output: unknown): { r: Hex; s: Hex; yParity: number } {
  if (!object(output) || Object.keys(output).some(key => !['r', 's', 'v'].includes(key)) ||
      ![0, 1, 27, 28].includes(output.v as number)) throw new Error();
  return { ...signatureScalars(output), yParity: Number(output.v) >= 27 ? Number(output.v) - 27 : Number(output.v) };
}

function preparedSignedAuthorization(value: unknown): SignedAuthorization<number> {
  if (!object(value) || Object.keys(value).some(key => !['chainId', 'address', 'nonce', 'r', 's', 'yParity', 'v'].includes(key)) ||
      (value.yParity !== 0 && value.yParity !== 1) ||
      (value.v !== undefined && value.v !== BigInt(value.yParity + 27))) throw new Error();
  const request = preparedLedgerAuthorization({ chainId: value.chainId, address: value.address, nonce: value.nonce } as CaliburAuthorizationRequest);
  return Object.freeze({ ...request, ...signatureScalars(value), yParity: value.yParity });
}

/** Recover the authorization signer independently of the SDK and its device display. */
export async function verifiedLedgerAuthorization(output: unknown, wallet: Address, request: CaliburAuthorizationRequest): Promise<SignedAuthorization<number>> {
  try {
    const authorization = Object.freeze({ ...preparedLedgerAuthorization(request), ...sdkParity(output) });
    if ((await recoverAuthorizationAddress({ authorization })).toLowerCase() !== wallet.toLowerCase()) throw new Error();
    return authorization;
  } catch { throw new LedgerSigningError('invalid-signature'); }
}

/** Preserve the exact payload, including nested authorization, across async device steps. */
export function preparedLedgerTransaction(tx: PreparedTransaction): PreparedTransaction {
  try {
    const commonKeys = ['chainId', 'type', 'nonce', 'gas', 'to', 'data', 'value'];
    if (!object(tx) || tx.chainId !== 4663 || !Number.isSafeInteger(tx.nonce) || tx.nonce < 0 ||
        !uint256(tx.gas) || tx.gas === 0n || !uint256(tx.value) || !isAddress(tx.to, { strict: false }) ||
        typeof tx.data !== 'string' || !/^0x(?:[a-fA-F0-9]{2})*$/.test(tx.data)) throw new Error();
    const common = { chainId: 4663 as const, nonce: tx.nonce, gas: tx.gas, to: getAddress(tx.to), data: tx.data, value: tx.value };
    if (tx.type === 'legacy') {
      if (Object.keys(tx).some(key => ![...commonKeys, 'gasPrice'].includes(key)) || !uint256(tx.gasPrice) || tx.gasPrice === 0n) throw new Error();
      return Object.freeze({ ...common, type: 'legacy', gasPrice: tx.gasPrice });
    }
    if (tx.type !== 'eip7702' || Object.keys(tx).some(key => ![...commonKeys, 'maxFeePerGas', 'maxPriorityFeePerGas', 'authorizationList'].includes(key)) ||
        !uint256(tx.maxFeePerGas) || tx.maxFeePerGas === 0n || !uint256(tx.maxPriorityFeePerGas) || tx.maxPriorityFeePerGas > tx.maxFeePerGas ||
        tx.nonce >= Number.MAX_SAFE_INTEGER || !Array.isArray(tx.authorizationList) || tx.authorizationList.length !== 1 || tx.value !== 0n) throw new Error();
    const authorization = preparedSignedAuthorization(tx.authorizationList[0]);
    if (authorization.nonce !== tx.nonce + 1) throw new Error(); // Self-sponsored sender nonce increments before authorization processing.
    return Object.freeze({ ...common, type: 'eip7702', maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
      authorizationList: Object.freeze([authorization] as const) });
  } catch { throw new LedgerSigningError('invalid-transaction'); }
}

async function requireAuthorizationWallet(tx: PreparedTransaction, wallet: Address): Promise<void> {
  if (tx.type !== 'eip7702') return;
  try {
    if (tx.to.toLowerCase() !== wallet.toLowerCase() ||
        (await recoverAuthorizationAddress({ authorization: tx.authorizationList[0] })).toLowerCase() !== wallet.toLowerCase()) throw new Error();
  } catch { throw new LedgerSigningError('invalid-signature'); }
}

function rejectedOnDevice(error: unknown): boolean {
  const seen = new Set<object>();
  let current = error;
  try {
    for (let depth = 0; depth < 5 && object(current) && !seen.has(current); depth++) {
      seen.add(current);
      if ([current._tag, current.tag, current.name].includes('RefusedByUserDAError')) return true;
      const code = current.errorCode;
      if ((typeof code === 'string' && ['5501', '6985', '6982'].includes(code.toLowerCase().replace(/^0x/, ''))) ||
          (typeof code === 'number' && [0x5501, 0x6985, 0x6982].includes(code))) return true;
      current = current.originalError ?? current.cause;
    }
  } catch { /* Never reflect device error contents. */ }
  return false;
}

function abortError(signal: AbortSignal): LedgerSigningError {
  return signal.reason instanceof LedgerSigningError ? signal.reason : new LedgerSigningError('cancelled');
}
function active(signal: AbortSignal): void { if (signal.aborted) throw abortError(signal); }

function completedSignature(action: LedgerAddressAction, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let subscription: Subscription | undefined;
    let settled = false;
    const finish = (error?: LedgerSigningError, output?: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      if (error) { try { action.cancel(); } catch { /* The owned session also closes. */ } }
      subscription?.unsubscribe();
      if (error) reject(error); else resolve(output);
    };
    const abort = () => finish(abortError(signal));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    try {
      subscription = action.observable.subscribe({
        next: state => {
          if (settled) return;
          if (!object(state) || typeof state.status !== 'string') { finish(new LedgerSigningError('unavailable')); return; }
          if (state.status === 'completed') finish(undefined, state.output);
          else if (state.status === 'error') finish(new LedgerSigningError(rejectedOnDevice(state.error) ? 'rejected' : 'unavailable'));
          else if (state.status === 'stopped') finish(new LedgerSigningError('cancelled'));
          else if (state.status === 'pending') {
            const pending = state.intermediateValue;
            // The SDK can retry a failed clear-signing command with basic signing.
            // Refuse that second attempt; absence of this step is not clear-signing proof.
            if (object(pending) && pending.step === 'signer.eth.steps.blindSignTransactionFallback') {
              finish(new LedgerSigningError('unsupported'));
            }
          } else if (state.status !== 'not-started') finish(new LedgerSigningError('unavailable'));
        },
        error: error => finish(new LedgerSigningError(rejectedOnDevice(error) ? 'rejected' : 'unavailable')),
        complete: () => { if (!settled) finish(new LedgerSigningError('unavailable')); },
      });
      // Synchronous fixture/final emissions can arrive before subscribe() returns.
      if (settled) subscription.unsubscribe();
    } catch { finish(new LedgerSigningError('unavailable')); }
  });
}

/** Compare all prepared fields and recover both signatures before returning bytes. */
export async function verifiedLedgerTransaction(output: unknown, wallet: Address, tx: PreparedTransaction): Promise<Hex> {
  try {
    const prepared = preparedLedgerTransaction(tx);
    await requireAuthorizationWallet(prepared, wallet);
    let serialized: Hex;
    if (prepared.type === 'legacy') {
      if (!object(output) || Object.keys(output).some(key => !['r', 's', 'v'].includes(key)) ||
          (output.v !== 9361 && output.v !== 9362)) throw new Error();
      serialized = serializeTransaction(prepared, { ...signatureScalars(output), v: BigInt(output.v) });
    } else serialized = serializeTransaction(prepared, sdkParity(output));
    const decoded = parseTransaction(serialized);
    if (decoded.type !== prepared.type || decoded.chainId !== prepared.chainId || (decoded.nonce ?? 0) !== prepared.nonce ||
        decoded.gas !== prepared.gas || (decoded.value ?? 0n) !== prepared.value ||
        decoded.to?.toLowerCase() !== prepared.to.toLowerCase() || (decoded.data ?? '0x').toLowerCase() !== prepared.data.toLowerCase()) throw new Error();
    if (prepared.type === 'legacy') {
      if (decoded.gasPrice !== prepared.gasPrice) throw new Error();
    } else {
      if (decoded.type !== 'eip7702' || decoded.maxFeePerGas !== prepared.maxFeePerGas || decoded.maxPriorityFeePerGas !== prepared.maxPriorityFeePerGas ||
          (decoded.accessList?.length ?? 0) !== 0 || decoded.authorizationList?.length !== 1) throw new Error();
      const expected = prepared.authorizationList[0], actual = preparedSignedAuthorization(decoded.authorizationList[0]);
      for (const key of ['chainId', 'address', 'nonce', 'r', 's', 'yParity'] as const) if (actual[key] !== expected[key]) throw new Error();
    }
    if ((await recoverTransactionAddress({ serializedTransaction: serialized as TransactionSerialized })).toLowerCase() !== wallet.toLowerCase()) throw new Error();
    return serialized;
  } catch { throw new LedgerSigningError('invalid-signature'); }
}

/** Loading a signer reads verified public metadata only; a sign call owns one device flow. */
export async function ledgerSigner(wallet: Address, options: LedgerSigningOptions = {}) {
  const rootDir = options.rootDir ?? portfolioRoot();
  let selected: Address;
  try { selected = getAddress(wallet); await findLedgerAccount(rootDir, selected); }
  catch { throw new LedgerSigningError('account-mismatch'); }
  const timeoutMs = options.timeoutMs ?? MAX_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) throw new LedgerSigningError('invalid-transaction');
  const sign = async <T>(capability: 'signTransaction' | 'signDelegationAuthorization', action: (device: LedgerDevice, path: string) => LedgerAddressAction, verify: (output: unknown) => Promise<T>): Promise<T> => {
    const diagnostics = new LedgerDiagnostics();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new LedgerSigningError('timeout')), timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    try {
      active(signal);
      const result = await withLedgerDevice(rootDir, signal, async device => {
        let account;
        diagnostics.phase('account-binding');
        try { account = await findLedgerAccount(rootDir, selected); }
        catch { throw new LedgerSigningError('account-mismatch'); }
        active(signal);
        if (typeof device[capability] !== 'function') throw new LedgerSigningError('unavailable');
        diagnostics.phase('anchor-read');
        const anchor = await completedAddress(diagnostics.observe(device.getAddress(ANCHOR_PATH, readOptions)), signal);
        if (fingerprint(anchor) !== account.fingerprint) throw new LedgerSigningError('account-mismatch');
        diagnostics.phase('account-read');
        const derived = await completedAddress(diagnostics.observe(device.getAddress(account.derivationPath, readOptions)), signal);
        if (derived.toLowerCase() !== selected.toLowerCase()) throw new LedgerSigningError('account-mismatch');
        active(signal);
        diagnostics.phase('sign');
        const signature = await completedSignature(diagnostics.observe(action(device, account.derivationPath)), signal);
        active(signal);
        diagnostics.phase('final-anchor-read');
        const finalAnchor = await completedAddress(diagnostics.observe(device.getAddress(ANCHOR_PATH, readOptions)), signal);
        if (fingerprint(finalAnchor) !== account.fingerprint) throw new LedgerSigningError('account-mismatch');
        active(signal);
        diagnostics.phase('signature-validation');
        const serialized = await verify(signature);
        active(signal);
        diagnostics.phase('cleanup');
        return serialized;
      }, options);
      active(signal);
      return result;
    } catch (error) {
      const result = signal.aborted ? abortError(signal) : error instanceof LedgerSigningError ? error : new LedgerSigningError('unavailable');
      throw new LedgerSigningError(result.outcome, diagnostics.snapshot(error));
    } finally { clearTimeout(timer); }
  };
  return { address: selected,
    signTransaction: async (tx: PreparedTransaction): Promise<Hex> => {
      const prepared = preparedLedgerTransaction(tx);
      await requireAuthorizationWallet(prepared, selected);
      return sign('signTransaction', (device, path) => {
        if (!device.signTransaction) throw new LedgerSigningError('unavailable');
        return device.signTransaction(path, hexToBytes(serializeTransaction(prepared)));
      }, output => verifiedLedgerTransaction(output, selected, prepared));
    },
    signDelegationAuthorization: async (request: CaliburAuthorizationRequest): Promise<SignedAuthorization<number>> => {
      const prepared = preparedLedgerAuthorization(request);
      return sign('signDelegationAuthorization', (device, path) => {
        if (!device.signDelegationAuthorization) throw new LedgerSigningError('unavailable');
        return device.signDelegationAuthorization(path, prepared.chainId, prepared.address, prepared.nonce);
      }, output => verifiedLedgerAuthorization(output, selected, prepared));
    },
  };
}
