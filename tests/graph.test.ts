import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runGraph, type GraphDependencies } from '../src/graph.js';

function setup(options: Partial<GraphDependencies> = {}) {
  const calls: string[] = [];
  const deps: GraphDependencies = {
    configured: async () => true,
    reconcile: async () => ({ blocked: false, operation: null }),
    observe: async () => { calls.push('read'); return { totalUsdE8: 1n, positions: [] }; },
    plan: () => ({ sellAssetId: 'TSLA', buyAssetId: 'USDG', amountIn: 1n, reason: 'drift' }),
    interval: async () => null,
    quote: async () => { calls.push('quote'); return {}; },
    execute: async () => { calls.push('send'); return { status: 'pending', hash: 'test' }; },
    publish: async () => {}, canExecute: true, ...options,
  };
  return { calls, deps };
}
test('recovery barrier prevents observation, planning and duplicate dispatch', async () => {
  const { calls, deps } = setup({ reconcile: async () => ({ blocked: true, operation: { status: 'unresolved' } }) });
  const graph = await runGraph(deps);
  assert.deepEqual(graph.trace, ['config', 'reconcile', 'wait']);
  assert.deepEqual(calls, []);
});
test('automatic graph reaches receipt exactly once without model or human calls', async () => {
  const { calls, deps } = setup();
  assert.deepEqual((await runGraph(deps)).trace, ['config', 'reconcile', 'observe', 'plan', 'interval', 'quote', 'execute', 'receipt']);
  assert.deepEqual(calls, ['read', 'quote', 'send']);
});
test('observation mode quotes but cannot dispatch', async () => {
  const { calls, deps } = setup({ canExecute: false });
  assert.equal((await runGraph(deps)).node, 'wait');
  assert.deepEqual(calls, ['read', 'quote']);
});
test('zero drift and missing configuration cannot reach signing', async () => {
  const zero = setup({ plan: () => null });
  await runGraph(zero.deps);
  assert.deepEqual(zero.calls, ['read']);
  const missing = setup({ configured: async () => false });
  await runGraph(missing.deps);
  assert.deepEqual(missing.calls, []);
});
test('failed observation cannot execute and publishes the failure node', async () => {
  const nodes: string[] = [];
  const { calls, deps } = setup({ observe: async () => { throw new Error('stale RPC'); },
    publish: async graph => { nodes.push(graph.node); } });
  await assert.rejects(runGraph(deps), /stale RPC/);
  assert.equal(nodes.at(-1), 'error');
  assert.deepEqual(calls, []);
});

test('cooldown blocks quoting and dispatch after reconciling receipts and refreshing the portfolio', async () => {
  const { calls, deps } = setup({
    reconcile: async () => { calls.push('receipt'); return { blocked: false, operation: { status: 'confirmed' } }; },
    interval: async () => ({ status: 'cooling-down', message: 'The next cycle is not eligible yet.' }),
  });
  const operations: string[] = [];
  deps.publish = async (_graph, operation) => { if (operation) operations.push(operation.status); };
  assert.deepEqual((await runGraph(deps)).trace, ['config', 'reconcile', 'observe', 'plan', 'interval', 'wait']);
  assert.deepEqual(calls, ['receipt', 'read']);
  assert.equal(operations.at(-1), 'cooling-down');
});

test('an unresolved receipt stops before interval logic, and a balanced plan can finish during cooldown', async () => {
  const blocked = setup({
    reconcile: async () => ({ blocked: true, operation: { status: 'unresolved' } }),
    interval: async () => { assert.fail('An unresolved receipt must remain the first barrier'); },
  });
  await runGraph(blocked.deps);
  let finished = false;
  const balanced = setup({
    plan: async () => { finished = true; return null; },
    interval: async () => { assert.fail('A fresh balanced observation must not wait for another cycle'); },
  });
  await runGraph(balanced.deps);
  assert.equal(finished, true);
  assert.deepEqual(balanced.calls, ['read']);
});
