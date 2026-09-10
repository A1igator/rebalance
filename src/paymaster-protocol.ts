import {
  concatHex, decodeFunctionData, encodeFunctionData, getAddress, hashMessage,
  parseAbi, recoverAddress, recoverMessageAddress, toHex,
  type Address, type Hex,
} from 'viem';
import { getUserOperationHash, type UserOperation } from 'viem/account-abstraction';
import { hashAuthorization } from 'viem/utils';

// Narrow Wallet API v070 / SemiModularAccount7702 v1.1 protocol. No networking or signing.
// Sources: alchemy.com/docs/wallets/transactions/{using-eip-7702,pay-gas-with-any-token}
// and alchemyplatform/aa-sdk packages/{wallet-apis/src/actions/signPreparedCalls.ts,
// smart-accounts/src/ma-v2/accounts/{base.ts,calldataCodec.ts}}.
export const PAYMASTER_CHAIN_ID = 4663;
export const PAYMASTER_USDG = getAddress('0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168');
export const PAYMASTER_ENTRY_POINT = getAddress('0x0000000071727De22E5E9d8BAf0edAc6f37da032');
export const PAYMASTER_DELEGATE = getAddress('0x77021100bD87b7008E5E1989d0eB38555d0d0000');
// Wallet API nonceOverride.nonceKey=0 selects owner entity 0, global validation 1.
// The EntryPoint key is (override << 40) | (entityId << 8) | globalValidation.
export const PAYMASTER_NONCE_KEY = 1n;
export const PAYMASTER_ACCOUNT_ID = 'alchemy.sma-7702.1.1.0';
export const PAYMASTER_CHAIN_HEX = toHex(PAYMASTER_CHAIN_ID);
export const PAYMASTER_ACCOUNT_ABI = parseAbi([
  'function execute(address target, uint256 value, bytes data) payable',
  'function executeBatch((address target, uint256 value, bytes data)[] calls) payable',
]);
const APPROVE_ABI = parseAbi(['function approve(address spender, uint256 amount) returns (bool)']);
const EXECUTE_USER_OP_SELECTOR = '0x8dd7712f';
const MAX_CALL_BYTES = 65_536;
const MAX_CALLS = 16;
const UINT256 = (1n << 256n) - 1n;
const HALF_CURVE_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export type PaymasterCall = Readonly<{ to: Address; data: Hex; value: bigint }>;
export type PaymasterVerificationContext = {
  wallet: Address;
  calls: readonly PaymasterCall[];
  paymaster: Address;
  paymasterAllowance: bigint;
  userOperationNonce: bigint;
  authorizationNonce?: number;
  requireAuthorization: boolean;
  onlyEstimation?: boolean;
};
export type PaymasterOperationData = Readonly<{
  sender: Address; nonce: Hex; callData: Hex;
  callGasLimit: Hex; verificationGasLimit: Hex; preVerificationGas: Hex;
  maxFeePerGas: Hex; maxPriorityFeePerGas: Hex;
  paymaster: Address; paymasterData: Hex;
  paymasterVerificationGasLimit: Hex; paymasterPostOpGasLimit: Hex;
}>;
export type VerifiedPaymasterAuthorization = Readonly<{
  chainId: typeof PAYMASTER_CHAIN_ID;
  address: Address;
  nonce: number;
  hash: Hex;
}>;
export type VerifiedPaymasterPreparation = Readonly<{
  wallet: Address;
  userOperation: Readonly<UserOperation<'0.7'>>;
  userOperationHash: Hex;
  personalSignHash: Hex;
  callId: Hex;
  feeTokenAmount: bigint;
  feeApprovalInjected: boolean;
  authorization?: VerifiedPaymasterAuthorization;
  calls: readonly PaymasterCall[];
  operation: PaymasterOperationData;
  signingRequired: boolean;
}>;
export type SignedPreparedUserOperation = {
  type: 'user-operation-v070'; data: PaymasterOperationData; chainId: Hex;
  signature: { type: 'secp256k1'; data: Hex };
};
export type SignedPreparedAuthorization = {
  type: 'authorization'; data: { address: Address; nonce: Hex }; chainId: Hex;
  signature: { type: 'secp256k1'; data: Hex };
};
export type SignedPreparedCalls = SignedPreparedUserOperation | {
  type: 'array'; data: [SignedPreparedAuthorization, SignedPreparedUserOperation];
};

