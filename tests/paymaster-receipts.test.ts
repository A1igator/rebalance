import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeAbiParameters, encodeEventTopics, TransactionReceiptNotFoundError, type Address, type Hex } from 'viem';
import { entryPoint07Abi, entryPoint07Address } from 'viem/account-abstraction';
import { inspectPaymasterReceipt, PaymasterReceiptError, PAYMASTER_RECEIPT_SCAN_BLOCKS, PAYMASTER_RECEIPT_SCAN_PAGES,
  type PaymasterReceiptDependencies, type PaymasterReceiptInput } from '../src/paymaster-receipts.js';

// All clients are in-memory read fixtures: no keys, storage, transport or signer.
const wallet = '0x0000000000000000000000000000000000000001';
const paymaster = '0x0000000000000000000000000000000000000002';
const wrapper = '0x0000000000000000000000000000000000000003';
const operationHash = `0x${'11'.repeat(32)}` as Hex;
const transactionHash = `0x${'22'.repeat(32)}` as Hex;
const blockHash = `0x${'33'.repeat(32)}` as Hex;
const otherHash = `0x${'44'.repeat(32)}` as Hex;
const nonce = 2n ** 128n + 7n;
const input: PaymasterReceiptInput = { wallet, paymaster, userOperationHash: operationHash,
  userOperationNonce: nonce.toString(), submittedAtBlock: '90' };
function eventLog(changes: Partial<{ userOpHash: Hex; sender: Address; paymaster: Address;
  nonce: bigint; success: boolean; actualGasCost: bigint; actualGasUsed: bigint }> = {}) {
  const args: { userOpHash: Hex; sender: Address; paymaster: Address; nonce: bigint; success: boolean; actualGasCost: bigint; actualGasUsed: bigint } = { userOpHash: operationHash, sender: wallet, paymaster, nonce, success: true,
    actualGasCost: 9876543210123456789n, actualGasUsed: 250_000n, ...changes };
  return { address: entryPoint07Address, blockHash, blockNumber: 100n, transactionHash, logIndex: 3,
    transactionIndex: 0, removed: false,
    topics: encodeEventTopics({ abi: entryPoint07Abi, eventName: 'UserOperationEvent', args }),
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }],
      [args.nonce, args.success, args.actualGasCost, args.actualGasUsed]),
  };
}
function fixture() {
  const receipt: any = { transactionHash, blockHash, blockNumber: 100n, to: entryPoint07Address,
    from: wrapper, status: 'success', logs: [eventLog()] };
  let head = 101n;
  const scanned: any[] = [], receiptReads: Hex[] = [];
  let scanLogs: any[] = [];
  const rpc = {
    getChainId: async () => 4663,
    getBlockNumber: async (_args?: unknown) => head,
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => { receiptReads.push(hash); return receipt; },
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ hash: blockHash, number: blockNumber }),
    getLogs: async (args: any) => { scanned.push(args); return scanLogs.filter(log => log.blockNumber >= args.fromBlock && log.blockNumber <= args.toBlock); },
  };
  const deps: PaymasterReceiptDependencies = { publicClient: rpc as unknown as PaymasterReceiptDependencies['publicClient'],
    getUserOperationReceipt: async () => ({ receipt: { transactionHash }, success: false, sender: wrapper, nonce: '0xdead' }) };
  return { receipt, rpc, deps, scanned, receiptReads, inspect: (current = input) => inspectPaymasterReceipt(current, deps),
    set head(value: bigint) { head = value; }, set scanLogs(value: any[]) { scanLogs = value; } };
}
const invalidEvidence = (error: unknown) => error instanceof PaymasterReceiptError && error.code === 'invalid-evidence';

test('canonical EntryPoint event establishes exact success and uint256 values, not the bundler claims', async () => {
  const f = fixture();
  const result = await f.inspect();
  assert.deepEqual(result, { state: 'confirmed', transactionHash, blockNumber: '100', nextScanBlock: '90',
    actualGasCost: '9876543210123456789', actualGasUsed: '250000' });
  assert.deepEqual(f.receiptReads, [transactionHash]); assert.equal(f.scanned.length, 0);
});

