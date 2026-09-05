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

test('an expanded manifest still selects exactly USDG plus four known own stock keys', () => {
  const selected = { USDG: 500, AAPL: 2375, NVDA: 2375, RUN: 2375, MRNA: 2375 };
  assert.deepEqual(validateConfig({ ...config, targets: selected }).targets, selected);
  const invalid = [
    { USDG: 500, AAPL: 2375, NVDA: 2375, RUN: 2375, UNKNOWN: 2375 },
    { TSLA: 2000, AAPL: 2000, NVDA: 2000, RUN: 2000, MRNA: 2000 },
    { ...selected, TSLA: 0 },
    { USDG: 500, AAPL: 9500 },
    Object.assign(Object.create({ USDG: 500 }), { AAPL: 2375, NVDA: 2375, RUN: 2375, MRNA: 2375 }),
    JSON.parse('{"USDG":500,"AAPL":2375,"NVDA":2375,"RUN":2375,"constructor":2375}'),
  ];
  for (const targets of invalid) assert.throws(() => validateConfig({ ...config, targets }), /Select exactly/);
  assert.throws(() => validateConfig({ ...config, targets: { ...selected, RUN: 2375.5 } }), /integer basis points/);
  assert.throws(() => validateConfig({ ...config, targets: { ...selected, RUN: 2376 } }), /total 100%/);
});

test('older configurations receive a one-hour rebalance interval without changing the drift threshold', () => {
  const migrated = validateConfig(config);
  assert.equal(migrated.rebalanceIntervalSeconds, 3600);
  assert.equal(migrated.driftThresholdBps, 500);
  assert.equal(Object.hasOwn(config, 'rebalanceIntervalSeconds'), false);
  assert.equal(validateConfig({ ...config, rebalanceIntervalSeconds: 7200 }).rebalanceIntervalSeconds, 7200);
  for (const interval of [0, -1, 0.5, null, 604801]) {
    assert.throws(() => validateConfig({ ...config, rebalanceIntervalSeconds: interval }), /Invalid rebalanceIntervalSeconds/);
  }
});
