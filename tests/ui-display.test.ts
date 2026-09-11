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
type DisplayNode = { tag: string; textContent: string; attrs: Record<string, string>; children: DisplayNode[];
  classes: Set<string>; style: Record<string, string>; parentNode: DisplayNode | null; listeners: Map<string, () => void>;
  classList: { add: (name: string) => void; remove: (name: string) => void; toggle: (name: string, on?: boolean) => void; contains: (name: string) => boolean };
  cloneNode: (deep?: boolean) => DisplayNode; replaceChildren: () => void; append: (child: DisplayNode) => void; remove: () => void;
  getAttribute: (key: string) => string | null; removeAttribute: (key: string) => void;
  addEventListener: (name: string, handler: () => void) => void; setAttribute: (key: string, value: string) => void };
type Response = { ok: boolean; json: () => Promise<unknown> };
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

async function browser(options: { hidden?: boolean; status?: () => Promise<Response>; stockLinks?: boolean } = {}) {
  const [ringScript, script, html] = await Promise.all(['allocation-ring.js', 'app.js', 'index.html']
    .map(file => readFile(new URL(`../ui/${file}`, import.meta.url), 'utf8')));
  const htmlIds = new Set([...html!.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
  const elements = new Map<string, DisplayNode>();
  const lifecycle = new Map<string, () => void>(), visibility = new Map<string, () => void>();
  const pageDocument = { visibilityState: options.hidden ? "hidden" : "visible" };
  const timers = new Map<number, { fn: () => void; at: number }>();
  const calls: { url: string; at: number; signal: AbortSignal }[] = [];
  let now = initialTime, nextTimer = 0, pieRenders = 0;
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
      getAttribute: (key: string) => item.attrs[key] ?? null,
      removeAttribute: (key: string) => { delete item.attrs[key]; },
      cloneNode: (deep = false) => {
        const clone = node(tag); clone.attrs = { ...item.attrs }; clone.textContent = item.textContent;
        for (const cls of item.classes) clone.classes.add(cls);
        if (deep) for (const child of item.children) clone.append(child.cloneNode(true));
        return clone;
      },
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
      assert.equal(url, '/api/status', 'the chart has no independent gas quote requests');
      return getStatus();
    },
    window: { addEventListener: (name: string, handler: () => void) => lifecycle.set(name, handler) },
    document: {
      get visibilityState() { return pageDocument.visibilityState; },
      addEventListener: (name: string, handler: () => void) => visibility.set(name, handler),
      getElementById: (id: string) => { if (!htmlIds.has(id)) return null; if (id === 'arcs') pieRenders++; if (!elements.has(id)) elements.set(id, node('text', id)); return elements.get(id); },
      createElementNS: (_namespace: string, tag: string) => node(tag),
    },
  });
  runInContext(ringScript, context);
  if (options.stockLinks) runInContext(await readFile(new URL('../ui/stock-links.js', import.meta.url), 'utf8'), context);
  runInContext(script, context);
  const source = Source.instances[0]!;
  source?.send(current);
  await flush();
  return {
    element: (id: string) => elements.get(id)!,
    get renders() { return pieRenders; }, get now() { return now; },
    calls, timers, source, sources: Source.instances,
    visible(value: boolean) { pageDocument.visibilityState = value ? "visible" : "hidden"; visibility.get("visibilitychange")!(); },
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

type Point = [number, number];
function sector(node: DisplayNode) {
  assert.equal(node.tag, 'path');
  assert.ok(node.attrs.fill && node.attrs.fill !== 'none');
  for (const attr of ['stroke', 'stroke-width', 'stroke-dasharray', 'stroke-dashoffset', 'pathLength', 'mask', 'clip-path']) assert.equal(node.attrs[attr], undefined);
  const parts = node.attrs.d!.match(/[MLAZ]|[-+]?(?:\d*\.?\d+)(?:e[-+]?\d+)?/gi)!;
  assert.equal(parts.length, 23);
  assert.deepEqual([parts[0], parts[3], parts[11], parts[14], parts[22]], ['M', 'A', 'L', 'A', 'Z']);
  const point = (i: number): Point => [Number(parts[i]) - 210, Number(parts[i + 1]) - 210];
  return { outerStart: point(1), outerEnd: point(9), innerEnd: point(12), innerStart: point(20),
    outer: Number(parts[4]), inner: Number(parts[15]), outerLarge: Number(parts[7]), innerLarge: Number(parts[18]) };
}
const dot = (point: Point, angle: number) => -point[0] * Math.sin(angle) + point[1] * Math.cos(angle);
const angleOf = (point: Point, start: number) => {
  let angle = Math.atan2(point[1], point[0]);
  while (angle < start - 1e-12) angle += Math.PI * 2;
  return angle;
};

test('actual and target rings share stable colors and exact boundary directions despite config order', async () => {
  const page = await browser();
  page.source.send({ ...current, config: { targets: { AMD: 2375, MSFT: 2375, NVDA: 2375, AAPL: 2375, USDG: 500 } } });
  const actual = page.element('arcs').children, targets = page.element('targets').children;
  assert.equal(actual.length, 5); assert.equal(targets.length, 5);
  assert.deepEqual(actual.map(node => node.attrs.fill), targets.map(node => node.attrs.fill));
  let boundary = 0;
  for (let index = 0; index < actual.length; index++) {
    for (const node of [actual[index]!, targets[index]!]) {
      const shape = sector(node);
      assert.ok(Math.abs(dot(shape.outerStart, boundary) - 2) < 1e-9);
      assert.ok(Math.abs(dot(shape.innerStart, boundary) - 2) < 1e-9, 'cut follows the exact allocation boundary at both radii');
    }
    boundary += Object.values(allocation)[index]! / 10000 * Math.PI * 2;
  }
  assert.ok(targets.every(node => sector(node).outer < 128));
  assert.match(page.element('chart-description').textContent, /Inner ring, targets: USDG 5%/);
  page.hide();
});

test('neighboring gap edges are parallel with a shared width and never consume more than half a tiny slice', async () => {
  const page = await browser();
  for (const weights of [[500, 2375, 2375, 2375, 2375], [1, 2499, 2500, 2500, 2500], [9996, 1, 1, 1, 1], [5000, 4997, 1, 1, 1]]) {
    const targets = Object.fromEntries(Object.keys(allocation).map((id, index) => [id, weights[index]]));
    page.source.send({ ...current, config: { targets }, portfolio: { ...current.portfolio,
      positions: current.portfolio.positions.map((p, index) => ({ ...p, weightBps: weights[index] })) } });
    for (const container of ['arcs', 'targets']) {
      const shapes = page.element(container).children.map(sector);
      let start = 0;
      for (let index = 0; index < shapes.length; index++) {
        const shape = shapes[index]!, previous = shapes[(index + shapes.length - 1) % shapes.length]!;
        const sweep = weights[index]! / 10000 * Math.PI * 2, end = start + sweep;
        for (const point of [shape.outerStart, shape.outerEnd]) assert.ok(Math.abs(Math.hypot(...point) - shape.outer) < 1e-9);
        for (const point of [shape.innerStart, shape.innerEnd]) assert.ok(Math.abs(Math.hypot(...point) - shape.inner) < 1e-9);
        const startCut = dot(shape.outerStart, start), endCut = dot(shape.outerEnd, end);
        assert.ok(startCut > 0 && startCut <= 2 + 1e-9);
        assert.ok(endCut < 0 && endCut >= -2 - 1e-9);
        assert.ok(Math.abs(startCut - dot(shape.innerStart, start)) < 1e-9, 'start chord is parallel across both radii');
        assert.ok(Math.abs(endCut - dot(shape.innerEnd, end)) < 1e-9, 'end chord is parallel across both radii');
        assert.ok(Math.abs(startCut + dot(previous.outerEnd, start)) < 1e-9, 'adjacent cuts share one centered gap');
        assert.ok(Math.abs(startCut + dot(previous.innerEnd, start)) < 1e-9, 'inner and outer gap widths agree');
        const innerStart = angleOf(shape.innerStart, start), innerEnd = angleOf(shape.innerEnd, start);
        assert.ok(innerStart >= start - 1e-12 && innerEnd <= end + 1e-12);
        assert.ok(innerEnd - innerStart >= sweep / 2 - 1e-12, 'at least half the exact slice remains at the narrowest radius');
        assert.equal(shape.innerLarge, innerEnd - innerStart > Math.PI ? 1 : 0);
        start = end;
      }
    }
  }
  page.hide();
});

test('one full allocation uses a seamless annulus and preserves its geometry node as weights change', async () => {
  const page = await browser();
  const apple = page.element('arcs').children[1]!;
  page.source.send({ ...current, portfolio: { ...current.portfolio,
    positions: current.portfolio.positions.map(p => ({ ...p, weightBps: p.id === 'AAPL' ? 10000 : 0 })) } });
  assert.equal(page.element('arcs').children.length, 1);
  assert.equal(page.element('arcs').children[0], apple);
  assert.equal(apple.tag, 'path');
  assert.equal((apple.attrs.d!.match(/ A /g) || []).length, 4, 'two complete circles close a seam-free annulus');
  assert.equal(apple.attrs['stroke-dasharray'], undefined);
  assert.equal(apple.attrs.mask, undefined, 'the whole annulus moves with its native link');
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
      const top = y - 12, bottom = y + 21;
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
  assert.equal(page.element('c-state').textContent, 'Target allocation');
  assert.equal(page.element('c-sub').textContent, 'Wallet empty');
  assert.equal(page.element('c-val').textContent, '');
  assert.equal(page.element('arcs').children.length, 5);
  assert.equal(page.element('targets').children.length, 0);
  assert.match(page.element('chart-description').textContent, /^Target allocation\. Wallet empty\. Ring weights: USDG 5%/);
  page.source.send({ ...current, portfolio: null });
  assert.equal(page.element('c-sub').textContent, 'Holdings not checked');
  assert.equal(page.element('c-state').textContent, 'Target allocation');
  assert.equal(page.element('targets').children.length, 0);
  page.source.send({ ...current, portfolio: { ...current.portfolio, totalUsdE8: '0' } });
  assert.equal(page.element('c-sub').textContent, 'Holdings below precision');
  assert.equal(page.element('c-state').textContent, 'Target allocation');
  page.source.send({ ...current, portfolio: null, error: 'Read unavailable' });
  assert.equal(page.element('c-state').textContent, 'Unavailable');
  assert.equal(page.element('c-sub').textContent, 'Read unavailable');
  assert.equal(page.element('c-val').textContent, 'Target allocation');
  page.source.send({ ...current, portfolio: null, operation: { status: 'pending', kind: 'swap' } });
  assert.equal(page.element('c-state').textContent, 'Rebalancing');
  assert.equal(page.element('c-val').textContent, 'Waiting for receipt · Target allocation');
  page.hide();
});

test('read failures preserve actual/target comparison as last known holdings', async () => {
  const page = await browser();
  page.source.send({ ...current, error: 'Read unavailable' });
  assert.equal(page.element('c-state').textContent, 'Last known');
  assert.equal(page.element('c-sub').textContent, 'Read unavailable');
  assert.equal(page.element('targets').children.length, 5);
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


test('a collapsed Settings overlay keeps settings outside the centre with no gas fetches', async () => {
  const page = await browser();
  const markup = await readFile(new URL('../ui/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(markup, />Details<|id="panel"|id="sum"|id="c-legend"|>Fees<|id="gas(?:-|"|\s)/);
  const centre = markup.match(/<foreignObject[^>]*>([\s\S]*?)<\/foreignObject>/)?.[1];
  assert.ok(centre);
  for (const id of ["c-state", "c-sub", "c-val"]) assert.ok(centre.includes(`id="${id}"`));
  const settings = markup.match(/<section class="settings"[^>]*>([\s\S]*?)<\/section>/)?.[1];
  assert.ok(settings); assert.match(settings, /id="settings-toggle"[^>]*aria-expanded="false"/);
  for (const id of ["set-band", "set-every", "set-fee-target"]) {
    assert.ok(!centre.includes(`id="${id}"`)); assert.ok(settings.includes(`id="${id}"`));
  }
  assert.match(markup, /Fee target/);
  assert.equal(page.element('set-fee-target').textContent, 'Not set');
  await page.advance(180000);
  assert.deepEqual(page.calls, [], 'healthy SSE is sufficient for the chart');
  assert.doesNotMatch(page.element('chart-description').textContent, /gwei|Coinbase|Gas price/);
  page.hide();
});

test('all settings follow the displayed wallet and current config even while stopped', async () => {
  const page = await browser();
  const cases = [
    { wallet, rebalanceFeeTargetUsdE8: '125000000', expected: '$1.25', driftThresholdBps: 500, rebalanceIntervalSeconds: 3600, band: '±5%', interval: '1 hour' },
    { wallet: `0x${'2'.repeat(40)}`, rebalanceFeeTargetUsdE8: '1', expected: '$0.00000001', driftThresholdBps: 250, rebalanceIntervalSeconds: 1800, band: '±2.5%', interval: '30 min' },
    { wallet, rebalanceFeeTargetUsdE8: undefined, expected: 'Not set', driftThresholdBps: 500, rebalanceIntervalSeconds: 7200, band: '±5%', interval: '2 hours' },
  ];
  for (const item of cases) {
    const { rebalanceFeeTargetUsdE8, driftThresholdBps, rebalanceIntervalSeconds } = item;
    page.source.send({ ...current, wallet: item.wallet, armed: false, config: { targets: allocation, driftThresholdBps, rebalanceIntervalSeconds, rebalanceFeeTargetUsdE8 } });
    assert.equal(page.element('set-fee-target').textContent, item.expected);
    assert.equal(page.element('set-band').textContent, item.band);
    assert.equal(page.element('set-every').textContent, item.interval);
    assert.ok(page.element('chart-description').textContent.includes(`Rebalance trigger: ${item.band}. Cycle interval: ${item.interval}. Target rebalance fee: ${item.expected}.`));
    assert.equal(page.element('c-state').textContent, 'Paused');
    assert.doesNotMatch(page.element('c-val').textContent, /gwei/);
  }
  page.hide();
});

const feeSnapshot = { ...current, config: { targets: allocation, driftThresholdBps: 500, rebalanceFeeTargetUsdE8: '10000000' },
  graph: { node: 'wait', trace: ['config', 'observe', 'plan', 'quote', 'wait'] }, operation: { status: 'fee-target' },
  feeCheck: { targetUsdE8: '10000000', estimatedUsdE8: '25000000', gasPriceWei: '417860000', ethUsdE8: '250205000000', observedAt: observed, state: 'above-target' } };

test('a fee-blocked rebalance shows only its estimated cost, target and observed gas rate in the centre', async () => {
  const page = await browser();
  page.source.send(feeSnapshot);
  assert.equal(page.element('c-state').textContent, 'Gas above target');
  assert.equal(page.element('c-sub').textContent, '≈$0.25 · target $0.10');
  assert.equal(page.element('c-val').textContent, '0.42 gwei');
  page.source.send({ ...feeSnapshot, feeCheck: { ...feeSnapshot.feeCheck, gasPriceWei: '1' } });
  assert.equal(page.element('c-val').textContent, '<0.01 gwei');
  page.source.send({ ...feeSnapshot, operation: null, feeCheck: { ...feeSnapshot.feeCheck, state: 'within-target' } });
  assert.equal(page.element('c-state').textContent, 'On target');
  assert.doesNotMatch(page.element('c-val').textContent, /gwei/);
  page.hide();
});

test('an unavailable, stale or mismatched fee estimate cannot retain earlier blocked prices', async () => {
  const page = await browser();
  page.source.send(feeSnapshot);
  for (const feeCheck of [
    { ...feeSnapshot.feeCheck, state: 'unavailable' },
    { ...feeSnapshot.feeCheck, gasPriceWei: null },
    { ...feeSnapshot.feeCheck, estimatedUsdE8: undefined },
    { ...feeSnapshot.feeCheck, observedAt: new Date(initialTime - 90000).toISOString() },
    { ...feeSnapshot.feeCheck, observedAt: new Date(initialTime + 1).toISOString() },
    { ...feeSnapshot.feeCheck, targetUsdE8: '5000000' },
  ]) {
    page.source.send({ ...feeSnapshot, feeCheck });
    assert.equal(page.element('c-state').textContent, 'Fee estimate unavailable');
    assert.equal(page.element('c-sub').textContent, 'Waiting for a fresh estimate');
    assert.equal(page.element('c-val').textContent, '');
  }
  page.source.send({ ...feeSnapshot, armed: false, config: { ...feeSnapshot.config, rebalanceFeeTargetUsdE8: '30000000' } });
  assert.equal(page.element('set-fee-target').textContent, '$0.30');
  assert.equal(page.element('c-state').textContent, 'Paused');
  assert.doesNotMatch(page.element('c-val').textContent, /gwei/);
  page.hide();
});

test('armed quote and execution stages show progress while receipts and Ledger requests retain priority', async () => {
  const page = await browser();
  for (const [node, message] of [['quote', 'Preparing a fresh quote'], ['execute', 'Preparing the transaction']]) {
    page.source.send({ ...current, graph: { node } });
    assert.equal(page.element('c-state').textContent, 'Rebalancing');
    assert.equal(page.element('c-sub').textContent, message);
  }
  page.source.send({ ...current, graph: { node: 'execute' }, operation: { status: 'pending', kind: 'approval' } });
  assert.equal(page.element('c-state').textContent, 'Approval pending');
  page.source.send({ ...ledgerSnapshot, graph: { node: 'execute' }, ledgerRequest: { ...ledgerRequest, state: 'consumed' } });
  assert.equal(page.element('c-state').textContent, 'Ledger request');
  page.source.send({ ...current, armed: false, graph: { node: 'execute' }, config: { targets: allocation, driftThresholdBps: 500 } });
  assert.equal(page.element('c-state').textContent, 'Paused');
  page.hide();
});

test('rebalance failures retain bounded public error text and differ from observation failures', async () => {
  const page = await browser();
  const error = 'Sender simulation failed. ' + 'More detail. '.repeat(40);
  for (const phase of ['quote', 'execute']) {
    page.source.send({ ...current, error, graph: { node: 'error', trace: ['config', 'observe', phase, 'error'] } });
    assert.equal(page.element('c-state').textContent, 'Rebalance failed');
    assert.equal(page.element('c-sub').textContent, error.slice(0, 400).trim());
    assert.equal(page.element('c-val').textContent, '', 'the total does not overlap the wrapped error');
    assert.ok(page.element('chart-description').textContent.includes(error.slice(0, 400).trim()));
  }
  page.source.send({ ...current, error: 'Could not read current balances.', graph: { node: 'error', trace: ['config', 'observe', 'error'] } });
  assert.equal(page.element('c-state').textContent, 'Last known');
  assert.equal(page.element('c-sub').textContent, 'Could not read current balances.');
  page.source.send({ ...current, error: { providerPayload: 'must not be displayed' }, graph: { node: 'error', trace: ['execute', 'error'] } });
  assert.equal(page.element('c-sub').textContent, 'Update unavailable');
  assert.doesNotMatch(page.element('chart-description').textContent, /must not be displayed/);
  page.hide();
});


test('a blocked gas label expires without additional network requests or status events', async () => {
  const page = await browser();
  page.source.send(feeSnapshot);
  await page.advance(89999);
  assert.equal(page.element('c-state').textContent, 'Gas above target');
  await page.advance(1);
  assert.equal(page.element('c-state').textContent, 'Fee estimate unavailable');
  assert.equal(page.element('c-val').textContent, '');
  assert.deepEqual(page.calls, []);
  page.hide();
});

test('cooldown outranks Ledger drift and fee history without hiding pending receipts', async () => {
  const page = await browser();
  const cooling = { ...ledgerSnapshot, feeCheck: feeSnapshot.feeCheck, operation: { status: 'cooling-down' },
    cycle: { nextEligibleAt: new Date(initialTime + 3600000).toISOString() } };
  page.source.send(cooling);
  assert.equal(page.element('c-state').textContent, 'Cooling down');
  assert.match(page.element('c-sub').textContent, /Next cycle after/);
  assert.doesNotMatch(page.element('c-val').textContent, /gwei/);
  page.source.send({ ...cooling, operation: { status: 'pending', kind: 'swap' } });
  assert.equal(page.element('c-state').textContent, 'Rebalancing');
  assert.equal(page.element('c-val').textContent, 'Waiting for receipt');
  page.source.send({ ...cooling, armed: false });
  assert.equal(page.element('c-state').textContent, 'Paused');
  page.hide();
});


test('chart stock links wrap actual, target and ticker geometry and remove obsolete assets', async () => {
  const page = await browser({ stockLinks: true });
  const markup = await readFile(new URL('../ui/index.html', import.meta.url), 'utf8');
  assert.ok(markup.indexOf('/stock-links.js') < markup.indexOf('/app.js'));
  assert.match(markup, /id="ring"[^>]*role="group"/);
  assert.match(markup, /<meta name="referrer" content="no-referrer">/);
  const oldLinks = [];
  for (const [container, kind, geometry] of [['arcs', 'actual', 'path'], ['targets', 'target', 'path'], ['labels', 'label', 'g']]) {
    const links = page.element(container!).children;
    assert.equal(links.length, 5);
    assert.ok(links.every(link => link.tag === 'a' && link.attrs.class === `stock-link stock-link--${kind}`));
    assert.ok(links.every(link => link.children.length === 2 && link.children[0]!.attrs.class === 'stock-link__visual' && link.children[0]!.children[0]!.tag === geometry));
    assert.ok(links.every(link => link.children[1]!.attrs.class === 'stock-link__hit'));
    const apple = links.find(link => link.attrs.href === 'https://www.google.com/search?q=AAPL%20stock%20chart')!;
    assert.equal(apple.attrs.target, '_blank'); assert.equal(apple.attrs.rel, 'noopener noreferrer');
    oldLinks.push(apple);
  }
  const originalUsdLink = page.element('arcs').children[0]!;
  const originalUsdPath = originalUsdLink.children[0]!.children[0]!;
  const onlyCash = { USDG: 10000, AAPL: 0, NVDA: 0, MSFT: 0, AMD: 0 };
  page.source.send({ ...current, config: { targets: onlyCash, driftThresholdBps: 500 },
    portfolio: { ...current.portfolio, positions: Object.keys(onlyCash).map(id => ({ id, symbol: id,
      weightBps: id === 'USDG' ? 10000 : 0, balance: id === 'USDG' ? '1' : '0', valueUsdE8: id === 'USDG' ? current.portfolio.totalUsdE8 : '0' })) } });
  for (const container of ['arcs', 'targets', 'labels']) {
    assert.equal(page.element(container).children.length, 1);
    assert.equal(page.element(container).children[0]!.attrs.href, 'https://www.google.com/search?q=USDG%20stablecoin%20chart');
  }
  assert.equal(page.element('arcs').children[0], originalUsdLink, 'updates reuse the native link');
  assert.equal(originalUsdLink.children[0]!.children[0], originalUsdPath, 'updates preserve the allocation geometry node');
  assert.ok(oldLinks.every(link => link.parentNode === null), 'removed arc wrappers cannot remain clickable');
  assert.deepEqual(page.calls, [], 'rendering links never follows them or triggers a control request');
  page.hide();
});


test('one asset shares outward movement and highlight across actual, target and stable label links', async () => {
  const page = await browser({ stockLinks: true });
  const links = ['arcs', 'targets', 'labels'].map(id => page.element(id).children.find(link => link.attrs['data-stock-asset'] === 'AAPL')!);
  const label = links[2]!, geometry = links[0]!.children[0]!.children[0]!;
  const originalPath = geometry.attrs.d;
  label.listeners.get('focusin')!();
  assert.ok(links.every(link => link.attrs.class!.includes('is-highlighted')));
  const components = (link: DisplayNode) => [...link.attrs.style!.matchAll(/:([-\d.e]+)px/g)].map(match => Number(match[1]));
  const [x, y] = components(label), [arcX, arcY] = components(links[0]!);
  assert.ok(Math.abs(Math.hypot(x!, y!) - 14) < 1e-9);
  assert.ok(Math.abs(arcX! + y!) < 1e-9 && Math.abs(arcY! - x!) < 1e-9, 'parent rotation yields one shared screen direction');
  assert.equal(links[0]!.attrs.style, links[1]!.attrs.style, 'actual and target travel together even with different radii');
  const oldHit = links[0]!.children[1]!;
  page.source.send({ ...current, config: { ...current.config, driftThresholdBps: 500 } });
  assert.equal(page.element('labels').children[1], label, 'status updates preserve keyboard focus on the same label');
  assert.ok(links.every(link => link.attrs.class!.includes('is-highlighted')));
  assert.equal(geometry.attrs.d, originalPath, 'hover does not reshape allocation or its parallel cuts');
  assert.notEqual(links[0]!.children[1], oldHit);
  assert.equal(links[0]!.children[1]!.attrs.d, originalPath, 'stationary hit area tracks the latest complete segment');
  label.listeners.get('focusout')!();
  assert.ok(links.every(link => !link.attrs.class!.includes('is-highlighted')));
  assert.deepEqual(page.calls, []);
  page.hide();
});


test('Settings opens and closes accessibly without redrawing or changing the chart layout', async () => {
  const page = await browser();
  const css = await readFile(new URL('../ui/style.css', import.meta.url), 'utf8');
  const button = page.element('settings-toggle'), panel = page.element('settings-panel');
  const ring = page.element('arcs').children, draws = page.renders;
  for (const open of [true, false, true, false]) {
    button.listeners.get('click')!();
    assert.equal(button.attrs['aria-expanded'], String(open));
    assert.equal(panel.attrs['aria-hidden'], String(!open));
    assert.equal(panel.classes.has('open'), open);
    assert.equal(Object.hasOwn(panel.attrs, 'inert'), !open);
    assert.equal(page.renders, draws); assert.equal(page.element('arcs').children, ring);
  }
  assert.match(css, /\.settings \{[^}]*position: absolute[^}]*bottom: 0/);
  assert.match(css, /\.settings-panel \{[^}]*transition: grid-template-rows/);
  assert.doesNotMatch(css.match(/\.settings-panel \{[^}]*\}/)?.[0] ?? "", /position: absolute|bottom:|top:/);
  assert.doesNotMatch(css.match(/\.settings \{[^}]*\}/)?.[0] ?? "", /height:|flex:/);
  const markup = await readFile(new URL('../ui/index.html', import.meta.url), 'utf8');
  assert.ok(markup.indexOf('class="settings"') > markup.indexOf('class="main"'), 'Settings follows the chart');
  assert.ok(markup.indexOf('id="settings-toggle"') < markup.indexOf('id="settings-panel"'), 'Header stays above its content');
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]*?\.settings-panel[^}]*transition: none/);
  assert.deepEqual(page.calls, []);
  page.hide();
});