test('failed UserOperation in a successful bundle is reverted even if the bundler claims success', async () => {
  const f = fixture(); f.receipt.logs = [eventLog({ success: false })];
  f.deps.getUserOperationReceipt = async () => ({ success: true, receipt: { transactionHash, status: '0x1' } });
  assert.equal((await f.inspect()).state, 'reverted');
});

test('successful transaction alone and unrelated UserOperation events cannot establish completion', async () => {
  for (const logs of [[], [eventLog({ userOpHash: otherHash })], [{ ...eventLog(), address: wrapper }]]) {
    const f = fixture(); f.receipt.logs = logs;
    assert.equal((await f.inspect()).state, 'pending'); assert.equal(f.scanned.length, 1);
  }
});

for (const [name, changed] of Object.entries({ sender: { sender: wrapper }, paymaster: { paymaster: wrapper }, nonce: { nonce: nonce + 1n } } satisfies Record<string, Parameters<typeof eventLog>[0]>)) {
  test(`canonical event must match saved ${name}`, async () => {
    const f = fixture(); f.receipt.logs = [eventLog(changed)];
    await assert.rejects(f.inspect(), invalidEvidence);
  });
}

test('two matching events are ambiguous while other operations in the bundle are permitted', async () => {
  const f = fixture(); f.receipt.logs = [eventLog(), { ...eventLog(), logIndex: 4 }];
  await assert.rejects(f.inspect(), invalidEvidence);
  f.receipt.logs = [eventLog(), eventLog({ userOpHash: otherHash })];
  assert.equal((await f.inspect()).state, 'confirmed');
});

test('a matching event through a wrapper is explicitly unsupported', async () => {
  const f = fixture(); f.receipt.to = wrapper;
  await assert.rejects(f.inspect(), error => error instanceof PaymasterReceiptError && error.code === 'unsupported-entrypoint');
});

test('event execution requires two observed confirmations and canonical block identity', async () => {
  const f = fixture(); f.head = 100n;
  let result = await f.inspect();
  assert.equal(result.state, 'confirming'); assert.equal(result.actualGasCost, undefined);
  f.head = 101n; assert.equal((await f.inspect()).state, 'confirmed');
  f.rpc.getBlock = async ({ blockNumber }) => ({ number: blockNumber, hash: otherHash });
  result = await f.inspect(); assert.equal(result.state, 'confirming'); assert.equal(result.actualGasCost, undefined);
});

test('receipt, event and canonical block metadata must agree exactly', async () => {
  const cases = [
    (f: ReturnType<typeof fixture>) => { f.receipt.transactionHash = otherHash; },
    (f: ReturnType<typeof fixture>) => { f.receipt.blockNumber = 89n; },
    (f: ReturnType<typeof fixture>) => { f.receipt.status = 'reverted'; },
    (f: ReturnType<typeof fixture>) => { f.receipt.logs[0].transactionHash = otherHash; },
    (f: ReturnType<typeof fixture>) => { f.receipt.logs[0].blockHash = otherHash; },
    (f: ReturnType<typeof fixture>) => { f.receipt.logs[0].blockNumber = 99n; },
    (f: ReturnType<typeof fixture>) => { f.receipt.logs[0].removed = true; },
    (f: ReturnType<typeof fixture>) => { f.receipt.logs[0].removed = 'false'; },
    (f: ReturnType<typeof fixture>) => { f.receipt.logs[0].logIndex = -1; },
    (f: ReturnType<typeof fixture>) => { f.rpc.getBlock = async () => ({ number: 99n, hash: blockHash }); },
  ];
  for (const change of cases) { const f = fixture(); change(f); await assert.rejects(f.inspect(), invalidEvidence); }
});

