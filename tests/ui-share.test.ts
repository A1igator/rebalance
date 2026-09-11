import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { decodeShareCode, encodeShareCode } from '../src/share.js';

const wallet = `0x${'1'.repeat(40)}`;
const strategy = { targets: { USDG: 500, AAPL: 2375, NVDA: 2375, MSFT: 2375, AMD: 2375 }, driftThresholdBps: 500, rebalanceIntervalSeconds: 3600 };
const snapshot = (config: unknown = strategy, extra = {}) => ({ app: 'Rebalance', chain: { id: 4663 }, wallet, mode: 'private-key', config, ...extra });
const flush = async () => { await new Promise<void>(resolve => setImmediate(resolve)); };

class Node {
  textContent = ''; title = ''; hidden = false; disabled = false;
  handlers = new Map<string, (() => void)[]>();
  addEventListener(name: string, handler: () => void) { this.handlers.set(name, [...this.handlers.get(name) || [], handler]); }
  click() { if (!this.disabled) this.dispatch('click'); }
  dispatch(name: string) { for (const handler of this.handlers.get(name) || []) handler(); }
}

async function page(clipboard: 'granted' | 'denied' | 'absent' = 'granted') {
  const html = await readFile(new URL('../ui/index.html', import.meta.url), 'utf8');
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map(match => match[1]));
  const nodes = new Map<string, Node>(), events = new Map<string, (() => void)[]>(), timers = new Map<number, () => void>();
  const copies: string[] = [];
  let timerId = 0;
  const byId = (id: string) => {
    assert.ok(ids.has(id), `Share control references missing markup: ${id}`);
    if (!nodes.has(id)) {
      const node = new Node(); node.hidden = id === 'control-message';
      if (id === 'share-code-label') node.textContent = 'Share';
      nodes.set(id, node);
    }
    return nodes.get(id)!;
  };
  const window: { rebalanceShare?: { update: (value: unknown, disconnected?: boolean) => void }; addEventListener: (name: string, handler: () => void) => void } = {
    addEventListener: (name, handler) => events.set(name, [...events.get(name) || [], handler]),
  };
  const writeText = async (text: string) => { copies.push(text); if (clipboard === 'denied') throw new Error('NotAllowedError'); };
  runInNewContext(await readFile(new URL('../ui/share-code.js', import.meta.url), 'utf8'), {
    window, document: { getElementById: byId }, navigator: { clipboard: clipboard === 'absent' ? undefined : { writeText } },
    setTimeout: (callback: () => void) => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: (id: number) => timers.delete(id),
  });
  const share = window.rebalanceShare!;
  assert.ok(share, 'the share control exposes its status input');
  return { byId, copies,
    async update(value: unknown = snapshot(), disconnected = false) { share.update(value, disconnected); await flush(); },
    async click(force = false) { if (force) byId('share-code').dispatch('click'); else byId('share-code').click(); await flush(); },
    async lifecycle(name: string) { for (const handler of events.get(name) || []) handler(); await flush(); },
    async timersRun() { const pending = [...timers.values()]; timers.clear(); for (const callback of pending) callback(); await flush(); },
  };
}

test('Share copies exactly the CLI share code and nothing identifying the wallet', async () => {
  const view = await page();
  await view.update(snapshot({ ...strategy, rebalanceFeeTargetUsdE8: '5000000', allocation: { policyHash: 'a'.repeat(64) } },
    { portfolio: { totalUsdE8: '100' } }));
  assert.equal(view.byId('share-code').disabled, false);
  await view.click();
  assert.deepEqual(view.copies, ['rebalance:v1 USDG=5,AAPL=23.75,NVDA=23.75,MSFT=23.75,AMD=23.75 drift=5 interval=3600']);
  assert.equal(view.copies[0], encodeShareCode(strategy));
  assert.deepEqual(decodeShareCode(view.copies[0]!), strategy);
  assert.doesNotMatch(view.copies[0]!, /0x|private-key|5000000|aaaa/i);
  assert.equal(view.byId('share-code-label').textContent, 'Copied');
  assert.equal(view.byId('control-message').hidden, true);
  await view.timersRun();
  assert.equal(view.byId('share-code-label').textContent, 'Share');
});