test('a quiet configuration refresh never calls the previous allocation on target', async () => {
  const page = await browser();
  page.source.send({ ...current, config: { targets: allocation, driftThresholdBps: 500 },
    operation: { status: 'configuration-changed' }, graph: { node: 'wait' } });
  assert.equal(page.element('c-state').textContent, 'Updating settings…');
  assert.equal(page.element('c-sub').textContent, 'Checking the current allocation');
  assert.equal(page.element('c-val').textContent, '');
  page.source.send({ ...current, config: { targets: allocation, driftThresholdBps: 500 } });
  assert.equal(page.element('c-state').textContent, 'On target');
  page.hide();
});


test('ordinary label centres stay on their own actual segment midpoint rather than shifting toward the next asset', async () => {
  const page = await browser();
  for (const weights of [[500, 2375, 2375, 2375, 2375], [459, 3000, 2180, 2180, 2181]]) {
    page.source.send({ ...current, config: { targets: allocation, driftThresholdBps: 500 },
      portfolio: { ...current.portfolio, positions: current.portfolio.positions.map((p, index) =>
        ({ ...p, weightBps: weights[index], valueUsdE8: String(weights[index]! * 50000) })) } });
    let offset = 0;
    for (const [index, group] of page.element('labels').children.entries()) {
      const angle = (offset + weights[index]! / 2) / 10000 * Math.PI * 2 - Math.PI / 2;
      const x = Number(group.children[0]!.attrs.x) - 210;
      const y = Number(group.children[0]!.attrs.y) + 4.5 - 210;
      assert.ok(Math.abs(-x * Math.sin(angle) + y * Math.cos(angle)) < 1e-6, `${group.attrs['data-asset']} remains on its actual midpoint ray`);
      assert.equal(group.children[2]!.attrs.visibility, 'hidden', 'uncrowded labels need no connector');
      offset += weights[index]!;
    }
  }
  page.hide();
});

