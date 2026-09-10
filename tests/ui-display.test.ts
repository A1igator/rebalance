import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import { evaluatePortfolio, planTrade } from '../src/core.js';

const observed = '2026-09-06T02:30:00.000Z';
const initialTime = Date.parse(observed);
const allocation = { USDG: 500, AAPL: 2375, NVDA: 2375, MSFT: 2375, AMD: 2375 };
const wallet = '0x1111111111111111111111111111111111111111';
const current = {
  app: 'Rebalance', nativeBalance: '400000000000000', updatedAt: observed,
  chain: { id: 4663 }, wallet,
  graph: { node: 'plan' }, error: null, operation: null, armed: true,
  config: { targets: allocation },
  portfolio: { totalUsdE8: '500000000', positions: Object.entries(allocation).map(([id, weightBps]) => ({ id, symbol: id, weightBps, balance: '1', valueUsdE8: String(weightBps * 50000) })) },
};
const reference = { chainId: 4663, swapGas: '168785', approvalGas: '57976', swapHash: `0x${'1'.repeat(64)}`, approvalHash: `0x${'2'.repeat(64)}` };
const projection = { swaps: 2, observedAt: observed, wallet, targets: allocation, balances: Object.fromEntries(Object.keys(allocation).map(id => [id, '1'])) };
const quote = { gasPriceWei: '20000000', ethUsdE8: '200000000000', gasObservedAt: observed, usdObservedAt: observed, reference, rebalance: projection };
type DisplayNode = { tag: string; textContent: string; attrs: Record<string, string>; children: DisplayNode[];
  classes: Set<string>; style: Record<string, string>; parentNode: DisplayNode | null; listeners: Map<string, () => void>;
  classList: { add: (name: string) => void; remove: (name: string) => void; toggle: (name: string, on?: boolean) => void; contains: (name: string) => boolean };
  replaceChildren: () => void; append: (child: DisplayNode) => void; remove: () => void;
  addEventListener: (name: string, handler: () => void) => void; setAttribute: (key: string, value: string) => void };
type Response = { ok: boolean; json: () => Promise<unknown> };
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