test('malformed or excessive receipt logs fail closed with fixed diagnostics', async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => { f.receipt.logs = Array(4097).fill(eventLog()); },
    (f: ReturnType<typeof fixture>) => { f.receipt.logs[0].data = '0x12'; },
    (f: ReturnType<typeof fixture>) => { f.receipt.logs[0].topics.push(otherHash); },
    (f: ReturnType<typeof fixture>) => { f.receipt.logs[0].topics[2] = '0xprivate-provider-content'; },
    (f: ReturnType<typeof fixture>) => { f.receipt.logs[0].topics[2] = `0x${'1'.repeat(24)}${wallet.slice(2)}`; },
    (f: ReturnType<typeof fixture>) => { f.receipt.logs[0].data = encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [nonce, 2n, 1n, 1n]); },
  ]) {
    const f = fixture(); change(f);
    await assert.rejects(f.inspect(), error => {
      assert.ok(error instanceof PaymasterReceiptError); assert.ok(!error.message.includes('private-provider-content')); return true;
    });
  }
});

test('provider loss of receipt retention falls back to bounded public hash-filtered logs', async () => {
  const f = fixture(); f.deps.getUserOperationReceipt = async () => { throw new Error('private-provider-URL'); };
  f.scanLogs = [eventLog()];
  assert.equal((await f.inspect()).state, 'confirmed');
  assert.equal(f.scanned.length, 1);
  assert.equal(f.scanned[0].address, entryPoint07Address);
  assert.equal(f.scanned[0].event.name, 'UserOperationEvent');
  assert.deepEqual(f.scanned[0].args, { userOpHash: operationHash });
  assert.equal(f.scanned[0].strict, true); assert.equal(f.scanned[0].fromBlock, 90n); assert.equal(f.scanned[0].toBlock, 100n);
});

test('missing, malformed or unrelated provider hints do not suppress canonical discovery', async () => {
  for (const candidate of [null, { success: true }, { receipt: { transactionHash: '0x1234' } }, { receipt: { transactionHash: otherHash } }]) {
    const f = fixture(); f.deps.getUserOperationReceipt = async () => candidate; f.scanLogs = [eventLog()];
    f.rpc.getTransactionReceipt = async ({ hash }) => {
      if (hash === otherHash) throw new TransactionReceiptNotFoundError({ hash });
      return f.receipt;
    };
    assert.equal((await f.inspect()).state, 'confirmed');
  }
});

test('a hung bundler hint is bounded and still permits public discovery', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); f.scanLogs = [eventLog()]; f.deps.getUserOperationReceipt = async () => new Promise(() => {});
  const inspecting = f.inspect();
  for (let n = 0; n < 10; n++) await Promise.resolve();
  t.mock.timers.tick(4000);
  assert.equal((await inspecting).state, 'confirmed');
});

test('scan pages are bounded, skip the tip, and preserve a two-block overlap between traversals', async () => {
  const f = fixture(); delete f.deps.getUserOperationReceipt; f.head = 20_000n;
  const current = { ...input, submittedAtBlock: '0' };
  const first = await f.inspect(current);
  assert.equal(first.state, 'pending'); assert.equal(first.nextScanBlock, '8190');
  assert.equal(f.scanned.length, PAYMASTER_RECEIPT_SCAN_PAGES);
  assert.equal(f.scanned[0].fromBlock, 0n); assert.equal(f.scanned[3].toBlock, 8191n);
  for (const page of f.scanned) assert.ok(BigInt(page.toBlock) - BigInt(page.fromBlock) + 1n <= PAYMASTER_RECEIPT_SCAN_BLOCKS);
  await f.inspect({ ...current, scanFromBlock: first.nextScanBlock });
  assert.equal(f.scanned[4].fromBlock, 8190n);
  f.head = 101n; f.scanned.length = 0;
  const final = await f.inspect({ ...current, scanFromBlock: '99' });
  assert.equal(f.scanned[0].toBlock, 100n); assert.equal(final.nextScanBlock, '99');
});