test('crowded labels never overlap and their connector begins at the exact visible segment midpoint', async () => {
  const page = await browser();
  for (const weights of [[1, 9996, 1, 1, 1], [1, 1, 1, 1, 9996], [100, 9400, 200, 100, 200], [9996, 1, 1, 1, 1]]) {
    page.source.send({ ...current, portfolio: { ...current.portfolio, positions: current.portfolio.positions.map((p, index) =>
      ({ ...p, weightBps: weights[index], valueUsdE8: String(weights[index]! * 50000) })) } });
    const labels = page.element('labels').children;
    let offset = 0;
    for (const [index, label] of labels.entries()) {
      const angle = (offset + weights[index]! / 2) / 10000 * Math.PI * 2 - Math.PI / 2;
      const leader = label.children[2]!;
      const start = /^M ([^ ]+) ([^ ]+)/.exec(leader.attrs.d)!;
      assert.ok(Math.abs(Number(start[1]) - 210 - 174 * Math.cos(angle)) < 1e-9);
      assert.ok(Math.abs(Number(start[2]) - 210 - 174 * Math.sin(angle)) < 1e-9);
      assert.equal(leader.attrs.stroke, page.element('arcs').children[index]!.attrs.fill);
      assert.doesNotMatch(leader.attrs.d!, /NaN|Infinity/);
      offset += weights[index]!;
      const x = Number(label.children[0]!.attrs.x), y = Number(label.children[0]!.attrs.y);
      for (const other of labels.slice(index + 1)) {
        const dx = Math.abs(x - Number(other.children[0]!.attrs.x));
        const dy = Math.abs(y - Number(other.children[0]!.attrs.y));
        assert.ok(dx >= 80 - 1e-9 || dy >= 42 - 1e-9, 'text boxes keep distinct rows or columns');
      }
    }
  }
  page.hide();
});