test('the chart and CLI encoders agree on uneven weights and boundary settings', async () => {
  const view = await page();
  const configs: { targets: Record<string, number>; driftThresholdBps: number; rebalanceIntervalSeconds: number }[] = [
    { targets: { USDG: 5, TSLA: 3333, AAPL: 3333, RUN: 3329, MRNA: 0 }, driftThresholdBps: 250, rebalanceIntervalSeconds: 5400 },
    { targets: { USDG: 10000, NVDA: 0, MSFT: 0, AMD: 0, AMZN: 0 }, driftThresholdBps: 0, rebalanceIntervalSeconds: 604800 },
  ];
  for (const config of configs) {
    await view.update(snapshot(config)); await view.click();
    assert.equal(view.copies.at(-1), encodeShareCode(config));
    assert.deepEqual(decodeShareCode(view.copies.at(-1)!), config);
  }
});

test('Share stays disabled without a fresh, valid saved strategy', async () => {
  const view = await page();
  assert.equal(view.byId('share-code').disabled, true);
  const cases: [unknown, boolean][] = [
    [null, false], [snapshot(null), false], [snapshot(strategy, { chain: { id: 1 } }), false], [snapshot(), true],
    [snapshot({ ...strategy, targets: { USDG: 5000, AAPL: 5000 } }), false],
    [snapshot({ ...strategy, targets: { ...strategy.targets, AMD: 2374 } }), false],
    [snapshot({ ...strategy, targets: { ...strategy.targets, AMD: 2374.5 } }), false],
    [snapshot({ ...strategy, targets: { USDG: 500, '0xabc': 2375, NVDA: 2375, MSFT: 2375, AMD: 2375 } }), false],
    [snapshot({ ...strategy, driftThresholdBps: 10001 }), false], [snapshot({ ...strategy, rebalanceIntervalSeconds: 0 }), false],
    [snapshot({ targets: strategy.targets }), false],
  ];
  for (const [value, disconnected] of cases) {
    await view.update(); assert.equal(view.byId('share-code').disabled, false);
    await view.update(value, disconnected);
    assert.equal(view.byId('share-code').disabled, true, JSON.stringify(value));
    await view.click(true);
  }
  assert.deepEqual(view.copies, []);
});

test('a denied or missing clipboard leaves the full code as selectable text', async () => {
  for (const clipboard of ['denied', 'absent'] as const) {
    const view = await page(clipboard);
    await view.update(); await view.click();
    assert.equal(view.byId('control-message').hidden, false);
    assert.equal(view.byId('control-message').textContent, `Copy this share code: ${encodeShareCode(strategy)}`);
    assert.equal(view.byId('share-code-label').textContent, 'Share');
  }
});

test('page suspension disables Share until a fresh status arrives', async () => {
  const view = await page();
  await view.update(); await view.lifecycle('pagehide');
  assert.equal(view.byId('share-code').disabled, true);
  await view.lifecycle('pageshow'); assert.equal(view.byId('share-code').disabled, true);
  await view.update(); assert.equal(view.byId('share-code').disabled, false);
});

test('the chart loads the share control before app.js and feeds it every status change', async () => {
  const [html, app] = await Promise.all(['index.html', 'app.js'].map(file => readFile(new URL(`../ui/${file}`, import.meta.url), 'utf8')));
  assert.match(html!, /<button id="share-code"[^>]*type="button"[^>]*disabled/);
  assert.ok(html!.indexOf('/share-code.js') > 0 && html!.indexOf('/share-code.js') < html!.indexOf('/app.js'));
  assert.match(app!, /rebalanceShare\?\.update\(snapshot, disconnected\)/);
  assert.match(app!, /rebalanceShare\?\.update\(lastSnapshot, true\)/);
});
