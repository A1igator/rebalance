import { createHash } from 'node:crypto';
import type { Subscription } from 'rxjs';
import { getAddress, hexToBytes, isAddress, parseTransaction, recoverTransactionAddress, serializeTransaction,
  type Address, type Hex } from 'viem';
import { portfolioRoot } from '../scripts/profile-routing.mjs';
import { completedAddress, findLedgerAccount, withLedgerDevice,
  type LedgerAddressAction, type LedgerOnboardingDependencies } from './ledger-onboarding.js';
import type { PreparedTransaction } from './privy.js';

export type LedgerSigningOutcome = 'rejected' | 'cancelled' | 'timeout' | 'unavailable' |
  'account-mismatch' | 'invalid-transaction' | 'invalid-signature' | 'unsupported';
const MESSAGES: Record<LedgerSigningOutcome, string> = {
  rejected: 'Action cancelled on the Ledger. A new request is needed before another signing attempt.',
  cancelled: 'Ledger signing was cancelled. No transaction was broadcast.',
  timeout: 'Ledger signing timed out. Connect and unlock the device, open Ethereum, then request a fresh transaction.',
  unavailable: 'Ledger signing could not complete. Check the device and Ethereum app, then request a fresh transaction.',
  'account-mismatch': 'The verified Ledger account does not match the selected wallet. No fallback account was used.',
  'invalid-transaction': 'The prepared Ledger transaction is invalid. No transaction was signed.',
  'invalid-signature': 'Ledger returned an invalid signature or one for a different account or transaction. No transaction was broadcast.',
  unsupported: 'Ledger requested a signing fallback. Review the device display support before making a new request.',
};
export class LedgerSigningError extends Error {
  override name = 'LedgerSigningError';
  constructor(readonly outcome: LedgerSigningOutcome) { super(MESSAGES[outcome]); }
}
export type LedgerSigningOptions = LedgerOnboardingDependencies & { rootDir?: string; signal?: AbortSignal };
const MAX_TIMEOUT_MS = 120_000;
const ANCHOR_PATH = "44'/60'/0'/0/0";
const CURVE_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const readOptions = { checkOnDevice: false, returnChainCode: false } as const;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const fingerprint = (wallet: Address) => createHash('sha256').update(wallet.toLowerCase()).digest('hex');

/** Preserve the exact prepared payload across every asynchronous device step. */
export function preparedLedgerTransaction(tx: PreparedTransaction): PreparedTransaction {
  if (!tx || Object.keys(tx).some(key => !['chainId', 'type', 'nonce', 'gas', 'gasPrice', 'to', 'data', 'value'].includes(key)) || tx.chainId !== 4663 || tx.type !== 'legacy' || !Number.isSafeInteger(tx.nonce) || tx.nonce < 0 ||
      ![tx.gas, tx.gasPrice, tx.value].every(n => typeof n === 'bigint' && n >= 0n && n < 2n ** 256n) ||
      tx.gas === 0n || tx.gasPrice === 0n || !isAddress(tx.to, { strict: false }) ||
      typeof tx.data !== 'string' || !/^0x(?:[a-fA-F0-9]{2})*$/.test(tx.data)) {
    throw new LedgerSigningError('invalid-transaction');
  }
  return Object.freeze({ chainId: 4663, type: 'legacy', nonce: tx.nonce, gas: tx.gas, gasPrice: tx.gasPrice,
    to: getAddress(tx.to), data: tx.data, value: tx.value });
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

/** The pinned SDK already expands legacy v to EIP-155; accept only this chain's v. */
export async function verifiedLedgerTransaction(output: unknown, wallet: Address, tx: PreparedTransaction): Promise<Hex> {
  try {
    const prepared = preparedLedgerTransaction(tx);
    if (!object(output) || Object.keys(output).some(key => !['r', 's', 'v'].includes(key)) ||
        typeof output.r !== 'string' || !/^0x[a-fA-F0-9]{64}$/.test(output.r) ||
        typeof output.s !== 'string' || !/^0x[a-fA-F0-9]{64}$/.test(output.s) ||
        (output.v !== 9361 && output.v !== 9362)) throw new Error();
    const r = BigInt(output.r), s = BigInt(output.s);
    if (r <= 0n || r >= CURVE_ORDER || s <= 0n || s > CURVE_ORDER / 2n) throw new Error();
    const serialized = serializeTransaction(prepared, { r: output.r as Hex, s: output.s as Hex, v: BigInt(output.v) });
    const decoded = parseTransaction(serialized);
    if (decoded.type !== prepared.type || decoded.chainId !== prepared.chainId || (decoded.nonce ?? 0) !== prepared.nonce ||
        decoded.gas !== prepared.gas || decoded.gasPrice !== prepared.gasPrice || (decoded.value ?? 0n) !== prepared.value ||
        decoded.to?.toLowerCase() !== prepared.to.toLowerCase() || (decoded.data ?? '0x').toLowerCase() !== prepared.data.toLowerCase() ||
        (await recoverTransactionAddress({ serializedTransaction: serialized })).toLowerCase() !== wallet.toLowerCase()) throw new Error();
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
  return { address: selected, signTransaction: async (tx: PreparedTransaction): Promise<Hex> => {
    const prepared = preparedLedgerTransaction(tx);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new LedgerSigningError('timeout')), timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    try {
      active(signal);
      const result = await withLedgerDevice(rootDir, signal, async device => {
        let account;
        try { account = await findLedgerAccount(rootDir, selected); }
        catch { throw new LedgerSigningError('account-mismatch'); }
        active(signal);
        if (!device.signTransaction) throw new LedgerSigningError('unavailable');
        const anchor = await completedAddress(device.getAddress(ANCHOR_PATH, readOptions), signal);
        if (fingerprint(anchor) !== account.fingerprint) throw new LedgerSigningError('account-mismatch');
        const derived = await completedAddress(device.getAddress(account.derivationPath, readOptions), signal);
        if (derived.toLowerCase() !== selected.toLowerCase()) throw new LedgerSigningError('account-mismatch');
        active(signal);
        const signature = await completedSignature(device.signTransaction(account.derivationPath, hexToBytes(serializeTransaction(prepared))), signal);
        active(signal);
        const finalAnchor = await completedAddress(device.getAddress(ANCHOR_PATH, readOptions), signal);
        if (fingerprint(finalAnchor) !== account.fingerprint) throw new LedgerSigningError('account-mismatch');
        active(signal);
        const serialized = await verifiedLedgerTransaction(signature, selected, prepared);
        active(signal);
        return serialized;
      }, options);
      active(signal);
      return result;
    } catch (error) {
      if (signal.aborted) throw abortError(signal);
      if (error instanceof LedgerSigningError) throw error;
      throw new LedgerSigningError('unavailable');
    } finally { clearTimeout(timer); }
  } };
}
