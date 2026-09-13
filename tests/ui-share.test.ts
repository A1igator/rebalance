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

async function page(clipboard: 'granted' | 'denied' | 'absent' | 'deferred' = 'granted') {
  const html = await readFile(new URL('../ui/index.html', import.meta.url), 'utf8');
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map(match => match[1]));
  const nodes = new Map<string, Node>(), events = new Map<string, (() => void)[]>(), timers = new Map<number, () => void>();
  const copies: string[] = [];
  const pendingCopies: { resolve: () => void; reject: (error: Error) => void }[] = [];
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
  const writeText = async (text: string) => {
    copies.push(text);
    if (clipboard === 'deferred') await new Promise<void>((resolve, reject) => pendingCopies.push({ resolve, reject }));
    if (clipboard === 'denied') throw new Error('NotAllowedError');
  };
  runInNewContext(await readFile(new URL('../ui/share-code.js', import.meta.url), 'utf8'), {
    window, document: { getElementById: byId }, navigator: { clipboard: clipboard === 'absent' ? undefined : { writeText } },
    setTimeout: (callback: () => void) => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: (id: number) => timers.delete(id),
  });
  const share = window.rebalanceShare!;
  assert.ok(share, 'the share control exposes its status input');
  return { byId, copies,
    async settleCopy(success = true) {
      const pending = pendingCopies.shift(); assert.ok(pending, 'a clipboard request must be pending');
      if (success) pending.resolve(); else pending.reject(new Error('NotAllowedError'));
      await flush();
    },
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
  assert.deepEqual(view.copies, ['rebalance:v1 USDG=5,AAPL=23.75,AMD=23.75,MSFT=23.75,NVDA=23.75 drift=5 interval=3600']);
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

test('chart codes are canonical regardless of target insertion order', async () => {
  const view = await page();
  const expected = encodeShareCode(strategy);
  for (const targets of [strategy.targets,
    { NVDA: 2375, AMD: 2375, USDG: 500, MSFT: 2375, AAPL: 2375 },
    { AAPL: 2375, MSFT: 2375, AMD: 2375, NVDA: 2375, USDG: 500 }]) {
    await view.update(snapshot({ ...strategy, targets })); await view.click();
    assert.equal(view.copies.at(-1), expected);
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

test('Share allows one clipboard request at a time, including forced duplicate clicks', async () => {
  const view = await page('deferred');
  await view.update(); await view.click();
  assert.equal(view.byId('share-code').disabled, true);
  await view.click(); await view.click(true);
  assert.equal(view.copies.length, 1);
  // Identical strategy from another status message does not invalidate a valid copy.
  await view.update(snapshot({ ...strategy, targets: { AMD: 2375, MSFT: 2375, NVDA: 2375, AAPL: 2375, USDG: 500 } }));
  await view.settleCopy();
  assert.equal(view.byId('share-code-label').textContent, 'Copied');
  assert.equal(view.byId('share-code').disabled, false);
});

for (const invalidation of ['strategy', 'disconnect', 'pagehide'] as const) {
  for (const success of [true, false]) {
    test(`late clipboard ${success ? 'success' : 'denial'} cannot restore feedback after ${invalidation}`, async () => {
      const view = await page('deferred');
      await view.update(); await view.click();
      const next = { ...strategy, driftThresholdBps: 250 };
      if (invalidation === 'strategy') await view.update(snapshot(next));
      if (invalidation === 'disconnect') { await view.update(snapshot(), true); await view.update(); }
      if (invalidation === 'pagehide') {
        await view.lifecycle('pagehide'); await view.lifecycle('pageshow'); await view.update();
      }
      assert.equal(view.byId('share-code').disabled, true, 'the old write still owns the clipboard request');
      await view.click(true); assert.equal(view.copies.length, 1);
      await view.settleCopy(success);
      assert.equal(view.byId('share-code-label').textContent, 'Share');
      assert.equal(view.byId('control-message').hidden, true);
      assert.equal(view.byId('share-code').disabled, false, 'settling an obsolete request releases the fresh strategy');
      await view.click();
      assert.equal(view.copies.at(-1), encodeShareCode(invalidation === 'strategy' ? next : strategy));
      await view.settleCopy();
      assert.equal(view.byId('share-code-label').textContent, 'Copied');
    });
  }
}

test('changed or unavailable strategy clears existing copy feedback without clearing other errors', async () => {
  const copied = await page();
  await copied.update(); await copied.click();
  await copied.update(snapshot({ ...strategy, driftThresholdBps: 250 }));
  assert.equal(copied.byId('share-code-label').textContent, 'Share');

  for (const invalidation of ['strategy', 'disconnect', 'pagehide'] as const) {
    const view = await page('denied');
    await view.update(); await view.click();
    assert.equal(view.byId('control-message').hidden, false);
    if (invalidation === 'strategy') await view.update(snapshot({ ...strategy, driftThresholdBps: 250 }));
    if (invalidation === 'disconnect') await view.update(snapshot(), true);
    if (invalidation === 'pagehide') await view.lifecycle('pagehide');
    assert.equal(view.byId('control-message').hidden, true);
    assert.equal(view.byId('control-message').textContent, '');
  }
  const view = await page('denied');
  await view.update(); await view.click();
  view.byId('control-message').textContent = 'Another control needs attention';
  await view.update(snapshot(), true);
  assert.equal(view.byId('control-message').textContent, 'Another control needs attention');
  assert.equal(view.byId('control-message').hidden, false);
});

test('the chart loads the share control before app.js and feeds it every status change', async () => {
  const [html, app] = await Promise.all(['index.html', 'app.js'].map(file => readFile(new URL(`../ui/${file}`, import.meta.url), 'utf8')));
  assert.match(html!, /<button id="share-code"[^>]*type="button"[^>]*disabled/);
  assert.ok(html!.indexOf('/share-code.js') > 0 && html!.indexOf('/share-code.js') < html!.indexOf('/app.js'));
  assert.match(app!, /rebalanceShare\?\.update\(snapshot, disconnected\)/);
  assert.match(app!, /rebalanceShare\?\.update\(lastSnapshot, true\)/);
});