export class PaymasterProtocolError extends Error {
  readonly code = 'PAYMASTER_PROTOCOL_INVALID';
  constructor(reason: string) { super(`Paymaster response rejected: ${reason}.`); this.name = 'PaymasterProtocolError'; }
}
function reject(reason: string): never { throw new PaymasterProtocolError(reason); }
function record(value: unknown, reason: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) reject(reason);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  if (required.some((key) => !Object.hasOwn(value, key)) ||
      Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) reject('unsupported object fields');
}
function bytes(value: unknown, maxBytes = MAX_CALL_BYTES, exactBytes?: number): Hex {
  if (typeof value !== 'string' || value.length > 2 + maxBytes * 2 || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value) ||
      (exactBytes !== undefined && value.length !== 2 + exactBytes * 2)) reject('invalid byte string');
  return value.toLowerCase() as Hex;
}
function address(value: unknown): Address {
  const parsed = bytes(value, 20, 20);
  return getAddress(parsed);
}
function equalAddress(a: Address, b: Address): boolean { return a.toLowerCase() === b.toLowerCase(); }
function quantity(value: unknown, bits = 256, positive = false): bigint {
  if (typeof value !== 'string' || value.length > 2 + Math.ceil(bits / 4) || !/^0x[0-9a-fA-F]+$/.test(value)) reject('invalid quantity');
  const result = BigInt(value);
  if (result >= (1n << BigInt(bits)) || (positive && result === 0n)) reject('invalid quantity');
  return result;
}
function nativeQuantity(value: unknown): bigint {
  if (typeof value !== 'bigint' || value < 0n || value > UINT256) reject('invalid verification context');
  return value;
}
function chain(value: unknown): void {
  if (quantity(value, 64) !== BigInt(PAYMASTER_CHAIN_ID)) reject('unexpected chain');
}
function expectedCalls(value: readonly PaymasterCall[], wallet: Address): readonly PaymasterCall[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_CALLS) reject('invalid requested calls');
  return Object.freeze(value.map((call) => {
    const item = record(call, 'invalid requested call');
    keys(item, ['to', 'data', 'value']);
    const to = address(item.to);
    // This adapter never installs modules, changes delegation, or manipulates the account itself.
    if (equalAddress(to, wallet) || equalAddress(to, PAYMASTER_ENTRY_POINT) || equalAddress(to, PAYMASTER_DELEGATE)) reject('account management call');
    return Object.freeze({ to, data: bytes(item.data), value: nativeQuantity(item.value) });
  }));
}
function callsEqual(a: readonly PaymasterCall[], b: readonly PaymasterCall[]): boolean {
  return a.length === b.length && a.every((call, index) => {
    const other = b[index]!;
    return equalAddress(call.to, other.to) && call.data === other.data && call.value === other.value;
  });
}
function decodedCalls(callData: Hex): readonly PaymasterCall[] {
  // The account may prepend executeUserOp when validation has execution hooks.
  const data = callData.startsWith(EXECUTE_USER_OP_SELECTOR)
    ? (`0x${callData.slice(EXECUTE_USER_OP_SELECTOR.length)}` as Hex) : callData;
  try {
    const decoded = decodeFunctionData({ abi: PAYMASTER_ACCOUNT_ABI, data });
    const encoded = encodeFunctionData({ abi: PAYMASTER_ACCOUNT_ABI, ...decoded });
    if (encoded.toLowerCase() !== data) reject('noncanonical account calldata');
    const values = decoded.functionName === 'execute'
      ? [{ target: decoded.args[0], value: decoded.args[1], data: decoded.args[2] }]
      : decoded.args[0];
    if (values.length < 1 || values.length > MAX_CALLS + 1) reject('unexpected call count');
    return Object.freeze(values.map((call) => Object.freeze({ to: address(call.target), data: bytes(call.data), value: call.value })));
  } catch (error) {
    if (error instanceof PaymasterProtocolError) throw error;
    reject('unsupported account calldata');
  }
}
function verifyDetails(value: unknown, userOperationHash: Hex): void {
  if (value === undefined) return;
  const details = record(value, 'invalid operation details');
  keys(details, ['type', 'data']);
  if (details.type !== 'user-operation') reject('unsupported operation details');
  const data = record(details.data, 'invalid operation details');
  keys(data, ['hash', 'calls']);
  if (bytes(data.hash, 32, 32) !== userOperationHash) reject('operation detail hash mismatch');
  // Descriptive calls are not authoritative and are never forwarded. Actual callData is decoded above.
  if (!Array.isArray(data.calls) || data.calls.length > MAX_CALLS + 1) reject('invalid operation details');
}
const verifiedInstances = new WeakSet<VerifiedPaymasterPreparation>();