test('empty-wallet label anchors follow displayed targets and linked highlights keep the connector attached', async () => {
  const page = await browser({ stockLinks: true });
  const changedTargets = { USDG: 3000, AAPL: 1000, NVDA: 2000, MSFT: 2000, AMD: 2000 };
  page.source.send({ ...current, config: { targets: changedTargets }, portfolio: null });
  const labels = page.element('labels').children;
  let offset = 0;
  for (const [index, link] of labels.entries()) {
    const group = link.children[0]!.children[0]!;
    const weight = Object.values(changedTargets)[index]!;
    const angle = (offset + weight / 2) / 10000 * Math.PI * 2 - Math.PI / 2;
    const start = /^M ([^ ]+) ([^ ]+)/.exec(group.children[2]!.attrs.d)!;
    assert.ok(Math.abs(Number(start[1]) - 210 - 174 * Math.cos(angle)) < 1e-9);
    assert.ok(Math.abs(Number(start[2]) - 210 - 174 * Math.sin(angle)) < 1e-9);
    const before = group.children[2]!.attrs.d;
    link.listeners.get('focusin')!();
    assert.ok(link.attrs.class!.includes('is-highlighted'));
    assert.equal(group.children[2]!.attrs.d, before, 'the label and connector share the visual wrapper');
    link.listeners.get('focusout')!();
    offset += weight;
  }
  assert.deepEqual(page.calls, []);
  page.hide();
});


