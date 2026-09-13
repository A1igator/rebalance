import { encodeFunctionData, getAddress, keccak256, parseAbi, type Address, type Hex } from 'viem';

/** Uniswap Calibur v1.1.0 on Robinhood mainnet; see docs/CALIBUR.md. */
export const CALIBUR_ADDRESS = '0x000000005c84F8Fd50b21CAC312528A64437030e' as const;
export const CALIBUR_RUNTIME_CODE_HASH = '0xba697585ba58ba66ebd095ab4c7f980ed42ad115b2e3bb9b5b9bdf167bf08b1b' as const;
export const CALIBUR_RUNTIME_CODE_SIZE = 22_020;
export const CALIBUR_DELEGATION_CODE = `0xef0100${CALIBUR_ADDRESS.slice(2).toLowerCase()}` as Hex;
export const CALIBUR_ABI = parseAbi([
  'function execute(((address to, uint256 value, bytes data)[] calls, bool revertOnFailure) batchedCall) payable',
]);
export type CaliburCall = Readonly<{ to: Address; value: bigint; data: Hex }>;

const bytes = (value: unknown): value is Hex => typeof value === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(value);
const address = (value: unknown): value is Address => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value) && !/^0x0{40}$/.test(value);

/** The deployed implementation must be the exact verified runtime, not just code at an address. */
export function assertCaliburDeployment(code: Hex | undefined): void {
  if (!bytes(code) || code.length !== CALIBUR_RUNTIME_CODE_SIZE * 2 + 2 || keccak256(code) !== CALIBUR_RUNTIME_CODE_HASH) {
    throw new Error('The canonical Calibur deployment does not match the pinned runtime');
  }
}

/** viem getCode returns undefined for an empty 0x response. No other code or delegate is adopted. */
export function inspectCaliburAccountCode(code: Hex | undefined): 'undelegated' | 'calibur' {
  if (code === undefined || code === '0x') return 'undelegated';
  if (bytes(code) && code.toLowerCase() === CALIBUR_DELEGATION_CODE) return 'calibur';
  throw new Error('The wallet has unsupported account code or a different delegation');
}

/** Pure encoding only. The execution boundary separately validates exact configured
 * token approvals followed by the canonical router call against the fresh plan. */
export function encodeCaliburBatch(calls: readonly CaliburCall[]): Hex {
  if (!Array.isArray(calls) || calls.length < 1 || calls.length > 5) throw new Error('Calibur requires one to five bounded calls');
  const copied = calls.map(call => {
    if (!call || typeof call !== 'object' || Object.keys(call).some(key => !['to', 'value', 'data'].includes(key))) {
      throw new Error('Invalid Calibur call');
    }
    const { to, value, data } = call;
    if (!address(to) || value !== 0n || !bytes(data) || data.length < 10) throw new Error('Invalid Calibur call');
    return { to: getAddress(to), value: 0n, data };
  });
  return encodeFunctionData({ abi: CALIBUR_ABI, functionName: 'execute', args: [{ calls: copied, revertOnFailure: true }] });
}

/** Self-funding preserves the existing wallet as caller, recipient and gas payer. */
export function buildCaliburSelfTransaction(wallet: Address, calls: readonly CaliburCall[]): { to: Address; value: 0n; data: Hex } {
  if (!address(wallet) || wallet.toLowerCase() === CALIBUR_ADDRESS.toLowerCase()) throw new Error('Calibur requires the portfolio wallet as its execution target');
  return { to: getAddress(wallet), value: 0n, data: encodeCaliburBatch(calls) };
}
