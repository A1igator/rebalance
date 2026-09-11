import assert from 'node:assert/strict';
import { test } from 'node:test';
import { percentToBps } from '../src/config.js';
import { bpsToPercent, decodeShareCode, encodeShareCode, sharePreview } from '../src/share.js';

const demo = { targets: { USDG: 500, AAPL: 2375, NVDA: 2375, MSFT: 2375, AMD: 2375 }, driftThresholdBps: 500, rebalanceIntervalSeconds: 3600 };
const code = 'rebalance:v1 USDG=5,AAPL=23.75,NVDA=23.75,MSFT=23.75,AMD=23.75 drift=5 interval=3600';

test('every basis-point value survives the percentage round trip', () => {
  for (let bps = 0; bps <= 10000; bps++) assert.equal(percentToBps(bpsToPercent(bps)), bps);
  assert.deepEqual([500, 2375, 2350, 5, 10000, 0].map(bpsToPercent), ['5', '23.75', '23.5', '0.05', '100', '0']);
});

test('a share code carries only targets, drift trigger and cycle interval', () => {
  const config = { ...demo, version: 1, chainId: 4663, wallet: `0x${'1'.repeat(40)}`, mode: 'private-key',
    rpcUrl: 'https://rpc.example/v2/secret-path-key', slippageBps: 50, deadlineSeconds: 120, pollSeconds: 30 };
  const encoded = encodeShareCode(config);
  assert.equal(encoded, code);
  assert.doesNotMatch(encoded, /0x|private-key|secret|rpc|slippage/i);
  assert.deepEqual(decodeShareCode(encoded), demo);
});

test('decoding tolerates pasted whitespace and targets-only codes', () => {
  assert.deepEqual(decodeShareCode(`  \n${code.replaceAll(' ', '\n  ')}\n`), demo);
  assert.deepEqual(decodeShareCode('rebalance:v1 USDG=20,TSLA=20,AAPL=20,NVDA=20,AMZN=20'),
    { targets: { USDG: 2000, TSLA: 2000, AAPL: 2000, NVDA: 2000, AMZN: 2000 } });
});

test('decoding rejects anything but USDG plus four manifest stocks with bounded settings', () => {
  const targets = 'USDG=5,AAPL=23.75,NVDA=23.75,MSFT=23.75,AMD=23.75';
  for (const input of [
    '', 'hello', targets, `rebalance:v2 ${targets}`, 'rebalance:v1',
    'rebalance:v1 USDG=50,AAPL=50',
    'rebalance:v1 USDG=5,AAPL=23.75,NVDA=23.75,MSFT=23.75,AMD=23.74',
    'rebalance:v1 usdg=5,AAPL=23.75,NVDA=23.75,MSFT=23.75,AMD=23.75',
    'rebalance:v1 USDG=5,0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9=23.75,NVDA=23.75,MSFT=23.75,AMD=23.75',
    'rebalance:v1 USDG=5,AAPL=23.75,AAPL=23.75,MSFT=23.75,AMD=23.75',
    'rebalance:v1 USDG=5,WETH=23.75,NVDA=23.75,MSFT=23.75,AMD=23.75',
    `rebalance:v1 ${targets} slippage=1`, `rebalance:v1 ${targets} wallet=0x${'1'.repeat(40)}`,
    `rebalance:v1 ${targets} drift=5 drift=6`, `rebalance:v1 ${targets} drift=101`, `rebalance:v1 ${targets} drift=5.005`,
    `rebalance:v1 ${targets} drift=`, `rebalance:v1 ${targets} drift=5=5`,
    `rebalance:v1 ${targets} interval=0`, `rebalance:v1 ${targets} interval=604801`,
    `rebalance:v1 ${targets} interval=3600.5`, `rebalance:v1 ${targets} interval=03600`,
    `rebalance:v1 ${targets} ${'x'.repeat(400)}`,
  ]) assert.throws(() => decodeShareCode(input), Error, input);
});

test('import preview lists changed targets and settings and says dropped assets are not sold', () => {
  const current = { targets: { USDG: 2000, TSLA: 2000, AAPL: 2000, NVDA: 2000, AMZN: 2000 }, driftThresholdBps: 500, rebalanceIntervalSeconds: 3600 };
  const preview = sharePreview(current, decodeShareCode('rebalance:v1 USDG=5,AAPL=23.75,NVDA=23.75,MSFT=23.75,AMD=23.75 drift=2.5 interval=3600'));
  assert.deepEqual(preview.targetChanges, [
    { asset: 'USDG', currentBps: 2000, sharedBps: 500 }, { asset: 'TSLA', currentBps: 2000, sharedBps: 0 },
    { asset: 'AAPL', currentBps: 2000, sharedBps: 2375 }, { asset: 'NVDA', currentBps: 2000, sharedBps: 2375 },
    { asset: 'AMZN', currentBps: 2000, sharedBps: 0 }, { asset: 'MSFT', currentBps: 0, sharedBps: 2375 },
    { asset: 'AMD', currentBps: 0, sharedBps: 2375 },
  ]);
  assert.deepEqual(preview.settingChanges, [{ setting: 'driftThresholdBps', current: 500, shared: 250 }]);
  assert.deepEqual(preview.untrackedAssets, ['TSLA', 'AMZN']);
  assert.match(preview.note!, /does not sell/);
  const same = sharePreview(demo, decodeShareCode(code));
  assert.deepEqual([same.targetChanges, same.settingChanges, same.untrackedAssets, 'note' in same], [[], [], [], false]);
});
