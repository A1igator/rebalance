import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const observed = '2026-09-06T02:30:00.000Z';
const initialTime = Date.parse(observed);
const allocation = { USDG: 500, AAPL: 2375, NVDA: 2375, MSFT: 2375, AMD: 2375 };
const current = {
  app: 'Rebalance', nativeBalance: '400000000000000', updatedAt: observed,
  config: { targets: allocation },
  portfolio: { totalUsdE8: '500000000', positions: Object.entries(allocation).map(([id, weightBps]) => ({ id, symbol: id, weightBps, balance: '1' })) },
};
const quote = { gasPriceWei: '20000000', ethUsdE8: '200000000000', gasObservedAt: observed, usdObservedAt: observed };
type DisplayNode = { tag: string; textContent: string; attrs: Record<string, string>; children: DisplayNode[]; replaceChildren: () => void; append: (child: DisplayNode) => void; setAttribute: (key: string, value: string) => void };
type Response = { ok: boolean; json: () => Promise<unknown> };
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

async function browser(options: { gas?: () => Promise<Response> } = {}) {
  const script = await readFile(new URL('../ui/app.js', import.meta.url), 'utf8');
  const elements = new Map<string, DisplayNode>();
  const lifecycle = new Map<string, () => void>();
  const timers = new Map<number, { fn: () => void; at: number }>();
  const calls: { url: string; at: number; signal: AbortSignal }[] = [];
  let now = initialTime, nextTimer = 0, pieRenders = 0;
  let getGas = options.gas || (async () => ({ ok: true, json: async () => quote }));
  function node(tag: string, id?: string): DisplayNode {
    const item: DisplayNode = { tag, textContent: '', attrs: {}, children: [], replaceChildren: () => { item.children = []; if (id === 'segments') pieRenders++; }, append: child => item.children.push(child), setAttribute: (key, value) => { item.attrs[key] = value; } };
    return item;
  }
  class ClockDate extends Date {
    constructor(value?: string | number) { super(value === undefined ? now : value); }
    static override now() { return now; }
  }
  class Source {
    static instances: Source[] = [];
    handlers = new Map<string, (event: { data: string }) => void>();
    onerror?: () => void;
    closed = false;
    constructor() { Source.instances.push(this); }
    addEventListener(name: string, handler: (event: { data: string }) => void) { this.handlers.set(name, handler); }
    close() { this.closed = true; }
    send(snapshot: unknown) { this.handlers.get('status')!({ data: JSON.stringify(snapshot) }); }
  }
  runInNewContext(script, {
    Date: ClockDate, EventSource: Source, AbortController,
    setTimeout: (fn: () => void, ms: number) => { const id = ++nextTimer; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout: (id: number) => timers.delete(id),
    fetch: async (url: string, request: { signal: AbortSignal }) => {
      calls.push({ url, at: now, signal: request.signal });
      return url === '/api/gas' ? getGas() : { ok: true, json: async () => current };
    },
    window: { addEventListener: (name: string, handler: () => void) => lifecycle.set(name, handler) },
    document: {
      getElementById: (id: string) => { if (!elements.has(id)) elements.set(id, node('text', id)); return elements.get(id); },
      createElementNS: (_namespace: string, tag: string) => node(tag),
    },
  });
  const source = Source.instances[0]!;
  source.send(current);
  await flush();
  return {
    element: (id: string) => elements.get(id)!,
    get renders() { return pieRenders; }, get now() { return now; },
    calls, timers, source,
    setGas(fn: () => Promise<Response>) { getGas = fn; },
    hide() { lifecycle.get('pagehide')!(); },
    show() { lifecycle.get('pageshow')!(); },
    async advance(ms: number) {
      const target = now + ms;
      for (let i = 0; i < 100; i++) {
        const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) { now = target; await flush(); return; }
        now = next[1].at; timers.delete(next[0]); next[1].fn(); await flush();
      }
      throw new Error('Unexpected timer loop');
    },
  };
}

test('actual and target rings share stable colors/order despite different configuration insertion order', async () => {
  const page = await browser();
  page.source.send({ ...current, config: { targets: { AMD: 2375, MSFT: 2375, NVDA: 2375, AAPL: 2375, USDG: 500 } } });
  const actual = page.element('segments').children;
  const targets = page.element('target-segments').children;
  assert.equal(actual.length, 5); assert.equal(targets.length, 5);
  assert.deepEqual(actual.map(node => node.attrs.stroke), targets.map(node => node.attrs.stroke));
  assert.deepEqual(actual.map(node => node.attrs['stroke-dashoffset']), targets.map(node => node.attrs['stroke-dashoffset']));
  assert.deepEqual(actual.map(node => node.attrs['stroke-dasharray']), targets.map(node => node.attrs['stroke-dasharray']));
  assert.equal(Number(actual[0]!.attrs['stroke-dashoffset']), -0.25, 'both rings center the same half-percent gap across their start boundary');
  assert.ok(targets.every(node => Number(node.attrs.r) + Number(node.attrs['stroke-width']) / 2 < 125));
  assert.equal(page.element('comparison').textContent, 'Outer actual · Inner target');
  assert.match(page.element('chart-description').textContent, /Inner ring, targets: USDG 5%/);
  assert.equal(page.element('labels').children.filter(node => node.attrs.class === 'target-weight').length, 5);
  assert.ok(!actual.some(node => node.textContent.includes('ETH')));
  page.hide();
});

