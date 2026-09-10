import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const observed = '2026-09-06T02:30:00.000Z';
const initialTime = Date.parse(observed);
const allocation = { USDG: 500, AAPL: 2375, NVDA: 2375, MSFT: 2375, AMD: 2375 };
const wallet = '0x1111111111111111111111111111111111111111';
const current = {
  app: 'Rebalance', nativeBalance: '400000000000000', updatedAt: observed,
  chain: { id: 4663 }, wallet,
  graph: { node: 'plan' }, error: null, operation: null, armed: true,
  config: { targets: allocation },
  portfolio: { totalUsdE8: '500000000', positions: Object.entries(allocation).map(([id, weightBps]) => ({ id, symbol: id, weightBps, balance: '1' })) },
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
  const script = await readFile(new URL('../ui/app.js', import.meta.url), 'utf8');
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
  runInNewContext(script, {
    Date: ClockDate, EventSource: Source, AbortController,
    setTimeout: (fn: () => void, ms: number) => { const id = ++nextTimer; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout: (id: number) => timers.delete(id),
    fetch: async (url: string, request: { signal: AbortSignal }) => {
      calls.push({ url, at: now, signal: request.signal });
      return url === '/api/gas' ? getGas() : getStatus();
    },
    window: { addEventListener: (name: string, handler: () => void) => lifecycle.set(name, handler) },
    document: {
      getElementById: (id: string) => { if (id === 'arcs') pieRenders++; if (!elements.has(id)) elements.set(id, node('text', id)); return elements.get(id); },
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
    portfolio: { ...current.portfolio, positions: current.portfolio.positions.map((p, i) => ({ ...p, weightBps: weights[i] })) } });
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
    page.source.send({ ...current, portfolio: { ...current.portfolio, positions: current.portfolio.positions.map((p, i) => ({ ...p, weightBps: weights[i] })) } });
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

test('an unconfirmed send never renders as a bare receipt hash', async () => {
  const page = await browser();
  const hash = `0x${'a'.repeat(64)}`;
  page.source.send({ ...current, operation: { status: 'pending', hash }, proposal: { sellAssetId: 'AAPL', buyAssetId: 'USDG', amountIn: '1', reason: 'Sell overweight AAPL into USDG' } });
  assert.equal(page.element('c-state').textContent, 'Rebalancing');
  assert.match(page.element('why-receipt').textContent, /unconfirmed$/);
  assert.equal(page.element('c-sub').textContent, 'AAPL → USDG', 'the centre names the pair, not a second copy of the state');
  assert.equal(page.element('c-val').textContent, 'Waiting for receipt', 'mid-trade the send state replaces the portfolio total');
  assert.ok(page.element('ghost').classes.has('show'), 'a pending swap shows where the holding is heading');
  page.source.send({ ...current, operation: { status: 'confirmed', hash, blockNumber: '55516741' } });
  assert.equal(page.element('why-receipt').textContent, `✓ ${hash.slice(0, 8)}… blk 55516741`);
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
  assert.equal(page.element('gas').textContent, 'Gas · 0.0004 ETH · $0.80');
  assert.equal(page.element('gas-price').textContent, 'Gas price · 0.02 gwei');
  assert.match(page.element('gas-price').attrs['aria-label']!, /\$0\.00000004 \/ gas/);
  assert.equal(page.element('gas-estimate').textContent, 'Swap ≈<$0.01 · + approval ≈<$0.01');
  assert.equal(page.element('gas-rebalance').textContent, 'Rebalance ≈$0.01–$0.02 · 2 swaps');
  assert.match(page.element('gas').attrs['aria-label']!, /Coinbase ETH\/USD spot/);
  assert.match(page.element('gas-price').attrs['aria-label']!, /Robinhood RPC eth_gasPrice/);
  assert.match(page.element('gas-price').attrs['aria-label']!, /not a transaction fee/);
  page.hide();
});

test('zero values stay zero and subprecision positive values are never rounded into zero', async () => {
  const page = await browser({ gas: async () => ({ ok: true, json: async () => ({ ...quote, gasPriceWei: '1' }) }) });
  page.source.send({ ...current, nativeBalance: '1' });
  assert.match(page.element('gas').textContent, /0\.000000000000000001 ETH · <\$0\.01/);
  assert.match(page.element('gas-price').textContent, /0\.000000001 gwei/);
  assert.match(page.element('gas-price').attrs['aria-label']!, /<\$0\.000000000001 \/ gas/);
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
  assert.equal(page.element('gas-price').textContent, 'Gas price · unavailable');
  assert.equal(page.element('gas-estimate').textContent, 'Swap estimate · unavailable');
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
  assert.match(page.element('gas-price').attrs['aria-label']!, /\$0\.00000004 \/ gas last known/);
  assert.match(page.element('gas-estimate').textContent, /last known/);
  assert.equal(page.renders, 1);
  page.hide();
});

test('gas and USD observations expire independently even while the status stream stays healthy', async () => {
  const page = await browser({ gas: async () => ({ ok: true, json: async () => ({ ...quote, usdObservedAt: new Date(initialTime - 60000).toISOString() }) }) });
  await page.advance(30000);
  page.source.send({ ...current, updatedAt: new Date(page.now).toISOString() });
  assert.match(page.element('gas').textContent, /\$0\.80 last known/);
  assert.equal(page.element('gas-price').textContent, 'Gas price · 0.02 gwei');
  assert.match(page.element('gas-price').attrs['aria-label']!, /\/ gas last known/);
  await page.advance(60000);
  assert.match(page.element('gas-price').textContent, /0\.02 gwei last known/);
  page.hide();
});

test('partial malformed quote updates retain only the failed source as last known', async () => {
  const page = await browser();
  page.setGas(async () => ({ ok: true, json: async () => ({ ...quote, ethUsdE8: null, gasPriceWei: '30000000', gasObservedAt: new Date(page.now).toISOString() }) }));
  await page.advance(30000);
  assert.match(page.element('gas').textContent, /\$0\.80 last known/);
  assert.equal(page.element('gas-price').textContent, 'Gas price · 0.03 gwei');
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
  assert.equal(page.element('gas-price').textContent, 'Gas price · 0.41786 gwei');
  assert.equal(page.element('gas-estimate').textContent, 'Swap ≈$0.18 · + approval ≈$0.06');
  assert.equal(page.element('gas-rebalance').textContent, 'Rebalance ≈$0.35–$0.47 · 2 swaps');
  assert.match(page.element('gas-estimate').attrs['aria-label']!, /historical single-pool receipts/);
  assert.match(page.element('gas-rebalance').attrs['aria-label']!, /zero to one approval per swap leg/);
  assert.match(page.element('gas-rebalance').attrs['aria-label']!, /exclude market movement, liquidity-provider fees and slippage/);
  page.hide();
});

test('a fresh matching zero-swap projection costs zero even when price sources are unavailable', async () => {
  const page = await browser({ gas: async () => ({ ok: true, json: async () => ({ ...quote, gasPriceWei: null, ethUsdE8: null, rebalance: { ...projection, swaps: 0 } }) }) });
  assert.equal(page.element('gas-estimate').textContent, 'Swap estimate · unavailable');
  assert.equal(page.element('gas-rebalance').textContent, 'Rebalance · $0 (on target)');
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
    assert.equal(page.element('gas-rebalance').textContent, 'Rebalance estimate · unavailable');
  }
  page.source.send({ ...current, config: { targets: { AMD: 2375, MSFT: 2375, NVDA: 2375, AAPL: 2375, USDG: 500 } }, portfolio: { ...current.portfolio, positions: [...current.portfolio.positions].reverse() } });
  assert.equal(page.element('gas-rebalance').textContent, 'Rebalance · $0 (on target)', 'insertion order does not invalidate matching projection content');
  page.hide();
});

test('fresh null projections clear retained estimates instead of preserving an old zero cost', async () => {
  const page = await browser({ gas: async () => ({ ok: true, json: async () => ({ ...quote, rebalance: { ...projection, swaps: 0 } }) }) });
  assert.equal(page.element('gas-rebalance').textContent, 'Rebalance · $0 (on target)');
  page.setGas(async () => ({ ok: true, json: async () => ({ ...quote, rebalance: null }) }));
  await page.advance(30000);
  assert.equal(page.element('gas-rebalance').textContent, 'Rebalance estimate · unavailable');
  page.hide();
});

test('stale projections are labeled last known independently of fresh price sources', async () => {
  const page = await browser({ gas: async () => ({ ok: true, json: async () => ({ ...quote, rebalance: { ...projection, swaps: 0 } }) }) });
  page.setGas(async () => ({ ok: true, json: async () => ({ ...quote, gasObservedAt: new Date(page.now).toISOString(), usdObservedAt: new Date(page.now).toISOString(), rebalance: { ...projection, swaps: 0 } }) }));
  await page.advance(90000);
  page.source.send({ ...current, updatedAt: new Date(page.now).toISOString() });
  assert.equal(page.element('gas-rebalance').textContent, 'Rebalance · $0 (last known projection)');
  assert.doesNotMatch(page.element('gas-price').textContent, /last known/);
  page.hide();
});

test('invalid historical references or malformed projections cannot manufacture transaction estimates', async () => {
  const page = await browser({ gas: async () => ({ ok: true, json: async () => ({ ...quote, reference: { ...reference, chainId: 1 }, rebalance: { ...projection, swaps: -1 } }) }) });
  assert.equal(page.element('gas-estimate').textContent, 'Swap estimate · unavailable');
  assert.equal(page.element('gas-rebalance').textContent, 'Rebalance estimate · unavailable');
  page.setGas(async () => ({ ok: true, json: async () => ({ ...quote, reference: { ...reference, swapGas: '0' }, rebalance: { ...projection, balances: {} } }) }));
  await page.advance(30000);
  assert.equal(page.element('gas-estimate').textContent, 'Swap estimate · unavailable');
  assert.equal(page.element('gas-rebalance').textContent, 'Rebalance estimate · unavailable');
  page.hide();
});

test('new transaction or recovery states invalidate an old on-target projection before quotes refresh', async () => {
  const page = await browser({ gas: async () => ({ ok: true, json: async () => ({ ...quote, rebalance: { ...projection, swaps: 0 } }) }) });
  assert.equal(page.element('gas-rebalance').textContent, 'Rebalance · $0 (on target)');
  for (const status of ['pending', 'unresolved', 'confirming', 'reverted', 'recovery-wait', 'recovery-busy']) {
    page.source.send({ ...current, operation: { status } });
    assert.equal(page.element('gas-rebalance').textContent, 'Rebalance estimate · unavailable', status);
  }
  for (const node of ['execute', 'reconcile', 'recover', 'receipt', 'error']) {
    page.source.send({ ...current, graph: { node } });
    assert.equal(page.element('gas-rebalance').textContent, 'Rebalance estimate · unavailable', node);
  }
  page.source.send({ ...current, error: 'Read unavailable' });
  assert.equal(page.element('gas-rebalance').textContent, 'Rebalance estimate · unavailable');
  page.source.send({ ...current, operation: { status: 'cancelled' } });
  assert.equal(page.element('gas-rebalance').textContent, 'Rebalance · $0 (on target)', 'a settled operation with the same basis remains usable');
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

test('risk caption distinguishes unset manual inputs from unavailable configuration without inventing scores', async () => {
  const page = await browser();
  assert.equal(page.element('risk-model').textContent, 'Target risk · not set');
  assert.doesNotMatch(page.element('risk-model').textContent, /0\/100|Sharpe|Return\/risk/);
  page.source.send({ ...current, config: null });
  assert.equal(page.element('risk-model').textContent, 'Target risk · unavailable');
  page.source.send(current);
  assert.equal(page.element('risk-model').textContent, 'Target risk · not set');
  page.hide();
});

test('subjective target risk has an explicit custom ratio, horizon and accessible units', async () => {
  const page = await browser();
  page.source.send(managedSnapshot());
  const caption = page.element('risk-model');
  assert.equal(caption.textContent, 'Target risk 38.1/100 · Return/risk 32.4 · 5 yr');
  assert.doesNotMatch(caption.textContent, /Sharpe/);
  const details = caption.attrs['aria-label']!;
  assert.match(details, /target/i);
  assert.match(details, /14\.34/);
  assert.match(details, /benchmark.*2%/i);
  assert.match(details, /basis points|bps/i);
  assert.match(details, /risk point/i);
  assert.match(details, /not (?:a |standard )?Sharpe/i);
  assert.equal(page.element('risk-model-title').textContent, details);
  assert.ok(page.element('chart-description').textContent.includes(details));
  for (const score of [0, -4]) {
    page.source.send(managedSnapshot({ ...subjectiveAllocation, score,
      expectedReturnBps: 200 + score * subjectiveAllocation.subjectiveRiskScore }));
    assert.equal(page.element('risk-model').textContent, `Target risk 38.1/100 · Return/risk ${score} · 5 yr`);
  }
  page.hide();
});

test('small positive subjective risk and signed nonzero ratios never render as zero', async () => {
  const page = await browser();
  page.source.send(managedSnapshot({ ...subjectiveAllocation, subjectiveRiskScore: 0.01,
    expectedReturnBps: 200.324 }));
  assert.equal(page.element('risk-model').textContent, 'Target risk <0.1/100 · Return/risk 32.4 · 5 yr');
  assert.match(page.element('risk-model').attrs['aria-label']!, /0\.01/);
  for (const score of [0.001, -0.001]) {
    page.source.send(managedSnapshot({ ...subjectiveAllocation, score,
      expectedReturnBps: 200 + score * subjectiveAllocation.subjectiveRiskScore }));
    assert.equal(page.element('risk-model').textContent,
      `Target risk 38.1/100 · Return/risk ${score.toPrecision(2)} · 5 yr`);
  }
  page.hide();
});

test('Sharpe caption uses its historical observation period and clears earlier subjective values', async () => {
  const page = await browser(); page.source.send(managedSnapshot());
  const historical = { ...subjectiveAllocation, objective: 'sharpe', score: 1.24,
    subjectiveRiskScore: null, expectedReturnBps: 25, returnBasis: 'history-period',
    history: { interval: 'daily', basis: 'underlying-proxy', asOf: observed, quoteCurrency: 'USDG' } };
  page.source.send(managedSnapshot(historical));
  assert.equal(page.element('risk-model').textContent, 'Target Sharpe 1.24 · daily observations');
  assert.doesNotMatch(page.element('risk-model').textContent, /38\.1|Return\/risk|5 yr/);
  const details = page.element('risk-model').attrs['aria-label']!;
  assert.match(details, /histor/i); assert.match(details, /daily/i); assert.match(details, /proxy/i);
  assert.match(details, /USDG/);
  page.source.send(managedSnapshot({ ...historical, score: -1.24,
    history: { ...historical.history, interval: 'monthly' } }));
  assert.equal(page.element('risk-model').textContent, 'Target Sharpe -1.24 · monthly observations');
  page.source.send(current);
  assert.equal(page.element('risk-model').textContent, 'Target risk · not set');
  assert.doesNotMatch(page.element('chart-description').textContent, /1\.24|38\.1\/100|Return\/risk 32\.4/);
  page.hide();
});

test('malformed allocation summaries clear saved numbers instead of displaying stale or fabricated scores', async () => {
  const page = await browser();
  for (const [index, summary] of [
    { ...subjectiveAllocation, objective: 'unknown' },
    { ...subjectiveAllocation, score: null },
    { ...subjectiveAllocation, score: Number.NaN },
    { ...subjectiveAllocation, subjectiveRiskScore: undefined },
    { ...subjectiveAllocation, subjectiveRiskScore: -1 },
    { ...subjectiveAllocation, subjectiveRiskScore: 101 },
    { ...subjectiveAllocation, expectedReturnBps: undefined },
    { ...subjectiveAllocation, benchmarkReturnBps: null },
    { ...subjectiveAllocation, horizonMonths: 0 },
    { ...subjectiveAllocation, computedAt: 'invalid' },
    { ...subjectiveAllocation, policyHash: 'invalid' },
    { ...subjectiveAllocation, stepBps: 0 },
    { ...subjectiveAllocation, returnBasis: 'history-period' },
    { ...subjectiveAllocation, objective: 'sharpe', returnBasis: 'history-period' },
  ].entries()) {
    page.source.send(managedSnapshot());
    page.source.send(managedSnapshot(summary));
    assert.equal(page.element('risk-model').textContent, 'Target risk · unavailable', `invalid summary ${index}`);
    assert.doesNotMatch(page.element('risk-model').attrs['aria-label']!, /38\.1|32\.4|NaN|Infinity/);
  }
  page.source.send(managedSnapshot());
  page.source.send({ ...current, wallet: '0x2222222222222222222222222222222222222222' });
  assert.equal(page.element('risk-model').textContent, 'Target risk · not set', 'a new manual wallet cannot retain the prior wallet score');
  page.hide();
});

test('disconnected risk caption identifies the last saved policy and clears the prefix on reconnection', async () => {
  const page = await browser({ status: async () => { throw new Error('Isolated status read unavailable'); } });
  page.source.send(managedSnapshot());
  page.source.onerror!(); await flush();
  assert.equal(page.element('risk-model').textContent, 'Last saved · Target risk 38.1/100 · Return/risk 32.4 · 5 yr');
  assert.match(page.element('risk-model').attrs['aria-label']!, /last saved/i);
  page.source.send(managedSnapshot());
  assert.equal(page.element('risk-model').textContent, 'Target risk 38.1/100 · Return/risk 32.4 · 5 yr');
  page.hide();
});

test('risk display adds no requests or timers and gas refresh preserves its caption and accessible description', async () => {
  const page = await browser();
  const deadlines = [...page.timers.values()].map(timer => timer.at).sort((a, b) => a - b);
  const requests = page.calls.length;
  page.source.send(managedSnapshot());
  assert.equal(page.calls.length, requests);
  assert.deepEqual([...page.timers.values()].map(timer => timer.at).sort((a, b) => a - b), deadlines);
  const caption = page.element('risk-model').textContent;
  const details = page.element('risk-model').attrs['aria-label']!;
  const renders = page.renders;
  await page.advance(30_000);
  assert.equal(page.calls.length, requests + 1);
  assert.ok(page.calls.every(call => call.url === '/api/gas'));
  assert.equal(page.renders, renders, 'gas quotes do not redraw the portfolio or risk model');
  assert.equal(page.element('risk-model').textContent, caption);
  assert.equal(page.element('risk-model').attrs['aria-label'], details);
  assert.ok(page.element('chart-description').textContent.includes(details));
  await page.advance(60_000);
  assert.equal(page.element('risk-model').textContent, caption, 'saved user assumptions do not expire with ninety-second gas quotes');
  assert.ok(page.element('chart-description').textContent.includes(details));
  page.hide();
});

test('a target the wallet does not hold still counts as drift', async () => {
  const page = await browser();
  // USDG has a 6% target and no balance; every held stock is only +1.5pp, so a
  // drift read over holdings alone would claim "On target" while the engine
  // sees USDG 600bps short and opens a cycle.
  const targets = { USDG: 600, AAPL: 2350, NVDA: 2350, MSFT: 2350, AMD: 2350 };
  const positions = current.portfolio.positions.map(p =>
    ({ ...p, weightBps: p.id === 'USDG' ? 0 : 2500, balance: p.id === 'USDG' ? '0' : '1' }));
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
      ({ ...p, weightBps: p.id === 'AAPL' ? 2375 + drift : p.id === 'USDG' ? 500 : 2375 - drift / 3 })) } });
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

test('an unarmed runner is the headline, without hiding the drift reading', async () => {
  const page = await browser();
  page.source.send({ ...current, armed: false, config: { targets: allocation, driftThresholdBps: 500 } });
  assert.equal(page.element('c-state').textContent, 'Not armed');
  assert.equal(page.element('c-sub').textContent, '0% off target', 'a stopped runner still reports where the portfolio stands');
  page.hide();
});
