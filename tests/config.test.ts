import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTargets, percentToBps, validateConfig } from '../src/config.js';

const config = {
  version: 1, chainId: 4663, wallet: '0x0000000000000000000000000000000000000001',
  mode: 'private-key', rpcUrl: 'https://rpc.mainnet.chain.robinhood.com',
  targets: { USDG: 2000, TSLA: 2000, AAPL: 2000, NVDA: 2000, AMZN: 2000 }, driftThresholdBps: 500,
  slippageBps: 50, deadlineSeconds: 120, pollSeconds: 30,
};
test('percentages parse exactly to basis points', () => {
  assert.equal(percentToBps('29.99'), 2999);
  assert.deepEqual(parseTargets('WETH=29.99,USDG=70.01'), { WETH: 2999, USDG: 7001 });
  for (const input of ['NaN', '3e1', '-1', '0.001', '101']) assert.throws(() => percentToBps(input));
  assert.throws(() => parseTargets('WETH=50,WETH=50'));
});
test('configuration stays on Robinhood with complete supported allocations', () => {
  assert.equal(validateConfig(config).chainId, 4663);
  assert.throws(() => validateConfig({ ...config, chainId: 8453 }));
  assert.throws(() => validateConfig({ ...config, targets: { WETH: 3000, USDG: 6000 } }));
  assert.throws(() => validateConfig({ ...config, targets: { ETH: 5000, USDG: 5000 } }));
  assert.throws(() => validateConfig({ ...config, slippageBps: 10000 }));
});