test('label rectangles clear the outer ring even after vertical collision spacing', async () => {
  const page = await browser();
  for (const weights of [[500, 2375, 2375, 2375, 2375], [100, 9400, 200, 100, 200], [0, 10000, 0, 0, 0]]) {
    page.source.send({ ...current, portfolio: { ...current.portfolio, positions: current.portfolio.positions.map((p, i) => ({ ...p, weightBps: weights[i] })) } });
    const labels = page.element('labels').children;
    for (let index = 0; index < labels.length; index += 3) {
      const ticker = labels[index]!;
      const x = Number(ticker.attrs.x), y = Number(ticker.attrs.y);
      const closestX = Math.max(0, Math.abs(x - 270) - 35);
      const top = y - 15, bottom = y + 38;
      const closestY = top > 270 ? top - 270 : bottom < 270 ? 270 - bottom : 0;
      assert.ok(Math.hypot(closestX, closestY) >= 206.999, `${ticker.textContent} text must clear the 203px outer radius`);
      assert.ok(x - 35 >= -15 && x + 35 <= 555, `${ticker.textContent} stays inside the SVG horizontal viewBox`);
    }
  }
  page.hide();
});

test('a target with no holdings gets its own target slice and an explicit zero actual label', async () => {
  const page = await browser();
  const positions = current.portfolio.positions.map(p => ({ ...p, weightBps: p.id === 'AAPL' ? 10000 : 0 }));
  page.source.send({ ...current, portfolio: { ...current.portfolio, positions } });
  assert.equal(page.element('segments').children.length, 1);
  assert.equal(page.element('target-segments').children.length, 5);
  const labels = page.element('labels').children;
  assert.equal(labels.filter(node => node.textContent === '0%').length, 4);
  assert.equal(labels.filter(node => node.attrs.class === 'ticker').length, 5);
  page.hide();
});

test('empty and unobserved wallets show only explicitly labeled targets', async () => {
  const page = await browser();
  page.source.send({ ...current, portfolio: { totalUsdE8: '0', positions: current.portfolio.positions.map(p => ({ ...p, balance: '0', weightBps: 0 })) } });
  assert.equal(page.element('state').textContent, 'Targets');
  assert.equal(page.element('note').textContent, 'Wallet empty');
  assert.equal(page.element('comparison').textContent, '');
  assert.equal(page.element('segments').children.length, 5);
  assert.equal(page.element('target-segments').children.length, 0);
  assert.match(page.element('chart-description').textContent, /Targets only/);
  page.source.send({ ...current, portfolio: null });
  assert.equal(page.element('note').textContent, 'Holdings not checked');
  assert.equal(page.element('target-segments').children.length, 0);
  page.hide();
});

test('read failures preserve actual/target comparison as last known holdings', async () => {
  const page = await browser();
  page.source.send({ ...current, error: 'Read unavailable' });
  assert.equal(page.element('state').textContent, 'Last known holdings');
  assert.equal(page.element('note').textContent, 'Update unavailable');
  assert.equal(page.element('target-segments').children.length, 5);
  assert.match(page.element('gas').textContent, /last known/);
  page.hide();
});

test('gas balance, dollar conversion and per-unit gas price use exact integer scaling', async () => {
  const page = await browser();
  assert.equal(page.element('gas').textContent, 'Gas · 0.0004 ETH · $0.80');
  assert.equal(page.element('gas-price').textContent, 'Gas price · 0.02 gwei · $0.00000004 / gas');
  assert.match(page.element('gas').attrs['aria-label']!, /Coinbase ETH\/USD spot/);
  assert.match(page.element('gas-price').attrs['aria-label']!, /Robinhood RPC eth_gasPrice/);
  assert.match(page.element('gas-price').attrs['aria-label']!, /not a transaction fee/);
  page.hide();
});

test('zero values stay zero and subprecision positive values are never rounded into zero', async () => {
  const page = await browser({ gas: async () => ({ ok: true, json: async () => ({ ...quote, gasPriceWei: '1' }) }) });
  page.source.send({ ...current, nativeBalance: '1' });
  assert.match(page.element('gas').textContent, /0\.000000000000000001 ETH · <\$0\.01/);
  assert.match(page.element('gas-price').textContent, /0\.000000001 gwei · <\$0\.000000000001 \/ gas/);
  page.source.send({ ...current, nativeBalance: '0' });
  assert.equal(page.element('gas').textContent, 'Gas · 0 ETH · $0.00');
  page.hide();
});

