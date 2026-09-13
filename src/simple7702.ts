import { encodeFunctionData, getAddress, keccak256, parseAbi, type Address, type Hex } from 'viem';

/** Canonical Ledger-allowed Simple7702Account artifact; public provenance is retained separately. */
export const SIMPLE7702_ADDRESS = '0x4Cd241E8d1510e30b2076397afc7508Ae59C66c9' as const;
export const SIMPLE7702_RUNTIME_CODE_HASH = '0x82c1e6c0f83d22eef579344e8eff26baf24db4dabe5408d681b00d0512bc3ec4' as const;
export const SIMPLE7702_RUNTIME_CODE_SIZE = 3_639;
export const SIMPLE7702_DELEGATION_CODE = `0xef0100${SIMPLE7702_ADDRESS.slice(2).toLowerCase()}` as Hex;
export const SIMPLE7702_ABI = parseAbi(['function executeBatch((address target,uint256 value,bytes data)[] calls)']);
export type Simple7702Call = Readonly<{ to: Address; value: bigint; data: Hex }>;
const bytes = (value: unknown): value is Hex => typeof value === 'string' && /^0x(?:[a-fA-F0-9]{2})*$/.test(value);
const address = (value: unknown): value is Address => typeof value === 'string' && /^0x[a-fA-F0-9]{40}$/.test(value) && !/^0x0{40}$/.test(value);

export function assertSimple7702Deployment(code: Hex | undefined): void {
  if (!bytes(code) || code.length !== SIMPLE7702_RUNTIME_CODE_SIZE * 2 + 2 || keccak256(code) !== SIMPLE7702_RUNTIME_CODE_HASH) {
    throw new Error('The canonical Simple7702Account deployment does not match the pinned runtime');
  }
}
export function inspectSimple7702AccountCode(code: Hex | undefined): 'undelegated' | 'simple7702' {
  if (code === undefined || code === '0x') return 'undelegated';
  if (bytes(code) && code.toLowerCase() === SIMPLE7702_DELEGATION_CODE) return 'simple7702';
  throw new Error('The wallet has unsupported account code or a different delegation');
}
export function encodeSimple7702Batch(calls: readonly Simple7702Call[]): Hex {
  if (!Array.isArray(calls) || calls.length < 1 || calls.length > 5) throw new Error('Simple7702Account requires one to five bounded calls');
  const copied = calls.map(call => {
    if (!call || typeof call !== 'object' || Object.keys(call).some(key => !['to', 'value', 'data'].includes(key))) throw new Error('Invalid Simple7702Account call');
    if (!address(call.to) || call.value !== 0n || !bytes(call.data) || call.data.length < 10) throw new Error('Invalid Simple7702Account call');
    return { target: getAddress(call.to), value: 0n, data: call.data };
  });
  return encodeFunctionData({ abi: SIMPLE7702_ABI, functionName: 'executeBatch', args: [copied] });
}
function selfTarget(wallet: Address): Address {
  if (!address(wallet) || wallet.toLowerCase() === SIMPLE7702_ADDRESS.toLowerCase()) throw new Error('Simple7702Account requires the portfolio wallet as its execution target');
  return getAddress(wallet);
}
export function buildSimple7702SelfTransaction(wallet: Address, calls: readonly Simple7702Call[]): { to: Address; value: 0n; data: Hex } {
  return { to: selfTarget(wallet), value: 0n, data: encodeSimple7702Batch(calls) };
}
export function buildSimple7702SetupTransaction(wallet: Address): { to: Address; value: 0n; data: Hex } {
  return { to: selfTarget(wallet), value: 0n, data: encodeFunctionData({ abi: SIMPLE7702_ABI, functionName: 'executeBatch', args: [[]] }) };
}
