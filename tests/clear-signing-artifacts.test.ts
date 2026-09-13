import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { encodeFunctionData, erc20Abi, parseAbi, type Address, type Hex } from 'viem';
import { ASSETS } from '../src/assets.js';
import { ROUTER } from '../src/chain.js';
import { SIMPLE7702_ABI, SIMPLE7702_ADDRESS, buildSimple7702SelfTransaction } from '../src/simple7702.js';
const fixtures = await import(new URL('../clear-signing/fixtures.mjs', import.meta.url).href);
const descriptor = async (name: string) => JSON.parse(await readFile(new URL(`../clear-signing/descriptors/${name}.json`, import.meta.url), 'utf8'));

test('development descriptor identities match production contracts without binding a wallet', async () => {
  const simple = await descriptor('calldata-Simple7702Account');
  const router = await descriptor('calldata-SwapRouter02');
  const approvals = await descriptor('calldata-RebalanceERC20');
  assert.deepEqual(simple.context.contract.deployments, [{ chainId: 4663, address: SIMPLE7702_ADDRESS }]);
  assert.deepEqual(router.context.contract.deployments, [{ chainId: 4663, address: ROUTER }]);
  assert.deepEqual(approvals.context.contract.deployments.map((d: {address: string}) => d.address).sort(), Object.values(ASSETS).map(a => a.address).sort());
  assert.ok(approvals.context.contract.deployments.every((d: {chainId: number}) => d.chainId === 4663));
  assert.equal(fixtures.router, ROUTER);
  for (const token of Object.values(fixtures.tokens) as {symbol: keyof typeof ASSETS; address: string; decimals: number}[]) {
    assert.equal(token.address, ASSETS[token.symbol].address);
    assert.equal(token.decimals, ASSETS[token.symbol].decimals);
  }
});

test('synthetic self-call uses the actual Simple7702 builder and descriptor ABI', async () => {
  const simple = await descriptor('calldata-Simple7702Account');
  const descriptorAbi = parseAbi(Object.keys(simple.display.formats).map(sig => `function ${sig}`));
  const calls = fixtures.calls as {target: Address; value: 0n; data: Hex}[];
  const sourceTx = buildSimple7702SelfTransaction(fixtures.wallet, calls.map(call => ({ to: call.target, value: call.value, data: call.data })));
  assert.equal(fixtures.batch().data, sourceTx.data);
  assert.equal(fixtures.batch().to, sourceTx.to);
  assert.equal(encodeFunctionData({ abi: descriptorAbi, functionName: 'executeBatch', args: [calls] }), sourceTx.data);
  assert.equal(encodeFunctionData({ abi: SIMPLE7702_ABI, functionName: 'executeBatch', args: [calls] }), sourceTx.data);
});

test('approval and both router selectors match the development fixture ABI exactly', async () => {
  const router = await descriptor('calldata-SwapRouter02');
  const routerAbi = parseAbi(Object.keys(router.display.formats).map(sig => `function ${sig}`));
  assert.equal(encodeFunctionData({ abi: routerAbi, functionName: 'multicall', args: [fixtures.deadline, fixtures.swapParams.map(fixtures.swapData)] }), fixtures.routerCall().data);
  for (const params of fixtures.swapParams) assert.equal(encodeFunctionData({ abi: routerAbi, functionName: 'exactInputSingle', args: [params] }), fixtures.swapData(params));
  const approval = await descriptor('calldata-RebalanceERC20');
  const abi = parseAbi(Object.keys(approval.display.formats).map(sig => `function ${sig}`));
  assert.equal(encodeFunctionData({ abi, functionName: 'approve', args: [ROUTER, 1n] }), encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [ROUTER, 1n] }));
});