test('invalid or missing native balances and quote fields remain unavailable', async () => {
  const page = await browser({ gas: async () => ({ ok: true, json: async () => ({ ...quote, gasPriceWei: '-1', ethUsdE8: '0' }) }) });
  for (const nativeBalance of [null, undefined, 'invalid', '-1', 0, '1e18', '0'.repeat(79)]) {
    page.source.send({ ...current, nativeBalance });
    assert.equal(page.element('gas').textContent, 'ETH gas · unavailable · USD unavailable');
  }
  assert.equal(page.element('gas-price').textContent, 'Gas price · unavailable · USD unavailable');
  page.hide();
});

test('quote refreshes are bounded to 30 seconds and only update gas labels', async () => {
  const page = await browser();
  assert.equal(page.renders, 1);
  assert.equal(page.calls.filter(call => call.url === '/api/gas').length, 1);
  page.setGas(async () => ({ ok: true, json: async () => ({ ...quote, gasPriceWei: '30000000', gasObservedAt: new Date(page.now).toISOString() }) }));
  await page.advance(29999);
  assert.equal(page.calls.length, 1);
  await page.advance(1);
  assert.equal(page.calls.length, 2);
  assert.equal(page.renders, 1, 'gas quote update never redraws the rings');
  assert.match(page.element('gas-price').textContent, /0\.03 gwei/);
  page.hide();
});

test('HTTP quote failures retain prior values labeled last known', async () => {
  const page = await browser();
  page.setGas(async () => ({ ok: false, json: async () => null }));
  await page.advance(30000);
  assert.match(page.element('gas').textContent, /\$0\.80 last known/);
  assert.match(page.element('gas-price').textContent, /0\.02 gwei last known/);
  assert.match(page.element('gas-price').textContent, /\$0\.00000004 \/ gas last known/);
  assert.equal(page.renders, 1);
  page.hide();
});

test('gas and USD observations expire independently even while the status stream stays healthy', async () => {
  const page = await browser({ gas: async () => ({ ok: true, json: async () => ({ ...quote, usdObservedAt: new Date(initialTime - 60000).toISOString() }) }) });
  await page.advance(30000);
  page.source.send({ ...current, updatedAt: new Date(page.now).toISOString() });
  assert.match(page.element('gas').textContent, /\$0\.80 last known/);
  assert.match(page.element('gas-price').textContent, /0\.02 gwei ·/);
  assert.match(page.element('gas-price').textContent, /\/ gas last known/);
  await page.advance(60000);
  assert.match(page.element('gas-price').textContent, /0\.02 gwei last known/);
  page.hide();
});

test('partial malformed quote updates retain only the failed source as last known', async () => {
  const page = await browser();
  page.setGas(async () => ({ ok: true, json: async () => ({ ...quote, ethUsdE8: null, gasPriceWei: '30000000', gasObservedAt: new Date(page.now).toISOString() }) }));
  await page.advance(30000);
  assert.match(page.element('gas').textContent, /\$0\.80 last known/);
  assert.match(page.element('gas-price').textContent, /0\.03 gwei ·/);
  assert.match(page.element('gas-price').textContent, /\$0\.00000006 \/ gas last known/);
  page.hide();
});

test('suspending the page aborts quotes and ignores late responses across restoration', async () => {
  let resolveQuote: ((value: Response) => void) | undefined;
  const page = await browser({ gas: () => new Promise<Response>(resolve => { resolveQuote = resolve; }) });
  const first = page.calls[0]!;
  page.hide();
  assert.equal(first.signal.aborted, true);
  assert.equal(page.timers.size, 0);
  page.show();
  assert.equal(page.calls.filter(call => call.url === '/api/gas').length, 1, 'restoring cannot exceed the quote refresh rate');
  resolveQuote!({ ok: true, json: async () => quote });
  await flush();
  assert.match(page.element('gas').textContent, /USD unavailable/);
  page.setGas(async () => ({ ok: true, json: async () => ({ ...quote, ethUsdE8: '300000000000', usdObservedAt: new Date(page.now).toISOString() }) }));
  await page.advance(30000);
  assert.match(page.element('gas').textContent, /\$1\.20/);
  page.hide();
});

test('a hanging gas request has a five-second abort deadline and no concurrent retries', async () => {
  const page = await browser({ gas: () => new Promise<Response>(() => {}) });
  await page.advance(5000);
  assert.equal(page.calls[0]!.signal.aborted, true);
  await page.advance(30000);
  assert.equal(page.calls.filter(call => call.url === '/api/gas').length, 1);
  page.hide();
  assert.equal(page.timers.size, 0);
});
