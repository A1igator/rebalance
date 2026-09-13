import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { decodeFunctionData, encodeFunctionData, erc20Abi, type Hex } from 'viem';
import { CALIBUR_DELEGATION_CODE } from '../src/calibur.js';
import { delegationFor } from '../src/delegation.js';
import { SIMPLE7702_ABI, SIMPLE7702_ADDRESS, SIMPLE7702_DELEGATION_CODE, assertSimple7702Deployment,
  inspectSimple7702AccountCode, encodeSimple7702Batch, buildSimple7702SetupTransaction, buildSimple7702SelfTransaction } from '../src/simple7702.js';
const wallet = '0x1111111111111111111111111111111111111111';
const target = '0x2222222222222222222222222222222222222222';
const data = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [target, 17n] });

test('Simple7702 uses its exact pinned runtime and rejects absent, modified or foreign code', async () => {
  const artifact = JSON.parse(await readFile(new URL('../src/artifacts/simple7702.json', import.meta.url), 'utf8'));
  assert.doesNotThrow(() => assertSimple7702Deployment(artifact.runtimeBytecode));
  for (const code of [undefined, '0x', '0x6000', `${artifact.runtimeBytecode.slice(0, -2)}ff`]) assert.throws(() => assertSimple7702Deployment(code as Hex | undefined), /pinned runtime/);
  assert.equal(inspectSimple7702AccountCode(undefined), 'undelegated');
  assert.equal(inspectSimple7702AccountCode(SIMPLE7702_DELEGATION_CODE), 'simple7702');
  assert.throws(() => inspectSimple7702AccountCode(CALIBUR_DELEGATION_CODE), /different delegation/);
  assert.throws(() => delegationFor('calibur').inspectAccountCode(SIMPLE7702_DELEGATION_CODE), /different delegation/);
});

test('bounded Simple7702 batches encode target/value/data and enrollment is a distinct empty self-call', () => {
  const calls = [{ to: target, value: 0n, data }] as const;
  const tx = buildSimple7702SelfTransaction(wallet, calls);
  assert.equal(tx.to, wallet); assert.equal(tx.value, 0n);
  assert.deepEqual(decodeFunctionData({ abi: SIMPLE7702_ABI, data: tx.data }).args[0], [{ target, value: 0n, data }]);
  const setup = buildSimple7702SetupTransaction(wallet);
  assert.deepEqual(decodeFunctionData({ abi: SIMPLE7702_ABI, data: setup.data }).args[0], []);
  assert.throws(() => encodeSimple7702Batch([]));
  assert.throws(() => encodeSimple7702Batch(Array(6).fill(calls[0])));
  assert.throws(() => buildSimple7702SetupTransaction(SIMPLE7702_ADDRESS));
  assert.throws(() => encodeSimple7702Batch([{ ...calls[0], value: 1n }]));
  assert.throws(() => encodeSimple7702Batch([{ ...calls[0], data: '0x' }]));
});

test('explicit descriptors never reinterpret the other contract encoding or setup identity', () => {
  const legacy = delegationFor('calibur'), simple = delegationFor('simple7702');
  assert.notEqual(legacy.address, simple.address); assert.equal(legacy.setupKind, 'calibur-setup'); assert.equal(simple.setupKind, 'simple7702-setup');
  const calls = [{ to: target, value: 0n, data }] as const;
  assert.deepEqual(simple.decodeCalls(simple.buildTransaction(wallet, calls).data), calls);
  assert.throws(() => legacy.decodeCalls(simple.buildTransaction(wallet, calls).data));
  assert.throws(() => simple.decodeCalls(legacy.buildTransaction(wallet, calls).data));
});
