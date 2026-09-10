import assert from 'node:assert/strict';
import test from 'node:test';
import { concatHex, encodeFunctionData, hashMessage, parseAbi, serializeSignature, toHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { getUserOperationHash, type UserOperation } from 'viem/account-abstraction';
import { hashAuthorization } from 'viem/utils';
import {
  PAYMASTER_ACCOUNT_ABI, PAYMASTER_CHAIN_HEX, PAYMASTER_CHAIN_ID, PAYMASTER_DELEGATE,
  PAYMASTER_ENTRY_POINT, PAYMASTER_NONCE_KEY, PAYMASTER_USDG,
  PaymasterProtocolError, formatSignedPreparedCalls, verifyPreparedCalls,
  type PaymasterCall, type PaymasterVerificationContext,
} from '../src/paymaster-protocol.js';

// Public, disposable offline fixture identity. No file, wallet, RPC or Keychain access.
const owner = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const stranger = privateKeyToAccount(`0x${'22'.repeat(32)}`);
const PAYMASTER = '0x0000000000000000000000000000000000000010' as Address;
const ROUTER = '0x0000000000000000000000000000000000000020' as Address;
const TOKEN = '0x0000000000000000000000000000000000000030' as Address;
const APPROVE_ABI = parseAbi(['function approve(address spender, uint256 amount) returns (bool)']);
const FEE = 45_000n;
const NONCE = (PAYMASTER_NONCE_KEY << 64n) + 3n;
const CALLS: readonly PaymasterCall[] = [
  { to: TOKEN, value: 0n, data: encodeFunctionData({ abi: APPROVE_ABI, functionName: 'approve', args: [ROUTER, 1_000_000n] }) },
  { to: ROUTER, value: 0n, data: '0x12345678' },
];
function approval(amount = FEE, spender = PAYMASTER): PaymasterCall {
  return { to: PAYMASTER_USDG, value: 0n, data: encodeFunctionData({ abi: APPROVE_ABI, functionName: 'approve', args: [spender, amount] }) };
}
function encodeCalls(calls: readonly PaymasterCall[], prefix = false): Hex {
  const data = calls.length === 1
    ? encodeFunctionData({ abi: PAYMASTER_ACCOUNT_ABI, functionName: 'execute', args: [calls[0]!.to, calls[0]!.value, calls[0]!.data] })
    : encodeFunctionData({ abi: PAYMASTER_ACCOUNT_ABI, functionName: 'executeBatch', args: [calls.map((call) => ({ target: call.to, value: call.value, data: call.data }))] });
  return prefix ? concatHex(['0x8dd7712f', data]) : data;
}
function fixture(options: { auth?: boolean; approval?: boolean; calls?: readonly PaymasterCall[]; actualCalls?: readonly PaymasterCall[]; prefix?: boolean } = {}) {
  const requested = options.calls ?? CALLS;
  const actual = options.actualCalls ?? (options.approval ? [approval(), ...requested] : requested);
  const userOperation: UserOperation<'0.7'> = {
    sender: owner.address, nonce: NONCE, callData: encodeCalls(actual, options.prefix),
    callGasLimit: 350_000n, verificationGasLimit: 100_000n, preVerificationGas: 50_000n,
    maxFeePerGas: 20_000_000n, maxPriorityFeePerGas: 1_000_000n,
    paymaster: PAYMASTER, paymasterData: '0x1234', paymasterVerificationGasLimit: 100_000n, paymasterPostOpGasLimit: 50_000n,
    signature: '0x',
  };
  const hash = getUserOperationHash({ userOperation, chainId: PAYMASTER_CHAIN_ID, entryPointAddress: PAYMASTER_ENTRY_POINT, entryPointVersion: '0.7' });
  const rawData = Object.fromEntries(Object.entries(userOperation).filter(([key]) => key !== 'signature').map(([key, value]) => [key, typeof value === 'bigint' ? toHex(value) : value]));
  const op: any = {
    type: 'user-operation-v070', chainId: PAYMASTER_CHAIN_HEX, data: rawData,
    feePayment: { sponsored: false, tokenAddress: PAYMASTER_USDG, maxAmount: toHex(FEE) },
    signatureRequest: { type: 'personal_sign', data: { raw: hash }, rawPayload: hashMessage({ raw: hash }) },
  };
  const auth: any = {
    type: 'authorization', chainId: PAYMASTER_CHAIN_HEX, data: { address: PAYMASTER_DELEGATE, nonce: '0x5' },
    signatureRequest: { type: 'eip7702Auth', rawPayload: hashAuthorization({ chainId: PAYMASTER_CHAIN_ID, address: PAYMASTER_DELEGATE, nonce: 5 }) },
  };
  const raw: any = options.auth ? { type: 'array', data: [auth, op] } : op;
  const context: PaymasterVerificationContext = {
    wallet: owner.address, paymaster: PAYMASTER, paymasterAllowance: options.approval ? 0n : FEE,
    calls: requested, userOperationNonce: NONCE, requireAuthorization: options.auth ?? false,
    ...(options.auth ? { authorizationNonce: 5 } : {}),
  };
  return { raw, op, auth, context, hash, userOperation };
}
function fails(raw: unknown, context: PaymasterVerificationContext, message?: RegExp): void {
  assert.throws(() => verifyPreparedCalls(raw, context), (error: unknown) => {
    assert.ok(error instanceof PaymasterProtocolError);
    assert.equal(error.code, 'PAYMASTER_PROTOCOL_INVALID');
    if (message) assert.match(error.message, message);
    return true;
  });
}

test('verifies the same EOA, exact calls and fee with existing allowance', () => {
  const f = fixture();
  const result = verifyPreparedCalls(f.raw, f.context);
  assert.equal(result.wallet, owner.address);
  assert.equal(result.userOperationHash, f.hash);
  assert.equal(result.personalSignHash, hashMessage({ raw: f.hash }));
  assert.equal(result.callId, concatHex([toHex(4663, { size: 32 }), f.hash]));
  assert.equal(result.feeTokenAmount, FEE);
  assert.equal(result.feeApprovalInjected, false);
  assert.equal(result.userOperation.signature, '0x');
  assert.equal(result.operation.nonce, toHex(NONCE));
  assert.equal(result.signingRequired, true);
  assert.deepEqual(result.calls, CALLS);
});

test('verifies first-use authorization and only exact prepended USDG fee approval', () => {
  const f = fixture({ auth: true, approval: true });
  const result = verifyPreparedCalls(f.raw, f.context);
  assert.equal(result.authorization?.address, PAYMASTER_DELEGATE);
  assert.equal(result.authorization?.nonce, 5);
  assert.equal(result.authorization?.hash, f.auth.signatureRequest.rawPayload);
  assert.deepEqual(result.calls, [approval(), ...CALLS]);
  assert.equal(result.feeApprovalInjected, true);
});

test('supports single execute and the documented executeUserOp wrapper', () => {
  for (const options of [{ calls: [CALLS[1]!] }, { prefix: true }]) {
    const f = fixture(options);
    assert.deepEqual(verifyPreparedCalls(f.raw, f.context).calls, options.calls ?? CALLS);
  }
});

test('an exact approval is valid even when allowance was already sufficient', () => {
  const f = fixture({ approval: true });
  f.context.paymasterAllowance = FEE * 2n;
  assert.equal(verifyPreparedCalls(f.raw, f.context).feeTokenAmount, FEE);
});

test('onlyEstimation is readable without a signing request and cannot produce signed calls', async () => {
  const f = fixture();
  delete f.op.signatureRequest;
  const result = verifyPreparedCalls(f.raw, { ...f.context, onlyEstimation: true });
  assert.equal(result.signingRequired, false);
  await assert.rejects(formatSignedPreparedCalls(result, { userOperation: '0x' }), /signable verified preparation/);
  fails(f.raw, f.context, /missing operation signing request/);
});

test('canonical formatter verifies offline signer signatures and strips untrusted metadata', async () => {
  const f = fixture({ auth: true, approval: true });
  f.raw.details = { type: 'user-operation', data: { hash: f.hash, calls: [] } };
  const result = verifyPreparedCalls(f.raw, f.context);
  const userOperation = await owner.signMessage({ message: { raw: result.userOperationHash } });
  const signedAuthorization = await owner.signAuthorization({ chainId: PAYMASTER_CHAIN_ID, contractAddress: PAYMASTER_DELEGATE, nonce: 5 });
  const authorization = serializeSignature(signedAuthorization);
  const signed = await formatSignedPreparedCalls(result, { userOperation, authorization });
  assert.equal(signed.type, 'array');
  if (signed.type !== 'array') assert.fail('array expected');
  assert.deepEqual(signed.data.map((entry) => entry.type), ['authorization', 'user-operation-v070']);
  assert.equal(signed.data[0].data.nonce, '0x5');
  assert.equal(signed.data[1].data, result.operation);
  assert.equal(signed.data[0].signature.data, authorization);
  assert.equal(signed.data[1].signature.data, userOperation);
  assert.equal(JSON.stringify(signed).includes('signatureRequest'), false);
  assert.equal(JSON.stringify(signed).includes('details'), false);
  assert.equal(JSON.stringify(signed).includes('feePayment'), false);
});

test('canonical formatter accepts subsequent user operation alone', async () => {
  const f = fixture();
  const result = verifyPreparedCalls(f.raw, f.context);
  const userOperation = await owner.signMessage({ message: { raw: result.userOperationHash } });
  const signed = await formatSignedPreparedCalls(result, { userOperation, authorization: undefined });
  assert.equal(signed.type, 'user-operation-v070');
  assert.equal(signed.signature.data.length, 132);
});

for (const [name, mutate] of [
  ['wrong chain', (f: ReturnType<typeof fixture>) => { f.op.chainId = '0x1'; }],
  ['changed wallet', (f: ReturnType<typeof fixture>) => { f.op.data.sender = stranger.address; }],
  ['changed nonce', (f: ReturnType<typeof fixture>) => { f.op.data.nonce = toHex(NONCE + 1n); }],
  ['changed paymaster', (f: ReturnType<typeof fixture>) => { f.op.data.paymaster = ROUTER; }],
  ['other fee token', (f: ReturnType<typeof fixture>) => { f.op.feePayment.tokenAddress = TOKEN; }],
  ['sponsorship substitution', (f: ReturnType<typeof fixture>) => { f.op.feePayment.sponsored = true; }],
  ['zero fee quote', (f: ReturnType<typeof fixture>) => { f.op.feePayment.maxAmount = '0x0'; }],
  ['missing fee quote', (f: ReturnType<typeof fixture>) => { delete f.op.feePayment; }],
  ['missing paymaster gas', (f: ReturnType<typeof fixture>) => { delete f.op.data.paymasterPostOpGasLimit; }],
  ['factory deployment', (f: ReturnType<typeof fixture>) => { f.op.data.factory = ROUTER; }],
  ['embedded signature', (f: ReturnType<typeof fixture>) => { f.op.data.signature = '0x11'; }],
  ['unknown v060 schema', (f: ReturnType<typeof fixture>) => { f.op.type = 'user-operation-v060'; }],
  ['unsupported permit schema', (f: ReturnType<typeof fixture>) => { f.op.type = 'paymaster-permit'; }],
  ['unsupported typed data', (f: ReturnType<typeof fixture>) => { f.op.signatureRequest.type = 'eth_signTypedData_v4'; }],
  ['message text instead of raw bytes', (f: ReturnType<typeof fixture>) => { f.op.signatureRequest.data = f.hash; }],
  ['provider hash differs', (f: ReturnType<typeof fixture>) => { f.op.signatureRequest.data.raw = `0x${'00'.repeat(32)}`; }],
  ['provider prefixed hash differs', (f: ReturnType<typeof fixture>) => { f.op.signatureRequest.rawPayload = f.hash; }],
  ['unrecognized signing field', (f: ReturnType<typeof fixture>) => { f.op.signatureRequest.extra = 'untrusted'; }],
  ['wrong details hash', (f: ReturnType<typeof fixture>) => { f.op.details = { type: 'user-operation', data: { hash: `0x${'00'.repeat(32)}`, calls: [] } }; }],
  ['unknown envelope data', (f: ReturnType<typeof fixture>) => { f.raw.session = 'untrusted'; }],
  ['oversized packed gas', (f: ReturnType<typeof fixture>) => { f.op.data.callGasLimit = toHex(1n << 128n); }],
  ['invalid quantity', (f: ReturnType<typeof fixture>) => { f.op.data.nonce = NONCE; }],
  ['zero gas', (f: ReturnType<typeof fixture>) => { f.op.data.callGasLimit = '0x0'; }],
  ['priority fee exceeds maximum', (f: ReturnType<typeof fixture>) => { f.op.data.maxPriorityFeePerGas = toHex(20_000_001n); }],
  ['invalid paymaster bytes', (f: ReturnType<typeof fixture>) => { f.op.data.paymasterData = '0x123'; }],
] as const) {
  test(`rejects ${name} before signing`, () => {
    const f = fixture(); mutate(f); fails(f.raw, f.context);
  });
}

for (const [name, actualCalls] of [
  ['changed recipient', [{ ...CALLS[0]!, to: ROUTER }, CALLS[1]!]],
  ['changed amount', [{ ...CALLS[0]!, value: 1n }, CALLS[1]!]],
  ['changed calldata', [CALLS[0]!, { ...CALLS[1]!, data: '0xabcd' as Hex }]],
  ['reordered calls', [CALLS[1]!, CALLS[0]!]],
  ['extra call', [...CALLS, CALLS[1]!]],
  ['missing call', [CALLS[0]!]],
  ['unlimited fee allowance', [approval((1n << 256n) - 1n), ...CALLS]],
  ['oversized fee allowance', [approval(FEE + 1n), ...CALLS]],
  ['wrong approval spender', [approval(FEE, ROUTER), ...CALLS]],
  ['wrong approval token', [{ ...approval(), to: TOKEN }, ...CALLS]],
  ['approval carrying native value', [{ ...approval(), value: 1n }, ...CALLS]],
  ['appended fee approval', [...CALLS, approval()]],
  ['double fee approval', [approval(), approval(), ...CALLS]],
] as const) {
  test(`rejects ${name} even with self-consistent provider hashes`, () => {
    const f = fixture({ actualCalls }); fails(f.raw, f.context, /prepared calls differ/);
  });
}

test('fails closed when an approval is omitted without sufficient independent allowance', () => {
  const f = fixture();
  fails(f.raw, { ...f.context, paymasterAllowance: FEE - 1n }, /missing fee token approval/);
  fails(f.raw, { ...f.context, paymasterAllowance: undefined as any }, /verification context/);
});

for (const [name, mutate] of [
  ['wrong delegation', (f: ReturnType<typeof fixture>) => { f.auth.data.address = '0x69007702764179f14F51cdce752f4f775d74E139'; }],
  ['wrong auth chain', (f: ReturnType<typeof fixture>) => { f.auth.chainId = '0x0'; }],
  ['wrong auth nonce', (f: ReturnType<typeof fixture>) => { f.auth.data.nonce = '0x6'; }],
  ['wrong auth hash', (f: ReturnType<typeof fixture>) => { f.auth.signatureRequest.rawPayload = f.hash; }],
  ['stale auth schema', (f: ReturnType<typeof fixture>) => { f.auth.type = 'eip7702-authorization'; }],
  ['extra authorization', (f: ReturnType<typeof fixture>) => { f.raw.data.push(f.auth); }],
  ['wrong authorization order', (f: ReturnType<typeof fixture>) => { f.raw.data.reverse(); }],
  ['missing transaction', (f: ReturnType<typeof fixture>) => { f.raw.data.pop(); }],
] as const) {
  test(`rejects ${name}`, () => { const f = fixture({ auth: true }); mutate(f); fails(f.raw, f.context); });
}

test('never silently delegates an already-delegated wallet', () => {
  const f = fixture({ auth: true });
  fails(f.raw, { ...f.context, requireAuthorization: false }, /unexpected authorization/);
});

test('requires authorization if the caller independently found an undelegated wallet', () => {
  const f = fixture();
  fails(f.raw, { ...f.context, requireAuthorization: true, authorizationNonce: 5 }, /unsupported object fields|authorization and operation required/);
});

test('rejects unauthorized nonce lanes and unsafe authorization nonce numbers', () => {
  const f = fixture({ auth: true });
  fails(f.raw, { ...f.context, userOperationNonce: 3n }, /unsupported nonce lane/);
  for (const authorizationNonce of [undefined, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    fails(f.raw, { ...f.context, authorizationNonce }, /authorization nonce mismatch/);
  }
});

test('rejects unknown, noncanonical or oversized account calldata', () => {
  for (const data of ['0x12345678', '0x', `${encodeCalls(CALLS)}00`, concatHex(['0x8dd7712f', '0x8dd7712f', encodeCalls(CALLS)]), `0x${'ab'.repeat(65_536 * 17 + 1)}`]) {
    const f = fixture(); f.op.data.callData = data; fails(f.raw, f.context);
  }
});

test('rejects account-management calls, empty requests and excess calls', () => {
  const f = fixture();
  for (const to of [owner.address, PAYMASTER_ENTRY_POINT, PAYMASTER_DELEGATE]) {
    fails(f.raw, { ...f.context, calls: [{ to, data: '0x', value: 0n }] }, /account management/);
  }
  fails(f.raw, { ...f.context, calls: [] }, /invalid requested calls/);
  fails(f.raw, { ...f.context, calls: Array.from({ length: 17 }, () => CALLS[1]!) }, /invalid requested calls/);
});

test('caller and provider objects cannot mutate verified signing payloads', () => {
  const f = fixture({ auth: true, approval: true });
  const verified = verifyPreparedCalls(f.raw, f.context);
  const expected = verified.operation.callData;
  f.op.data.callData = '0x';
  f.auth.data.address = ROUTER;
  assert.equal(verified.operation.callData, expected);
  assert.equal(verified.authorization?.address, PAYMASTER_DELEGATE);
  assert.throws(() => { (verified.operation as any).sender = stranger.address; }, TypeError);
  assert.throws(() => { (verified.calls as any).push(CALLS[1]); }, TypeError);
  assert.throws(() => { (verified.calls[0] as any).to = ROUTER; }, TypeError);
});

test('rejects missing, forged, wrong-owner and mismatched-purpose signatures', async () => {
  const f = fixture({ auth: true });
  const verified = verifyPreparedCalls(f.raw, f.context);
  const rightOp = await owner.signMessage({ message: { raw: verified.userOperationHash } });
  const wrongOp = await stranger.signMessage({ message: { raw: verified.userOperationHash } });
  const rightAuth = serializeSignature(await owner.signAuthorization({ chainId: PAYMASTER_CHAIN_ID, contractAddress: PAYMASTER_DELEGATE, nonce: 5 }));
  const wrongAuth = serializeSignature(await stranger.signAuthorization({ chainId: PAYMASTER_CHAIN_ID, contractAddress: PAYMASTER_DELEGATE, nonce: 5 }));
  await assert.rejects(formatSignedPreparedCalls({ ...verified }, { userOperation: rightOp, authorization: rightAuth }), /signable verified preparation/);
  await assert.rejects(formatSignedPreparedCalls(verified, { userOperation: wrongOp, authorization: rightAuth }), /operation signer mismatch/);
  await assert.rejects(formatSignedPreparedCalls(verified, { userOperation: rightOp, authorization: wrongAuth }), /authorization signer mismatch/);
  await assert.rejects(formatSignedPreparedCalls(verified, { userOperation: rightOp }), /invalid byte string/);
  await assert.rejects(formatSignedPreparedCalls(verified, { userOperation: rightAuth, authorization: rightOp }), /operation signer mismatch/);
  for (const userOperation of ['0x', `0x${'00'.repeat(65)}`, `${rightOp.slice(0, 130)}ff`, `0x${'11'.repeat(32)}${'ff'.repeat(32)}1b`]) {
    await assert.rejects(formatSignedPreparedCalls(verified, { userOperation: userOperation as Hex, authorization: rightAuth }), PaymasterProtocolError);
  }
});

test('rejects an unsolicited authorization signature for a single operation', async () => {
  const f = fixture(); const verified = verifyPreparedCalls(f.raw, f.context);
  const signed = await owner.signMessage({ message: { raw: verified.userOperationHash } });
  await assert.rejects(formatSignedPreparedCalls(verified, { userOperation: signed, authorization: signed }), /unexpected authorization signature/);
});

test('accepts yParity serialization and canonicalizes it to 27/28', async () => {
  const f = fixture(); const verified = verifyPreparedCalls(f.raw, f.context);
  const signed = await owner.signMessage({ message: { raw: verified.userOperationHash } });
  const paritySignature = `${signed.slice(0, 130)}${(Number.parseInt(signed.slice(130), 16) - 27).toString(16).padStart(2, '0')}` as Hex;
  const formatted = await formatSignedPreparedCalls(verified, { userOperation: paritySignature });
  if (formatted.type === 'array') assert.fail('single operation expected');
  assert.equal(formatted.signature.data, signed);
});

test('fixed errors never echo provider-controlled response text', () => {
  const f = fixture(); f.op.signatureRequest.type = 'sensitive-provider-text';
  assert.throws(() => verifyPreparedCalls(f.raw, f.context), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message.includes('sensitive-provider-text'), false);
    assert.equal(error.message.includes(owner.address), false);
    return true;
  });
});
