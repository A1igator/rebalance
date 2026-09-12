import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChainTransaction, createChain } from '../src/chain.js';
import type { Config } from '../src/config.js';
import { readRebalanceFee } from '../src/transactions.js';

const wallet = '0x0000000000000000000000000000000000000001';
const config = { wallet, rebalanceFeeTargetUsdE8: '1000000000' } as unknown as Config;
const tx: ChainTransaction = { to: wallet, data: '0x', value: 0n, kind: 'swap', swapCount: 4, approvalCount: 0 };
const chain = { publicClient: {
  getChainId: async () => 4663, estimateGas: async () => 400_000n, getGasPrice: async () => 500_000_000n,
} } as unknown as ReturnType<typeof createChain>;

test('passive fee preparation forwards batch coverage and buffered gas without signing', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response(JSON.stringify({ data: { base: 'ETH', currency: 'USD', amount: '3000' } }));
  });
  const swap = await readRebalanceFee(config, chain, tx, 4);
  assert.equal(swap.estimatedUsdE8, '86400000');
  const approval = await readRebalanceFee(config, chain, { ...tx, kind: 'approval', approvalCount: 1 }, 4);
  assert.equal(approval.estimatedUsdE8, ((480_000n + 4n * 202_542n) * 180n).toString());
  assert.equal(calls, 2);
});

test('inconsistent prepared phase counts produce unavailable fees before any external price request', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('Malformed metadata cannot become a fee quote'));
  for (const patch of [
    { swapCount: 0 }, { swapCount: 5 }, { swapCount: 1.5 },
    { approvalCount: 1 }, { kind: 'approval' as const, approvalCount: 0 },
    { kind: 'approval' as const, approvalCount: 5 }, { approvalCount: undefined },
  ]) assert.equal((await readRebalanceFee(config, chain, { ...tx, ...patch }, 4)).state, 'unavailable');
  assert.equal((await readRebalanceFee(config, chain, tx, 3)).state, 'unavailable');
});
