import { GAS_REFERENCE } from './gas-reference.js';
import { ETH_USD_SPOT_URL } from './gas-display.js';

const MAX_UINT256 = (1n << 256n) - 1n;
const WEI_PER_ETH = 10n ** 18n;
const TIMEOUT_MS = 4_000;
const MAX_RESPONSE_BYTES = 16_384;

export type FeeCheck = {
  targetUsdE8: string;
  estimatedUsdE8: string | null;
  gasPriceWei: string | null;
  ethUsdE8: string | null;
  /** Local response observation time; Coinbase spot does not supply a market timestamp. */
  observedAt: string | null;
  state: 'within-target' | 'above-target' | 'unavailable';
};
export type FeeTargetInput = {
  targetUsdE8: string;
  /** Remaining planner swaps, including the swap associated with this transaction. */
  swaps: number;
  kind: 'swap' | 'approval';
  /** Inner swaps already covered by this transaction's actual gas estimate. */
  swapsInCurrentTransaction?: number;
  /** Required future approval transactions, excluding this transaction. */
  remainingApprovals?: number;
  /** Current transaction gas and gas price already contain dispatch's 20% buffer. */
  gas: bigint;
  gasPrice: bigint;
};
export type FeeTargetDependencies = { fetch: typeof globalThis.fetch; now: () => number; timeoutMs: number };

export class FeeTargetError extends Error {
  readonly check: FeeCheck;
  constructor(check: FeeCheck) {
    super(check.state === 'above-target'
      ? 'Estimated rebalance network fees are above the configured target; waiting for lower fees.'
      : 'A fresh rebalance network-fee estimate is unavailable; waiting to retry.');
    this.name = 'FeeTargetError';
    this.check = Object.freeze({ ...check });
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid fee quote');
  return value as Record<string, unknown>;
}
function ethUsdPrice(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,11})(?:\.\d{1,8})?$/.test(value)) throw new Error('Invalid fee quote');
  const [whole, fraction = ''] = value.split('.');
  const amount = BigInt(whole) * 100_000_000n + BigInt(fraction.padEnd(8, '0'));
  if (amount <= 0n) throw new Error('Invalid fee quote');
  return amount;
}
function validate(input: FeeTargetInput): bigint {
  if (!input || typeof input.targetUsdE8 !== 'string' || !/^(?:0|[1-9]\d{0,77})$/.test(input.targetUsdE8) ||
      !Number.isInteger(input.swaps) || input.swaps < 1 || input.swaps > 16 ||
      !['swap', 'approval'].includes(input.kind) || typeof input.gas !== 'bigint' || input.gas <= 0n || input.gas > MAX_UINT256 ||
      typeof input.gasPrice !== 'bigint' || input.gasPrice <= 0n || input.gasPrice > MAX_UINT256) {
    throw new Error('Invalid rebalance fee-target inputs');
  }
  const included = input.swapsInCurrentTransaction ?? (input.kind === 'swap' ? 1 : 0);
  const approvals = input.remainingApprovals ?? input.swaps - 1;
  if (!Number.isInteger(included) || included < 0 || included > input.swaps ||
      (input.kind === 'approval' ? included !== 0 : included < 1) ||
      !Number.isInteger(approvals) || approvals < 0 || approvals > 16) {
    throw new Error('Invalid rebalance batch fee counts');
  }
  const target = BigInt(input.targetUsdE8);
  if (target > MAX_UINT256) throw new Error('Invalid rebalance fee-target inputs');
  return target;
}

async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.ok || !response.body || signal.aborted) {
    await response.body?.cancel().catch(() => {});
    throw new Error('Fee quote unavailable');
  }
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error('Fee quote too large');
      chunks.push(value);
    }
    signal.throwIfAborted();
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
  }
}

/**
 * Fresh execution-specific estimate; never reads the cached display quote. Uses
 * actual buffered gas for this entire transaction, measured reference gas +20%
 * for uncovered swap legs, and required/conservative future approvals. Current
 * gas price applies throughout. This is an approximation, not a spend budget,
 * a fee guarantee, or an estimate of swap fees/slippage.
 */
export async function checkRebalanceFee(input: FeeTargetInput, overrides: Partial<FeeTargetDependencies> = {}): Promise<FeeCheck> {
  const target = validate(input);
  const dependencies: FeeTargetDependencies = { fetch: globalThis.fetch, now: Date.now, timeoutMs: TIMEOUT_MS, ...overrides };
  if (!Number.isFinite(dependencies.timeoutMs) || dependencies.timeoutMs <= 0 || dependencies.timeoutMs > TIMEOUT_MS ||
      typeof dependencies.fetch !== 'function' || typeof dependencies.now !== 'function') throw new Error('Invalid rebalance fee-quote dependencies');
  const check: FeeCheck = { targetUsdE8: input.targetUsdE8, estimatedUsdE8: null, gasPriceWei: input.gasPrice.toString(),
    ethUsdE8: null, observedAt: null, state: 'unavailable' };
  const remainingSwaps = BigInt(input.swaps - (input.swapsInCurrentTransaction ?? (input.kind === 'swap' ? 1 : 0)));
  const remainingApprovals = BigInt(input.remainingApprovals ?? input.swaps - 1);
  const bufferedSwapGas = (BigInt(GAS_REFERENCE.swapGas) * 120n + 99n) / 100n;
  const bufferedApprovalGas = (BigInt(GAS_REFERENCE.approvalGas) * 120n + 99n) / 100n;
  const estimatedWei = (input.gas + remainingSwaps * bufferedSwapGas + remainingApprovals * bufferedApprovalGas) * input.gasPrice;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const startedAt = dependencies.now();
    if (!Number.isSafeInteger(startedAt) || startedAt < 0) return check;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('Fee quote timed out')); }, dependencies.timeoutMs);
    });
    const quote = await Promise.race([
      dependencies.fetch(ETH_USD_SPOT_URL, { signal: controller.signal, redirect: 'error', credentials: 'omit',
        cache: 'no-store', headers: { accept: 'application/json' } }).then(response => boundedJson(response, controller.signal)),
      timeout,
    ]);
    const data = object(object(quote).data);
    if (data.base !== 'ETH' || data.currency !== 'USD') return check;
    const ethUsdE8 = ethUsdPrice(data.amount);
    const observedAt = dependencies.now();
    // Never treat delayed local work or a backward clock as a fresh observation.
    if (!Number.isSafeInteger(observedAt) || observedAt < startedAt || observedAt - startedAt > dependencies.timeoutMs) return check;
    const estimatedUsdE8 = (estimatedWei * ethUsdE8 + WEI_PER_ETH - 1n) / WEI_PER_ETH;
    return { ...check, estimatedUsdE8: estimatedUsdE8.toString(), ethUsdE8: ethUsdE8.toString(),
      observedAt: new Date(observedAt).toISOString(), state: estimatedUsdE8 <= target ? 'within-target' : 'above-target' };
  } catch { return check; }
  finally { if (timer !== undefined) clearTimeout(timer); controller.abort(); }
}