test('scan cursor advances toward older pending operations after the provider forgets them', async () => {
  const f = fixture(); delete f.deps.getUserOperationReceipt; f.head = 20_000n;
  f.receipt.blockNumber = 10_000n; f.receipt.logs[0].blockNumber = 10_000n; f.scanLogs = f.receipt.logs;
  const current = { ...input, submittedAtBlock: '0' };
  const first = await f.inspect(current); assert.equal(first.state, 'pending');
  assert.equal((await f.inspect({ ...current, scanFromBlock: first.nextScanBlock })).state, 'confirmed');
});

test('head regression clamps the search cursor and tip-only scans wait without skipping a block', async () => {
  const f = fixture(); delete f.deps.getUserOperationReceipt; f.head = 95n;
  assert.equal((await f.inspect({ ...input, scanFromBlock: '200' })).nextScanBlock, '93');
  assert.equal(f.scanned.length, 0);
  f.head = 90n; const result = await f.inspect();
  assert.equal(result.nextScanBlock, '90'); assert.equal(result.state, 'pending'); assert.equal(f.scanned.length, 0);
});

test('disappearing receipt after a scan preserves that range for retry', async () => {
  const f = fixture(); delete f.deps.getUserOperationReceipt; f.scanLogs = [eventLog()];
  f.rpc.getTransactionReceipt = async ({ hash }) => { throw new TransactionReceiptNotFoundError({ hash }); };
  const result = await f.inspect(); assert.equal(result.state, 'pending'); assert.equal(result.nextScanBlock, '90');
});

test('scan evidence must obey the filter, range and uniqueness; decoded provider args are not trusted', async () => {
  for (const logs of [[eventLog(), eventLog()], [{ ...eventLog(), removed: true }], [{ ...eventLog(), address: wrapper }],
    [{ ...eventLog(), topics: [otherHash, operationHash] }], [{ ...eventLog(), blockNumber: 102n }]]) {
    const f = fixture(); delete f.deps.getUserOperationReceipt; f.rpc.getLogs = async () => logs;
    await assert.rejects(f.inspect(), invalidEvidence);
  }
  const f = fixture(); delete f.deps.getUserOperationReceipt;
  f.scanLogs = [{ ...eventLog(), args: { success: false, sender: wrapper } }];
  assert.equal((await f.inspect()).state, 'confirmed');
});

test('wrong network and unavailable or malformed public reads never confirm or expose provider details', async () => {
  const f = fixture(); f.rpc.getChainId = async () => 1;
  await assert.rejects(f.inspect(), invalidEvidence); assert.equal(f.receiptReads.length, 0);
  f.rpc.getChainId = async () => 4663;
  f.rpc.getTransactionReceipt = async () => { throw new Error('private-provider-URL'); };
  await assert.rejects(f.inspect(), error => error instanceof PaymasterReceiptError && error.code === 'read-failed' && !error.message.includes('private-provider-URL'));
});

test('invalid identities and noncanonical decimal nonce/cursors fail before any read', async () => {
  const f = fixture(); f.rpc.getChainId = async () => assert.fail('Invalid input must not access a client');
  const invalid = [
    { ...input, wallet: 'not-address' }, { ...input, paymaster: `0x${'0'.repeat(40)}` }, { ...input, userOperationHash: '0x1' },
    ...['01', '-1', '1e3', '0x1', (2n ** 256n).toString()].map(userOperationNonce => ({ ...input, userOperationNonce })),
    ...['-1', '01', (2n ** 64n).toString()].map(submittedAtBlock => ({ ...input, submittedAtBlock })),
    { ...input, scanFromBlock: '89' },
  ];
  for (const value of invalid) await assert.rejects(f.inspect(value as PaymasterReceiptInput),
    error => error instanceof PaymasterReceiptError && error.code === 'invalid-input');
});