async function browser(options: { gas?: () => Promise<Response>; status?: () => Promise<Response> } = {}) {
  const [ringScript, script, html] = await Promise.all(['allocation-ring.js', 'app.js', 'index.html']
    .map(file => readFile(new URL(`../ui/${file}`, import.meta.url), 'utf8')));
  const htmlIds = new Set([...html!.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
  const elements = new Map<string, DisplayNode>();
  const lifecycle = new Map<string, () => void>();
  const timers = new Map<number, { fn: () => void; at: number }>();
  const calls: { url: string; at: number; signal: AbortSignal }[] = [];
  let now = initialTime, nextTimer = 0, pieRenders = 0;
  let getGas = options.gas || (async () => ({ ok: true, json: async () => quote }));
  const getStatus = options.status || (async () => ({ ok: true, json: async () => current }));
  function node(tag: string, id?: string): DisplayNode {
    const item = {
      tag, textContent: '', attrs: {} as Record<string, string>, children: [] as DisplayNode[],
      classes: new Set<string>(), style: {} as Record<string, string>, parentNode: null as DisplayNode | null,
      listeners: new Map<string, () => void>(),
      replaceChildren: () => { item.children = []; },
      append: (child: DisplayNode) => { if (child.parentNode) child.parentNode.children = child.parentNode.children.filter(c => c !== child); child.parentNode = item; item.children.push(child); },
      remove: () => { if (item.parentNode) item.parentNode.children = item.parentNode.children.filter(c => c !== item); item.parentNode = null; },
      addEventListener: (name: string, handler: () => void) => { item.listeners.set(name, handler); },
      setAttribute: (key: string, value: string) => { item.attrs[key] = value; },
    } as DisplayNode;
    item.classList = {
      add: (name: string) => { item.classes.add(name); },
      remove: (name: string) => { item.classes.delete(name); },
      toggle: (name: string, on?: boolean) => { const next = on === undefined ? !item.classes.has(name) : on; if (next) item.classes.add(name); else item.classes.delete(name); },
      contains: (name: string) => item.classes.has(name),
    };
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
  const context = createContext({
    Date: ClockDate, EventSource: Source, AbortController,
    setTimeout: (fn: () => void, ms: number) => { const id = ++nextTimer; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout: (id: number) => timers.delete(id),
    fetch: async (url: string, request: { signal: AbortSignal }) => {
      calls.push({ url, at: now, signal: request.signal });
      return url === '/api/gas' ? getGas() : getStatus();
    },
    window: { addEventListener: (name: string, handler: () => void) => lifecycle.set(name, handler) },
    document: {
      getElementById: (id: string) => { if (!htmlIds.has(id)) return null; if (id === 'arcs') pieRenders++; if (!elements.has(id)) elements.set(id, node('text', id)); return elements.get(id); },
      createElementNS: (_namespace: string, tag: string) => node(tag),
    },
  });
  runInContext(ringScript, context);
  runInContext(script, context);
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

function assertSector(node: DisplayNode, startPercent: number, endPercent: number, innerRadius: number, outerRadius: number) {
  assert.equal(node.tag, 'path', 'partial allocations use bounded filled sectors instead of repeating circle dashes');
  assert.ok(node.attrs.fill && node.attrs.fill !== 'none');
  for (const attribute of ['stroke', 'stroke-width', 'stroke-dasharray', 'stroke-dashoffset', 'pathLength']) {
    assert.equal(node.attrs[attribute], undefined, 'colored sectors cannot paint beyond their geometric boundaries');
  }
  const parts = node.attrs.d!.match(/[MLAZ]|[-+]?(?:\d*\.?\d+)(?:e[-+]?\d+)?/gi)!;
  assert.equal(parts.length, 23);
  assert.deepEqual([parts[0], parts[3], parts[11], parts[14], parts[22]], ['M', 'A', 'L', 'A', 'Z']);
  const largeArc = endPercent - startPercent > 50 ? 1 : 0;
  assert.deepEqual(parts.slice(4, 9).map(Number), [outerRadius, outerRadius, 0, largeArc, 1], 'outer arc follows the full clockwise allocation');
  assert.deepEqual(parts.slice(15, 20).map(Number), [innerRadius, innerRadius, 0, largeArc, 0], 'inner arc closes the same allocation counterclockwise');
  for (const [index, radius, percent] of [[1, outerRadius, startPercent], [9, outerRadius, endPercent], [12, innerRadius, endPercent], [20, innerRadius, startPercent]]) {
    const angle = percent! * Math.PI / 50;
    assert.ok(Math.abs(Number(parts[index!]) - 270 - radius! * Math.cos(angle)) < 1e-8, 'sector endpoints stay on the exact allocation boundary');
    assert.ok(Math.abs(Number(parts[index! + 1]) - 270 - radius! * Math.sin(angle)) < 1e-8, 'sector endpoints stay on the exact allocation boundary');
  }
}

test('actual and target rings share stable colors/order despite different configuration insertion order', async () => {
  const page = await browser();
  page.source.send({ ...current, config: { targets: { AMD: 2375, MSFT: 2375, NVDA: 2375, AAPL: 2375, USDG: 500 } } });
  const actual = page.element('arcs').children;
  const targets = page.element('targets').children;
  assert.equal(actual.length, 5); assert.equal(targets.length, 5);
  assert.deepEqual(actual.map(node => node.attrs.stroke), targets.map(node => node.attrs.stroke));
  assert.deepEqual(actual.map(node => node.attrs['stroke-dashoffset']), targets.map(node => node.attrs['stroke-dashoffset']));
  assert.deepEqual(actual.map(node => node.attrs['stroke-dasharray']), targets.map(node => node.attrs['stroke-dasharray']));
  assert.equal(Math.abs(Number(actual[0]!.attrs['stroke-dashoffset'])), 0, 'colored segments start at the true allocation boundary');
  assert.ok(targets.every(node => Number(node.attrs.r) + Number(node.attrs['stroke-width']) / 2 < 128));
  assert.equal(page.element('c-legend').textContent, '', 'a funded ring needs no legend: every row names its own target');
  assert.match(page.element('chart-description').textContent, /Inner ring, targets: USDG 5%/);
  assert.ok(!actual.some(node => node.textContent.includes('ETH')));
  page.hide();
});

test('slice gaps never enlarge an allocation and always leave a dust slice visible', async () => {
  const page = await browser();
  const weights = [1, 2499, 2500, 2500, 2500];
  const targets = Object.fromEntries(Object.keys(allocation).map((id, index) => [id, weights[index]]));
  page.source.send({ ...current, config: { targets }, portfolio: { ...current.portfolio, positions: current.portfolio.positions.map((p, index) => ({ ...p, weightBps: weights[index] })) } });
  for (const container of ['arcs', 'targets'] as const) {
    const segments = page.element(container).children;
    assert.equal(segments.length, 5);
    const shares = weights.map(weight => weight / 100);
    segments.forEach((segment, index) => {
      const drawn = Number(segment.attrs['stroke-dasharray']!.split(' ')[0]);
      assert.ok(drawn <= shares[index]! + 1e-12, 'a gap never draws more than the true allocation share');
      assert.ok(drawn >= shares[index]! / 2 - 1e-12, 'at least half of every slice survives its gap');
    });
    assert.ok(Number(segments[0]!.attrs['stroke-dasharray']!.split(' ')[0]) > 0, 'a 0.01 percent dust slice stays visible');
  }
  page.hide();
});

test('a single full allocation is drawn without an artificial seam', async () => {
  const page = await browser();
  page.source.send({ ...current, portfolio: { ...current.portfolio, positions: current.portfolio.positions.map(p => ({ ...p, weightBps: p.id === 'AAPL' ? 10000 : 0 })) } });
  assert.equal(page.element('arcs').children.length, 1);
  assert.equal(page.element('arcs').children[0]!.attrs['stroke-dasharray'], '100 0');
  page.hide();
});

test('every asset gets one ring label, and only an out-of-band one is flagged', async () => {
  const page = await browser();
  const weights = [500, 2900, 2200, 2200, 2200];
  page.source.send({ ...current, config: { targets: allocation, driftThresholdBps: 500 },
    portfolio: { ...current.portfolio, positions: current.portfolio.positions.map((p, i) => ({ ...p, weightBps: weights[i], valueUsdE8: String(weights[i]! * 50000) })) } });
  const groups = page.element('labels').children;
  assert.equal(groups.length, 5, 'one label per asset, and no holdings list');
  assert.deepEqual(groups.map(g => g.children[0]!.textContent), ['USDG', 'AAPL', 'NVDA', 'MSFT', 'AMD']);
  assert.deepEqual(groups.map(g => g.children[1]!.textContent), ['5%', '29%', '22%', '22%', '22%']);
  assert.equal(groups.filter(g => g.attrs.class === 'label-out').length, 1, 'only the holding past the band is flagged');
  assert.equal(groups[1]!.attrs.class, 'label-out');
  page.hide();
});

test('ring labels clear the ring and stay inside the viewBox after collision spacing', async () => {
  const page = await browser();
  for (const weights of [[500, 2375, 2375, 2375, 2375], [100, 9400, 200, 100, 200], [0, 10000, 0, 0, 0]]) {
    page.source.send({ ...current, portfolio: { ...current.portfolio, positions: current.portfolio.positions.map((p, i) => ({ ...p, weightBps: weights[i], valueUsdE8: String(weights[i]! * 50000) })) } });
    for (const group of page.element('labels').children) {
      const [ticker, weight] = group.children;
      const x = Number(ticker!.attrs.x), y = Number(ticker!.attrs.y);
      // The whole two-line block, not just its first line, must clear the ring.
      const top = y - 12, bottom = y + 42;
      const horizontal = Math.max(0, Math.abs(x - 210) - 40);
      const vertical = top > 210 ? top - 210 : bottom < 210 ? 210 - bottom : 0;
      assert.ok(Math.hypot(horizontal, vertical) >= 185.99, `${ticker!.textContent} text must clear the 172px outer ring`);
      assert.equal(Number(weight!.attrs.x), x, 'both lines share one anchor');
      assert.ok(x - 40 >= -60 && x + 40 <= 500, 'text stays inside the horizontal viewBox');
      assert.ok(top >= -20 && bottom <= 460, 'text stays inside the vertical viewBox');
    }
  }
  page.hide();
});

test('receipt progress stays in the center and a pending swap uses only a ghost arc', async () => {
  const page = await browser();
  const hash = `0x${'a'.repeat(64)}`;
  page.source.send({ ...current, operation: { status: 'pending', kind: 'swap', hash }, proposal: { sellAssetId: 'AAPL', buyAssetId: 'USDG', amountIn: '1', reason: 'Sell overweight AAPL into USDG' } });
  assert.equal(page.element('c-state').textContent, 'Rebalancing');
  assert.equal(page.element('c-sub').textContent, 'AAPL → USDG', 'the centre names the pair, not a second copy of the state');
  assert.equal(page.element('c-val').textContent, 'Waiting for receipt', 'mid-trade the send state replaces the portfolio total');
  assert.ok(page.element('ghost').classes.has('show'), 'a pending swap shows where the holding is heading');
  page.source.send({ ...current, operation: { status: 'confirmed', hash, blockNumber: '55516741' } });
  assert.ok(!page.element('ghost').classes.has('show'), 'a settled swap moves the arc instead of ghosting it');
  page.hide();
});

test('a target with no holdings still gets its own target slice', async () => {
  const page = await browser();
  const positions = current.portfolio.positions.map(p => ({ ...p, weightBps: p.id === 'AAPL' ? 10000 : 0 }));
  page.source.send({ ...current, portfolio: { ...current.portfolio, positions } });
  assert.equal(page.element('arcs').children.length, 1);
  assert.equal(page.element('targets').children.length, 5);
  page.hide();
});

test('empty and unobserved wallets show only explicitly labeled targets', async () => {
  const page = await browser();
  page.source.send({ ...current, portfolio: { totalUsdE8: '0', positions: current.portfolio.positions.map(p => ({ ...p, balance: '0', weightBps: 0 })) } });
  assert.equal(page.element('c-state').textContent, 'Targets');
  assert.equal(page.element('c-sub').textContent, 'Wallet empty');
  assert.equal(page.element('c-val').textContent, '');
  assert.equal(page.element('c-legend').textContent, 'Targets only');
  assert.equal(page.element('arcs').children.length, 5);
  assert.equal(page.element('targets').children.length, 0);
  assert.match(page.element('chart-description').textContent, /Targets only/);
  page.source.send({ ...current, portfolio: null });
  assert.equal(page.element('c-sub').textContent, 'Holdings not checked');
  assert.equal(page.element('targets').children.length, 0);
  page.hide();
});

test('read failures preserve actual/target comparison as last known holdings', async () => {
  const page = await browser();
  page.source.send({ ...current, error: 'Read unavailable' });
  assert.equal(page.element('c-state').textContent, 'Last known');
  assert.equal(page.element('c-sub').textContent, 'Update unavailable');
  assert.equal(page.element('targets').children.length, 5);
  assert.match(page.element('gas').textContent, /last known/);
  page.hide();
});

test('gas balance, dollar conversion and per-unit gas price use exact integer scaling', async () => {
  const page = await browser();
  assert.equal(page.element('gas').textContent, '0.0004 ETH · $0.80');
  assert.equal(page.element('gas-price').textContent, '0.02 gwei');
  assert.match(page.element('gas-price').attrs['aria-label']!, /\$0\.00000004 \/ gas/);
  assert.equal(page.element('gas-estimate').textContent, '≈<$0.01 · +<$0.01 approval');
  assert.equal(page.element('gas-rebalance').textContent, '≈$0.01–$0.02 · 2 swaps');
  assert.match(page.element('gas').attrs['aria-label']!, /Coinbase ETH\/USD spot/);
  assert.match(page.element('gas-price').attrs['aria-label']!, /Robinhood RPC eth_gasPrice/);
  assert.match(page.element('gas-price').attrs['aria-label']!, /not a transaction fee/);
  page.hide();
});

test('zero values stay zero and subprecision positive values are never rounded into zero', async () => {
  const page = await browser({ gas: async () => ({ ok: true, json: async () => ({ ...quote, gasPriceWei: '1' }) }) });
  page.source.send({ ...current, nativeBalance: '1' });
  assert.match(page.element('gas').textContent, /0\.000000000000000001 ETH · <\$0\.01/);
  assert.match(page.element('gas-price').textContent, /<0\.01 gwei/);
  assert.match(page.element('gas-price').attrs['aria-label']!, /<\$0\.000000000001 \/ gas/);
  page.source.send({ ...current, nativeBalance: '0' });
  assert.equal(page.element('gas').textContent, '0 ETH · $0.00');
  page.hide();
});

test('invalid or missing native balances and quote fields remain unavailable', async () => {
  const page = await browser({ gas: async () => ({ ok: true, json: async () => ({ ...quote, gasPriceWei: '-1', ethUsdE8: '0' }) }) });
  for (const nativeBalance of [null, undefined, 'invalid', '-1', 0, '1e18', '0'.repeat(79)]) {
    page.source.send({ ...current, nativeBalance });
    assert.equal(page.element('gas').textContent, 'unavailable');
  }
  assert.equal(page.element('gas-price').textContent, 'unavailable');
  assert.equal(page.element('gas-estimate').textContent, 'unavailable');
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
  assert.match(page.element('gas').textContent, /\$0\.80 · last known/);
  assert.match(page.element('gas-price').textContent, /0\.02 gwei · last known/);
  assert.match(page.element('gas-price').attrs['aria-label']!, /\$0\.00000004 \/ gas last known/);
  assert.match(page.element('gas-estimate').textContent, /last known/);
  assert.equal(page.renders, 1);
  page.hide();
});

test('gas and USD observations expire independently even while the status stream stays healthy', async () => {
  const page = await browser({ gas: async () => ({ ok: true, json: async () => ({ ...quote, usdObservedAt: new Date(initialTime - 60000).toISOString() }) }) });
  await page.advance(30000);
  page.source.send({ ...current, updatedAt: new Date(page.now).toISOString() });
  assert.match(page.element('gas').textContent, /\$0\.80 · last known/);
  assert.equal(page.element('gas-price').textContent, '0.02 gwei');
  assert.match(page.element('gas-price').attrs['aria-label']!, /\/ gas last known/);
  await page.advance(60000);
  assert.match(page.element('gas-price').textContent, /0\.02 gwei · last known/);
  page.hide();
});

test('partial malformed quote updates retain only the failed source as last known', async () => {
  const page = await browser();
  page.setGas(async () => ({ ok: true, json: async () => ({ ...quote, ethUsdE8: null, gasPriceWei: '30000000', gasObservedAt: new Date(page.now).toISOString() }) }));
  await page.advance(30000);
  assert.match(page.element('gas').textContent, /\$0\.80 · last known/);
  assert.equal(page.element('gas-price').textContent, '0.03 gwei');
  assert.match(page.element('gas-price').attrs['aria-label']!, /\$0\.00000006 \/ gas last known/);
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

test('transaction estimates multiply the observed rate by historical swap and approval gas', async () => {
  const page = await browser({ gas: async () => ({ ok: true, json: async () => ({ ...quote, gasPriceWei: '417860000', ethUsdE8: '250205000000' }) }) });
  assert.equal(page.element('gas-price').textContent, '0.42 gwei');
  assert.equal(page.element('gas-estimate').textContent, '≈$0.18 · +$0.06 approval');
  assert.equal(page.element('gas-rebalance').textContent, '≈$0.35–$0.47 · 2 swaps');
  assert.match(page.element('gas-estimate').attrs['aria-label']!, /historical single-pool receipts/);
  assert.match(page.element('gas-rebalance').attrs['aria-label']!, /zero to one approval per swap leg/);
  assert.match(page.element('gas-rebalance').attrs['aria-label']!, /exclude market movement, liquidity-provider fees and slippage/);
  page.hide();
});

test('a fresh matching zero-swap projection costs zero even when price sources are unavailable', async () => {
  const page = await browser({ gas: async () => ({ ok: true, json: async () => ({ ...quote, gasPriceWei: null, ethUsdE8: null, rebalance: { ...projection, swaps: 0 } }) }) });
  assert.equal(page.element('gas-estimate').textContent, 'unavailable');
  assert.equal(page.element('gas-rebalance').textContent, '$0 · on target');
  page.hide();
});

test('a changed wallet, target allocation or holding balance invalidates an earlier projection immediately', async () => {
  const page = await browser({ gas: async () => ({ ok: true, json: async () => ({ ...quote, rebalance: { ...projection, swaps: 0 } }) }) });
  for (const next of [
    { ...current, wallet: '0x2222222222222222222222222222222222222222' },
    { ...current, chain: { id: 1 } },
    { ...current, config: { targets: { ...allocation, USDG: 600, AAPL: 2275 } } },
    { ...current, portfolio: { ...current.portfolio, positions: current.portfolio.positions.map((p, i) => ({ ...p, balance: i === 0 ? '2' : p.balance })) } },
  ]) {
    page.source.send(next);
    assert.equal(page.element('gas-rebalance').textContent, 'unavailable');
  }
  page.source.send({ ...current, config: { targets: { AMD: 2375, MSFT: 2375, NVDA: 2375, AAPL: 2375, USDG: 500 } }, portfolio: { ...current.portfolio, positions: [...current.portfolio.positions].reverse() } });
  assert.equal(page.element('gas-rebalance').textContent, '$0 · on target', 'insertion order does not invalidate matching projection content');
  page.hide();
});

test('fresh null projections clear retained estimates instead of preserving an old zero cost', async () => {
  const page = await browser({ gas: async () => ({ ok: true, json: async () => ({ ...quote, rebalance: { ...projection, swaps: 0 } }) }) });
  assert.equal(page.element('gas-rebalance').textContent, '$0 · on target');
  page.setGas(async () => ({ ok: true, json: async () => ({ ...quote, rebalance: null }) }));
  await page.advance(30000);
  assert.equal(page.element('gas-rebalance').textContent, 'unavailable');
  page.hide();
});

test('stale projections are labeled last known independently of fresh price sources', async () => {
  const page = await browser({ gas: async () => ({ ok: true, json: async () => ({ ...quote, rebalance: { ...projection, swaps: 0 } }) }) });
  page.setGas(async () => ({ ok: true, json: async () => ({ ...quote, gasObservedAt: new Date(page.now).toISOString(), usdObservedAt: new Date(page.now).toISOString(), rebalance: { ...projection, swaps: 0 } }) }));
  await page.advance(90000);
  page.source.send({ ...current, updatedAt: new Date(page.now).toISOString() });
  assert.equal(page.element('gas-rebalance').textContent, '$0 · on target · last known');
  assert.doesNotMatch(page.element('gas-price').textContent, /last known/);
  page.hide();
});

test('invalid historical references or malformed projections cannot manufacture transaction estimates', async () => {
  const page = await browser({ gas: async () => ({ ok: true, json: async () => ({ ...quote, reference: { ...reference, chainId: 1 }, rebalance: { ...projection, swaps: -1 } }) }) });
  assert.equal(page.element('gas-estimate').textContent, 'unavailable');
  assert.equal(page.element('gas-rebalance').textContent, 'unavailable');
  page.setGas(async () => ({ ok: true, json: async () => ({ ...quote, reference: { ...reference, swapGas: '0' }, rebalance: { ...projection, balances: {} } }) }));
  await page.advance(30000);
  assert.equal(page.element('gas-estimate').textContent, 'unavailable');
  assert.equal(page.element('gas-rebalance').textContent, 'unavailable');
  page.hide();
});

test('new transaction or recovery states invalidate an old on-target projection before quotes refresh', async () => {
  const page = await browser({ gas: async () => ({ ok: true, json: async () => ({ ...quote, rebalance: { ...projection, swaps: 0 } }) }) });
  assert.equal(page.element('gas-rebalance').textContent, '$0 · on target');
  for (const status of ['pending', 'unresolved', 'confirming', 'reverted', 'recovery-wait', 'recovery-busy']) {
    page.source.send({ ...current, operation: { status } });
    assert.equal(page.element('gas-rebalance').textContent, 'unavailable', status);
  }
  for (const node of ['execute', 'reconcile', 'recover', 'receipt', 'error']) {
    page.source.send({ ...current, graph: { node } });
    assert.equal(page.element('gas-rebalance').textContent, 'unavailable', node);
  }
  page.source.send({ ...current, error: 'Read unavailable' });
  assert.equal(page.element('gas-rebalance').textContent, 'unavailable');
  page.source.send({ ...current, operation: { status: 'cancelled' } });
  assert.equal(page.element('gas-rebalance').textContent, '$0 · on target', 'a settled operation with the same basis remains usable');
  assert.equal(page.calls.filter(call => call.url === '/api/gas').length, 1, 'status events invalidate display without extra quote fetches');
  page.hide();
});

const subjectiveAllocation = {
  objective: 'user-risk', horizonMonths: 60, policyHash: 'a'.repeat(64), computedAt: observed,
  score: 32.4, stepBps: 500, subjectiveRiskScore: 38.1,
  expectedReturnBps: 1434.44, benchmarkReturnBps: 200, returnBasis: 'user-horizon',
};
const managedSnapshot = (summary: unknown = subjectiveAllocation) => ({
  ...current, config: { targets: allocation, allocation: summary },
});

test('the saved risk model still describes itself, and rejects what it cannot verify', async () => {
  const page = await browser();
  // The model has no caption of its own on screen any more. Its full statement
  // still reaches assistive tech through the chart description, so what the
  // page will and will not claim about a saved policy is still covered.
  const describe = () => page.element('chart-description').textContent;

  page.source.send({ ...current, config: { targets: allocation } });
  assert.match(describe(), /User risk inputs are not set/);
  assert.doesNotMatch(describe(), /Sharpe|Return\/risk/);

  page.source.send({ ...current, config: { targets: {} } });
  assert.match(describe(), /saved target risk model is unavailable/);
  assert.match(describe(), /No risk score is inferred from holdings or price movements/);

  const userRisk = { objective: 'user-risk', returnBasis: 'user-horizon', policyHash: 'a'.repeat(64),
    computedAt: observed, horizonMonths: 60, stepBps: 500, score: 32.4, expectedReturnBps: 1200,
    subjectiveRiskScore: 38.1, benchmarkReturnBps: 400 };
  page.source.send({ ...current, config: { targets: allocation, allocation: userRisk } });
  assert.match(describe(), /User-selected target risk 38\.1 points on a 0 to 100 scale over 60 months/);
  assert.match(describe(), /not a probability of loss/);
  assert.match(describe(), /not standard Sharpe/, 'the custom ratio never claims to be Sharpe');

  const sharpe = { objective: 'sharpe', returnBasis: 'history-period', policyHash: 'b'.repeat(64),
    computedAt: observed, horizonMonths: 12, stepBps: 100, score: 1.24, expectedReturnBps: 30,
    history: { interval: 'daily', basis: 'underlying-proxy', asOf: observed, quoteCurrency: 'USD' } };
  page.source.send({ ...current, config: { targets: allocation, allocation: sharpe } });
  assert.match(describe(), /Historical Sharpe 1\.24, using daily differential returns; not annualized/);
  assert.match(describe(), /underlying-asset proxy basis in USD/);
  assert.doesNotMatch(describe(), /38\.1|Return\/risk/, 'an earlier subjective model does not survive');
  page.hide();
});

test('a malformed or disconnected model never yields a fabricated number', async () => {
  const page = await browser();
  const describe = () => page.element('chart-description').textContent;
  const base = { objective: 'user-risk', returnBasis: 'user-horizon', policyHash: 'a'.repeat(64),
    computedAt: observed, horizonMonths: 60, stepBps: 500, score: 32.4, expectedReturnBps: 1200,
    subjectiveRiskScore: 38.1, benchmarkReturnBps: 400 };
  for (const [index, broken] of [
    { ...base, policyHash: 'nope' },
    { ...base, score: Number.NaN },
    { ...base, score: Number.POSITIVE_INFINITY },
    { ...base, computedAt: 'not a date' },
    { ...base, subjectiveRiskScore: 0 },
    { ...base, stepBps: 7 },
  ].entries()) {
    page.source.send({ ...current, config: { targets: allocation, allocation: broken } });
    assert.match(describe(), /saved target risk model is unavailable/, `invalid summary ${index}`);
    assert.doesNotMatch(describe(), /38\.1|32\.4|NaN|Infinity/, `invalid summary ${index} leaked a number`);
  }
  page.source.send({ ...current, config: { targets: allocation, allocation: base } });
  assert.match(describe(), /User-selected target risk 38\.1/);
  page.source.send({ ...current, config: { targets: allocation } });
  assert.match(describe(), /User risk inputs are not set/, 'a manual wallet cannot retain the prior score');
  page.hide();
});

test('a disconnected page marks the model as last saved and clears that on reconnection', async () => {
  const page = await browser({ status: async () => { throw new Error('offline'); } });
  const model = { objective: 'sharpe', returnBasis: 'history-period', policyHash: 'b'.repeat(64),
    computedAt: observed, horizonMonths: 12, stepBps: 100, score: 1.24, expectedReturnBps: 30,
    history: { interval: 'daily', basis: 'tradable-token', asOf: observed, quoteCurrency: 'USD' } };
  page.source.send({ ...current, config: { targets: allocation, allocation: model } });
  assert.doesNotMatch(page.element('chart-description').textContent, /Last saved model only/);
  page.source.onerror!();
  await page.advance(5000);
  assert.match(page.element('chart-description').textContent, /Connection unavailable\. Last saved model only/);
  page.source.send({ ...current, config: { targets: allocation, allocation: model } });
  assert.doesNotMatch(page.element('chart-description').textContent, /Last saved model only/, 'reconnection clears the prefix');
  page.hide();
});


test('a target the wallet does not hold still counts as drift', async () => {
  const page = await browser();
  // USDG has a 6% target and no balance; every held stock is only +1.5pp, so a
  // drift read over holdings alone would claim "On target" while the engine
  // sees USDG 600bps short and opens a cycle.
  const targets = { USDG: 600, AAPL: 2350, NVDA: 2350, MSFT: 2350, AMD: 2350 };
  const positions = current.portfolio.positions.map(p =>
    ({ ...p, weightBps: p.id === 'USDG' ? 0 : 2500, balance: p.id === 'USDG' ? '0' : '1', valueUsdE8: p.id === 'USDG' ? '0' : '125000000' }));
  page.source.send({ ...current, config: { targets, driftThresholdBps: 500 },
    portfolio: { ...current.portfolio, positions } });
  assert.equal(page.element('c-state').textContent, 'Off target');
  assert.equal(page.element('c-sub').textContent, 'USDG −6%');
  page.hide();
});

test('the off-target boundary matches the engine, which trades above the band', async () => {
  const page = await browser();
  // One asset off by exactly `drift`, the three others absorbing it evenly, so
  // the weights still total 10000 and AAPL is the only meaningful deviation.
  const at = (drift: number) => ({ ...current, config: { targets: allocation, driftThresholdBps: 300 },
    portfolio: { ...current.portfolio, positions: current.portfolio.positions.map(p =>
      ({ ...p, weightBps: p.id === 'AAPL' ? 2375 + drift : p.id === 'USDG' ? 500 : 2375 - drift / 3,
        valueUsdE8: String((p.id === 'AAPL' ? 2375 + drift : p.id === 'USDG' ? 500 : 2375 - drift / 3) * 50000) })) } });
  page.source.send(at(300));
  assert.equal(page.element('c-state').textContent, 'On target', 'exactly at the band does not trade, so it is not off target');
  page.source.send(at(303));
  assert.equal(page.element('c-state').textContent, 'Off target');
  page.hide();
});

test('a zero drift band does not invert the display', async () => {
  const page = await browser();
  // src/config.ts accepts driftThresholdBps 0. With a `>=` comparison every
  // asset would read as out of band and a perfect portfolio would render
  // "Off target" with every label flagged.
  page.source.send({ ...current, config: { targets: allocation, driftThresholdBps: 0 } });
  assert.equal(page.element('c-state').textContent, 'On target');
  assert.equal(page.element('labels').children.filter(g => g.attrs.class === 'label-out').length, 0);
  page.hide();
});

test('a stopped runner is the headline, without hiding the drift reading', async () => {
  const page = await browser();
  page.source.send({ ...current, armed: false, config: { targets: allocation, driftThresholdBps: 500 } });
  assert.equal(page.element('c-state').textContent, 'Paused');
  assert.equal(page.element('c-sub').textContent, '0% off target', 'a stopped runner still reports where the portfolio stands');
  page.hide();
});

test('a gas rate below the displayed place shows as a bound, never as zero', async () => {
  const page = await browser({ gas: async () => ({ ok: true, json: async () => ({ ...quote, gasPriceWei: '1' }) }) });
  await page.advance(0);
  assert.equal(page.element('gas-price').textContent, '<0.01 gwei', 'one wei is positive, so it must not read as 0.00');
  assert.match(page.element('gas-price').attrs['aria-label']!, /Robinhood RPC eth_gasPrice/);
  page.hide();
});

test('a label near a canvas edge slides its stack instead of collapsing the side', async () => {
  const page = await browser();
  // USDG's slice sits at twelve o'clock, so its label lands just above the top
  // margin. Compressing the side to minimum gaps because of that would drag
  // AAPL and NVDA up beside it, far from the slices they name.
  const weights = { USDG: 459, AAPL: 3000, NVDA: 2180, MSFT: 2180, AMD: 2181 };
  page.source.send({ ...current, config: { targets: weights, driftThresholdBps: 500 },
    portfolio: { ...current.portfolio, positions: current.portfolio.positions.map(p =>
      ({ ...p, weightBps: weights[p.id as keyof typeof weights] })) } });
  const at = (id: string) => Number(page.element('labels').children
    .find(group => group.children[0]!.textContent === id)!.children[0]!.attrs.y);
  assert.ok(at('USDG') < 60, `USDG names the top slice, so it stays at the top (was ${at('USDG')})`);
  assert.ok(at('NVDA') > 300, `NVDA names the lower-right slice, so it stays low (was ${at('NVDA')})`);
  const rightSide = ['USDG', 'AAPL', 'NVDA'].map(at).sort((a, b) => a - b);
  assert.ok(rightSide[2]! - rightSide[0]! > 200, 'the side keeps its natural spread, not a 42px stack');
  page.hide();
});


test('exact valuation breaches stay visible when apportioned weights land on the threshold', async () => {
  const page = await browser();
  const balances: Record<string, bigint> = { USDG: 5000n, AAPL: 26751n, NVDA: 22749n, MSFT: 22750n, AMD: 22750n };
  const portfolio = evaluatePortfolio(Object.entries(allocation).map(([id, targetBps]) =>
    ({ id, symbol: id, decimals: 0, balance: balances[id]!, priceUsdE8: 1n, targetBps })));
  assert.equal(portfolio.positions.find(p => p.id === 'AAPL')!.weightBps, 2675);
  assert.equal(planTrade(portfolio, 'USDG', 300)?.sellAssetId, 'AAPL', 'the exact engine requires a trade');
  page.source.send({ ...current, config: { targets: allocation, driftThresholdBps: 300 },
    portfolio: JSON.parse(JSON.stringify(portfolio, (_key, value) => typeof value === 'bigint' ? value.toString() : value)) });
  assert.equal(page.element('c-state').textContent, 'Off target');
  assert.equal(page.element('labels').children.find(g => g.children[0]!.textContent === 'AAPL')!.attrs.class, 'label-out');
  page.hide();
});

test('missing or inconsistent valuation preserves holdings without an exact on-target claim', async () => {
  const page = await browser();
  for (const valueUsdE8 of [undefined, '-1', 'not-a-value', '1']) {
    page.source.send({ ...current, config: { targets: allocation, driftThresholdBps: 500 },
      portfolio: { ...current.portfolio, positions: current.portfolio.positions.map((p, i) => i ? p : { ...p, valueUsdE8 }) } });
    assert.equal(page.element('c-state').textContent, 'Holdings');
    assert.equal(page.element('c-sub').textContent, 'Exact drift unavailable');
    assert.equal(page.element('arcs').children.length, 5);
    assert.equal(page.element('labels').children.filter(g => g.attrs.class === 'label-out').length, 0);
  }
  page.hide();
});

const ledgerSnapshot = { ...current, mode: 'ledger', config: { targets: allocation, driftThresholdBps: 500 },
  proposal: { sellAssetId: 'AAPL', buyAssetId: 'USDG', amountIn: '1', reason: 'Sell overweight AAPL into USDG' } };
const ledgerRequest = { wallet, chainId: 4663, state: 'requested', createdAt: initialTime,
  queueExpiresAt: initialTime + 120000, expiresAt: initialTime + 600000 };

test('Ledger monitoring and queued or consumed requests never imply an automatic signing retry', async () => {
  const page = await browser();
  page.source.send({ ...ledgerSnapshot, operation: { status: 'waiting-ledger' } });
  assert.equal(page.element('c-state').textContent, 'Ledger needed');
  page.source.send({ ...ledgerSnapshot, ledgerRequest, operation: { status: 'ledger-rejected' } });
  assert.equal(page.element('c-sub').textContent, 'Queued for a fresh check', 'a new request supersedes the prior request outcome');
  page.source.send({ ...ledgerSnapshot, ledgerRequest: { ...ledgerRequest, state: 'consumed' }, graph: { node: 'execute' } });
  assert.equal(page.element('c-state').textContent, 'Ledger request');
  assert.equal(page.element('c-sub').textContent, 'Physical confirmation required');
  assert.ok(!page.element('ghost').classes.has('show'));
  for (const [outcome, label] of [['rejected', 'Request rejected'], ['cancelled', 'Request cancelled'], ['timeout', 'Request timed out'], ['expired', 'Request expired']]) {
    page.source.send({ ...ledgerSnapshot, operation: { status: `ledger-${outcome}` },
      ledgerRequest: { ...ledgerRequest, state: 'finished', outcome } });
    assert.equal(page.element('c-state').textContent, label);
    assert.equal(page.element('c-sub').textContent, 'New request required');
    page.source.send({ ...ledgerSnapshot, operation: { status: 'waiting-ledger' }, ledgerRequest: { ...ledgerRequest, state: 'finished', outcome } });
    assert.equal(page.element('c-state').textContent, label, 'a later monitoring check retains the ended-request explanation');
  }
  page.source.send({ ...ledgerSnapshot, armed: false, operation: { status: 'waiting-ledger' } });
  assert.equal(page.element('c-state').textContent, 'Paused', 'stopping monitoring does not look like a signing request');
  page.source.send({ ...current, mode: 'ledger', config: ledgerSnapshot.config,
    ledgerRequest: { ...ledgerRequest, state: 'finished', outcome: 'rejected' } });
  assert.equal(page.element('c-state').textContent, 'On target', 'an old rejection cannot obscure a later on-target observation');
  page.hide();
});

test('an expired or wrong-wallet Ledger request never appears ready for physical confirmation', async () => {
  const page = await browser();
  page.source.send({ ...ledgerSnapshot, ledgerRequest: { ...ledgerRequest, state: 'consumed', expiresAt: initialTime } });
  assert.equal(page.element('c-state').textContent, 'Request expired');
  page.source.send({ ...ledgerSnapshot, ledgerRequest: { ...ledgerRequest, state: 'consumed', wallet: `0x${'2'.repeat(40)}` } });
  assert.equal(page.element('c-state').textContent, 'Ledger needed');
  page.hide();
});

test('Ledger receipt barriers override signing intent and distinguish approvals from swaps and reverts', async () => {
  const page = await browser();
  const hash = `0x${'b'.repeat(64)}`;
  for (const status of ['pending', 'unresolved', 'confirming']) {
    page.source.send({ ...ledgerSnapshot, ledgerRequest: { ...ledgerRequest, state: 'consumed' },
      operation: { status, kind: 'approval', hash } });
    assert.equal(page.element('c-state').textContent, 'Approval pending');
    assert.equal(page.element('c-sub').textContent, 'Token spending approval');
    assert.ok(!page.element('ghost').classes.has('show'), 'an approval does not predict changed holdings');
  }
  page.source.send({ ...ledgerSnapshot, proposal: undefined, operation: { status: 'reverted', kind: 'swap', hash } });
  assert.equal(page.element('c-state').textContent, 'Transaction reverted');
  assert.equal(page.element('c-sub').textContent, 'Receipt recovery required');
  assert.ok(!page.element('ghost').classes.has('show'));
  page.hide();
});