test('hidden chart tabs release status sockets and timers until visible again', async () => {
  const page = await browser();
  page.visible(false);
  assert.equal(page.source.closed, true);
  assert.equal(page.timers.size, 0);
  const renders = page.renders;
  page.source.send({ ...current, error: 'old stream' });
  await page.advance(10000);
  assert.equal(page.renders, renders);
  assert.equal(page.calls.length, 0);
  page.visible(true); page.show(); page.visible(true);
  assert.equal(page.sources.length, 2);
  page.sources[1]!.send(current);
  assert.equal(page.timers.size, 0);
  assert.equal(page.sources[1]!.closed, false);
  page.hide(); page.visible(true);
  assert.equal(page.sources.length, 2, 'pagehide remains suspended until pageshow');
});

test('a chart initially opened in the background does not claim a status socket or poll', async () => {
  const page = await browser({ hidden: true });
  assert.equal(page.sources.length, 0);
  await page.advance(10000); assert.equal(page.calls.length, 0);
  page.show(); assert.equal(page.sources.length, 0);
  page.visible(true); assert.equal(page.sources.length, 1);
  page.sources[0]!.send(current); assert.equal(page.timers.size, 0);
  page.hide();
});

test('late fallback status after hidden-tab suspension cannot replace a fresh resumed chart', async () => {
  let finish!: (value: Response) => void;
  const page = await browser({ status: () => new Promise(resolve => { finish = resolve; }) });
  page.source.onerror!();
  assert.equal(page.calls.length, 1);
  page.visible(false); assert.equal(page.calls[0]!.signal.aborted, true);
  page.visible(true);
  page.sources[1]!.send({ ...current, portfolio: { ...current.portfolio, totalUsdE8: '700000000' } });
  const renders = page.renders;
  finish({ ok: true, json: async () => ({ ...current, error: 'obsolete fallback' }) });
  await flush();
  assert.equal(page.renders, renders);
  assert.match(page.element('c-val').textContent, /^\$7 · as of /);
  assert.equal(page.timers.size, 0);
  page.hide();
});


test('returning to a hidden chart rechecks the age of an otherwise unchanged fee estimate', async () => {
  const page = await browser();
  page.source.send(feeSnapshot);
  page.visible(false);
  await page.advance(90000);
  assert.equal(page.calls.length, 0);
  page.visible(true); page.sources[1]!.send(feeSnapshot);
  assert.equal(page.element('c-state').textContent, 'Fee estimate unavailable');
  assert.equal(page.element('c-val').textContent, '');
  page.hide();
});