/** Verify a raw JSON-RPC result, against independently read account/allowance/nonces. */
export function verifyPreparedCalls(value: unknown, context: PaymasterVerificationContext): VerifiedPaymasterPreparation {
  const wallet = address(context.wallet);
  const paymaster = address(context.paymaster);
  if (paymaster === ZERO_ADDRESS || equalAddress(paymaster, wallet) || equalAddress(paymaster, PAYMASTER_USDG)) reject('invalid paymaster context');
  const allowance = nativeQuantity(context.paymasterAllowance);
  const nonce = nativeQuantity(context.userOperationNonce);
  if (nonce >> 64n !== PAYMASTER_NONCE_KEY) reject('unsupported nonce lane');
  if (typeof context.requireAuthorization !== 'boolean' || (context.onlyEstimation !== undefined && typeof context.onlyEstimation !== 'boolean')) reject('invalid verification context');
  const requested = expectedCalls(context.calls, wallet);
  const top = record(value, 'invalid preparation');
  let prepared = top;
  let authorization: VerifiedPaymasterAuthorization | undefined;
  if (context.requireAuthorization) {
    keys(top, ['type', 'data'], ['details']);
    if (top.type !== 'array' || !Array.isArray(top.data) || top.data.length !== 2) reject('authorization and operation required');
    const auth = record(top.data[0], 'invalid authorization');
    keys(auth, ['type', 'data', 'chainId', 'signatureRequest']);
    if (auth.type !== 'authorization') reject('unsupported authorization');
    chain(auth.chainId);
    const authData = record(auth.data, 'invalid authorization data');
    keys(authData, ['address', 'nonce']);
    if (!equalAddress(address(authData.address), PAYMASTER_DELEGATE)) reject('unexpected delegation');
    const authNonce = quantity(authData.nonce, 64);
    if (!Number.isSafeInteger(context.authorizationNonce) || context.authorizationNonce! < 0 ||
        authNonce !== BigInt(context.authorizationNonce!)) reject('authorization nonce mismatch');
    const hash = hashAuthorization({ chainId: PAYMASTER_CHAIN_ID, address: PAYMASTER_DELEGATE, nonce: context.authorizationNonce! });
    const request = record(auth.signatureRequest, 'invalid authorization signing request');
    keys(request, ['type', 'rawPayload']);
    if (request.type !== 'eip7702Auth' || bytes(request.rawPayload, 32, 32) !== hash) reject('authorization signing hash mismatch');
    authorization = Object.freeze({ chainId: PAYMASTER_CHAIN_ID, address: PAYMASTER_DELEGATE, nonce: context.authorizationNonce!, hash });
    prepared = record(top.data[1], 'invalid prepared operation');
  } else if (top.type === 'array') {
    reject('unexpected authorization');
  }
  keys(prepared, ['type', 'data', 'chainId', 'feePayment'], ['signatureRequest', 'details']);
  if (prepared.type !== 'user-operation-v070') reject('unsupported operation type');
  chain(prepared.chainId);
  const raw = record(prepared.data, 'invalid operation data');
  keys(raw, ['sender', 'nonce', 'callData', 'callGasLimit', 'verificationGasLimit', 'preVerificationGas',
    'maxFeePerGas', 'maxPriorityFeePerGas', 'paymaster', 'paymasterData', 'paymasterVerificationGasLimit', 'paymasterPostOpGasLimit']);
  if (!equalAddress(address(raw.sender), wallet) || quantity(raw.nonce) !== nonce) reject('operation identity or nonce mismatch');
  if (!equalAddress(address(raw.paymaster), paymaster)) reject('unexpected paymaster');
  const callData = bytes(raw.callData, MAX_CALL_BYTES * (MAX_CALLS + 1));
  const userOperation: Readonly<UserOperation<'0.7'>> = Object.freeze({
    sender: wallet, nonce, callData,
    callGasLimit: quantity(raw.callGasLimit, 128, true),
    verificationGasLimit: quantity(raw.verificationGasLimit, 128, true),
    preVerificationGas: quantity(raw.preVerificationGas, 256, true),
    maxFeePerGas: quantity(raw.maxFeePerGas, 128, true),
    maxPriorityFeePerGas: quantity(raw.maxPriorityFeePerGas, 128),
    paymaster, paymasterData: bytes(raw.paymasterData, 16_384),
    paymasterVerificationGasLimit: quantity(raw.paymasterVerificationGasLimit, 128, true),
    paymasterPostOpGasLimit: quantity(raw.paymasterPostOpGasLimit, 128),
    signature: '0x',
  });
  if (userOperation.maxPriorityFeePerGas > userOperation.maxFeePerGas) reject('inconsistent gas prices');
  const fee = record(prepared.feePayment, 'missing fee quote');
  keys(fee, ['sponsored', 'tokenAddress', 'maxAmount']);
  if (fee.sponsored !== false || !equalAddress(address(fee.tokenAddress), PAYMASTER_USDG)) reject('unexpected fee payment');
  const feeTokenAmount = quantity(fee.maxAmount, 256, true);
  const calls = decodedCalls(callData);
  const approval: PaymasterCall = {
    to: PAYMASTER_USDG, value: 0n,
    data: encodeFunctionData({ abi: APPROVE_ABI, functionName: 'approve', args: [paymaster, feeTokenAmount] }),
  };
  if (callsEqual(calls, requested)) {
    if (allowance < feeTokenAmount) reject('missing fee token approval');
  } else if (!callsEqual(calls, [approval, ...requested])) {
    reject('prepared calls differ from requested calls');
  }
  const userOperationHash = getUserOperationHash({
    chainId: PAYMASTER_CHAIN_ID, entryPointAddress: PAYMASTER_ENTRY_POINT,
    entryPointVersion: '0.7', userOperation,
  });
  const personalSignHash = hashMessage({ raw: userOperationHash });
  if (prepared.signatureRequest !== undefined) {
    const request = record(prepared.signatureRequest, 'invalid operation signing request');
    keys(request, ['type', 'data', 'rawPayload']);
    if (request.type !== 'personal_sign') reject('unsupported operation signing request');
    const data = record(request.data, 'raw message signing required');
    keys(data, ['raw']);
    if (bytes(data.raw, 32, 32) !== userOperationHash || bytes(request.rawPayload, 32, 32) !== personalSignHash) reject('operation signing hash mismatch');
  } else if (!context.onlyEstimation) reject('missing operation signing request');
  verifyDetails(top.details, userOperationHash);
  if (prepared !== top) verifyDetails(prepared.details, userOperationHash);
  const operation: PaymasterOperationData = Object.freeze({
    sender: wallet, nonce: toHex(nonce), callData,
    callGasLimit: toHex(userOperation.callGasLimit), verificationGasLimit: toHex(userOperation.verificationGasLimit),
    preVerificationGas: toHex(userOperation.preVerificationGas), maxFeePerGas: toHex(userOperation.maxFeePerGas),
    maxPriorityFeePerGas: toHex(userOperation.maxPriorityFeePerGas), paymaster,
    paymasterData: userOperation.paymasterData!,
    paymasterVerificationGasLimit: toHex(userOperation.paymasterVerificationGasLimit!),
    paymasterPostOpGasLimit: toHex(userOperation.paymasterPostOpGasLimit!),
  });
  const result: VerifiedPaymasterPreparation = Object.freeze({
    wallet, userOperation, userOperationHash, personalSignHash,
    callId: concatHex([toHex(PAYMASTER_CHAIN_ID, { size: 32 }), userOperationHash]),
    feeTokenAmount, feeApprovalInjected: calls.length === requested.length + 1,
    ...(authorization ? { authorization } : {}), calls, operation,
    signingRequired: !context.onlyEstimation,
  });
  verifiedInstances.add(result);
  return result;
}
function signature(value: unknown): Hex {
  const data = bytes(value, 65, 65);
  const s = BigInt(`0x${data.slice(66, 130)}`);
  const recovery = Number.parseInt(data.slice(130, 132), 16);
  if (s === 0n || s > HALF_CURVE_ORDER || ![0, 1, 27, 28].includes(recovery)) reject('invalid signature');
  return recovery < 2 ? `${data.slice(0, 130)}${(recovery + 27).toString(16)}` as Hex : data;
}
/** Check signer recovery before returning a canonical RPC params[0]; never signs or sends. */
export async function formatSignedPreparedCalls(
  verified: VerifiedPaymasterPreparation,
  signatures: { userOperation: Hex; authorization?: Hex },
): Promise<SignedPreparedCalls> {
  if (!verifiedInstances.has(verified) || !verified.signingRequired) reject('signable verified preparation required');
  const signatureInput = record(signatures, 'invalid signatures');
  keys(signatureInput, ['userOperation'], ['authorization']);
  if (!verified.authorization && signatureInput.authorization !== undefined) reject('unexpected authorization signature');
  try {
    const operationSignature = signature(signatureInput.userOperation);
    if (!equalAddress(await recoverMessageAddress({ message: { raw: verified.userOperationHash }, signature: operationSignature }), verified.wallet)) reject('operation signer mismatch');
    const operation: SignedPreparedUserOperation = {
      type: 'user-operation-v070', chainId: PAYMASTER_CHAIN_HEX, data: verified.operation,
      signature: { type: 'secp256k1', data: operationSignature },
    };
    if (!verified.authorization) return operation;
    const authSignature = signature(signatureInput.authorization);
    if (!equalAddress(await recoverAddress({ hash: verified.authorization.hash, signature: authSignature }), verified.wallet)) reject('authorization signer mismatch');
    return {
      type: 'array', data: [{
        type: 'authorization', chainId: PAYMASTER_CHAIN_HEX,
        data: { address: PAYMASTER_DELEGATE, nonce: toHex(verified.authorization.nonce) },
        signature: { type: 'secp256k1', data: authSignature },
      }, operation],
    };
  } catch (error) {
    if (error instanceof PaymasterProtocolError) throw error;
    reject('invalid signature');
  }
}
