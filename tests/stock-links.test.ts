import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import { test } from 'node:test';
import { ASSETS } from '../src/assets.js';

type Node = { tag: string; namespace: string; attrs: Record<string, string>; children: Node[]; parentNode: Node | null;
  handlers: Map<string, () => void>; emit(event: string): void; addEventListener(event: string, handler: () => void): void; cloneNode(deep: boolean): Node;
  setAttribute(name: string, value: string): void; append(node: Node): void; remove(): void };
function node(tag: string, attrs: Record<string, string> = {}): Node {
  const element: Node = { tag, namespace: 'http://www.w3.org/2000/svg', attrs: { ...attrs }, children: [], parentNode: null,
    handlers: new Map(), emit(event) { element.handlers.get(event)?.(); },
    addEventListener(event, handler) { element.handlers.set(event, handler); },
    cloneNode(deep) { const copy = node(tag, element.attrs); if (deep) for (const child of element.children) copy.append(child.cloneNode(true)); return copy; },
    setAttribute(name, value) { element.attrs[name] = value; },
    append(child) { child.remove(); child.parentNode = element; element.children.push(child); },
    remove() {
      if (element.parentNode) element.parentNode.children = element.parentNode.children.filter(child => child !== element);
      element.parentNode = null;
    },
  };
  return element;
}
async function fixture() {
  const script = await readFile(new URL('../ui/stock-links.js', import.meta.url), 'utf8');
  const window: { rebalanceStockLinks?: { wrap(node: Node, id: unknown, kind: unknown): Node; remove(node: Node): void; refresh(node: Node): void; setOffset(id: unknown, x: number, y: number): void }; location: unknown; open(): never } = {
    location: { href: 'http://127.0.0.1:4663/chart#view=private-view-fixture', hash: '#view=private-view-fixture' },
    open: () => assert.fail('Links must navigate natively only after a user click'),
  };
  const context = createContext({ window, fetch: () => assert.fail('Rendering links must not send requests'),
    document: { createElementNS: (namespace: string, tag: string) => {
      assert.equal(namespace, 'http://www.w3.org/2000/svg'); return node(tag);
    } },
  });
  runInContext(script, context);
  assert.ok(window.rebalanceStockLinks);
  return window.rebalanceStockLinks;
}

test('every configured asset links only its public ticker search, with explicit stablecoin identity for USDG', async () => {
  const links = await fixture();
  for (const id of Object.keys(ASSETS)) {
    const link = links.wrap(node('circle'), id, 'actual');
    assert.equal(link.tag, 'a');
    const href = new URL(link.attrs.href);
    assert.equal(href.origin, 'https://www.google.com'); assert.equal(href.pathname, '/search');
    assert.deepEqual([...href.searchParams.keys()], ['q']);
    assert.equal(href.searchParams.get('q'), `${id} ${id === 'USDG' ? 'stablecoin' : 'stock'} chart`);
    assert.equal(href.hash, ''); assert.equal(href.username, ''); assert.equal(href.password, '');
    assert.ok(!link.attrs.href.includes('private-view-fixture'));
  }
});

test('actual, target and label anchors are keyboard accessible native new-tab links', async () => {
  const links = await fixture();
  for (const kind of ['actual', 'target', 'label']) {
    const content = node(kind === 'label' ? 'g' : 'circle');
    const link = links.wrap(content, 'AAPL', kind);
    assert.equal(link.namespace, 'http://www.w3.org/2000/svg');
    assert.equal(link.attrs.target, '_blank'); assert.equal(link.attrs.rel, 'noopener noreferrer');
    assert.equal(link.attrs.referrerpolicy, 'no-referrer'); assert.equal(link.attrs.tabindex, '0');
    assert.equal(link.attrs.class, `stock-link stock-link--${kind}`);
    assert.match(link.attrs['aria-label'], /AAPL stock chart on Google/);
    assert.match(link.attrs['aria-label'], /opens in a new tab/);
    assert.match(link.attrs['aria-label'], new RegExp(kind === 'label' ? 'allocation label' : `${kind} allocation`));
    assert.equal(link.children[0].attrs.class, 'stock-link__visual');
    assert.deepEqual(link.children[0].children, [content]);
    assert.equal(link.children[1].attrs.class, 'stock-link__hit');
  }
});

test('unsupported and injected IDs or kinds stay unlinked instead of influencing an external URL', async () => {
  const links = await fixture();
  for (const id of ['', 'ETH', 'aapl', 'AAPL&wallet=private-wallet', '<script>', '__proto__', null, undefined, { symbol: 'AAPL' }]) {
    const shape = node('circle');
    assert.equal(links.wrap(shape, id, 'actual'), shape); assert.equal(shape.parentNode, null);
    assert.equal(shape.attrs.href, undefined);
  }
  for (const kind of ['', 'constructor', '__proto__', 'onclick=bad', null]) {
    const shape = node('circle'); assert.equal(links.wrap(shape, 'AAPL', kind), shape);
  }
});

test('wrapping preserves single-asset, target and tiny-slice geometry byte for byte', async () => {
  const links = await fixture();
  const examples = [
    node('circle', { cx: '210', cy: '210', r: '150', fill: 'none', 'stroke-width': '44', pathLength: '100', 'stroke-dasharray': '100 0', 'stroke-dashoffset': '0', stroke: '#8dbafa' }),
    node('circle', { cx: '210', cy: '210', r: '120', fill: 'none', 'stroke-width': '6', pathLength: '100', 'stroke-dasharray': '0.006666666666666666 99.99333333333334', 'stroke-dashoffset': '-99.99', stroke: '#8dbafa' }),
    node('path', { d: 'M 100 0 A 100 100 0 0 1 0 100 L 0 80 A 80 80 0 0 0 80 0 Z', fill: '#8dbafa' }),
  ];
  for (const shape of examples) {
    const before = JSON.stringify(shape.attrs);
    const link = links.wrap(shape, 'AAPL', 'target');
    assert.equal(JSON.stringify(shape.attrs), before); assert.equal(link.children[0].children[0], shape);
    assert.equal(shape.attrs.transform, undefined);
  }
});

test('render reuse keeps one anchor per segment and removal clears stale assets completely', async () => {
  const links = await fixture(), parent = node('g'), shape = node('circle');
  const first = links.wrap(shape, 'AAPL', 'actual'); parent.append(first);
  assert.equal(links.wrap(shape, 'AAPL', 'actual'), first);
  assert.equal(parent.children.length, 1); assert.equal(first.children.length, 2);
  links.remove(shape);
  assert.equal(parent.children.length, 0); assert.equal(shape.parentNode, null); assert.equal(first.children.length, 0);
  const next = links.wrap(shape, 'AAPL', 'target');
  assert.notEqual(next, first); assert.equal(next.attrs.class, 'stock-link stock-link--target');
});

test('a reused node cannot keep a previous stock URL when its new identity is unsupported', async () => {
  const links = await fixture(), parent = node('g'), shape = node('circle');
  parent.append(links.wrap(shape, 'AAPL', 'actual'));
  assert.equal(links.wrap(shape, 'untrusted-asset', 'actual'), shape);
  assert.equal(parent.children.length, 0); assert.equal(shape.parentNode, null);
});

test('empty charts gain no invented links and plain fallback geometry can still be removed', async () => {
  const links = await fixture(), parent = node('g'), plain = node('circle');
  assert.equal(parent.children.length, 0);
  parent.append(plain); links.remove(plain);
  assert.equal(parent.children.length, 0);
});

test('linked asset motion uses one global vector across rotated rings and ordinary labels', async () => {
  const links = await fixture();
  const anchors = ['actual', 'target', 'label'].map(kind => links.wrap(node('path'), 'AAPL', kind));
  links.setOffset('AAPL', 8.4, -11.2);
  for (const anchor of anchors.slice(0, 2)) assert.equal(anchor.attrs.style, '--stock-offset-x:11.2px;--stock-offset-y:8.4px');
  assert.equal(anchors[2].attrs.style, '--stock-offset-x:8.4px;--stock-offset-y:-11.2px');
  // Applying the parent's -90deg rotation maps local(11.2,8.4) to global(8.4,-11.2).
  assert.equal(Math.hypot(8.4, -11.2), 14);
  for (const [x, y] of [[NaN, 0], [0, Infinity], [50, 0]]) links.setOffset('AAPL', x, y);
  assert.equal(anchors[2].attrs.style, '--stock-offset-x:8.4px;--stock-offset-y:-11.2px');
});

test('hover or focus on any representation highlights both bars and label without affecting another asset', async () => {
  const links = await fixture();
  const anchors = ['actual', 'target', 'label'].map(kind => links.wrap(node('path'), 'AAPL', kind));
  const other = links.wrap(node('path'), 'NVDA', 'actual');
  const highlighted = () => anchors.every(anchor => anchor.attrs.class.includes('is-highlighted'));
  for (const anchor of anchors) {
    anchor.emit('pointerenter'); assert.equal(highlighted(), true);
    assert.ok(!other.attrs.class.includes('is-highlighted'));
    anchor.emit('pointerleave'); assert.equal(highlighted(), false);
    anchor.emit('focusin'); assert.equal(highlighted(), true);
    anchor.emit('focusout'); assert.equal(highlighted(), false);
  }
  anchors[2].emit('focusin'); anchors[0].emit('pointerenter'); anchors[0].emit('pointerleave');
  assert.equal(highlighted(), true, 'pointer exit must not erase keyboard focus on the same asset');
  anchors[2].emit('focusout'); assert.equal(highlighted(), false);
});

test('stationary invisible hit geometry prevents outward movement from removing the hover target', async () => {
  const links = await fixture();
  const shape = node('path', { d: 'M 1 2 L 3 4 L 5 6 Z', fill: '#8dbafa' });
  const link = links.wrap(shape, 'AAPL', 'target');
  links.setOffset('AAPL', 0, -14);
  const visual = link.children[0], hit = link.children[1], before = JSON.stringify(hit.attrs);
  assert.equal(visual.children[0], shape); assert.equal(hit.attrs.d, shape.attrs.d);
  assert.equal(hit.attrs['aria-hidden'], 'true'); assert.equal(hit.attrs.tabindex, '-1');
  assert.equal(hit.attrs.transform, undefined); assert.equal(hit.attrs.style, undefined);
  link.emit('pointerenter'); assert.ok(link.attrs.class.includes('is-highlighted'));
  assert.equal(JSON.stringify(hit.attrs), before, 'hover must not move or mutate the stationary pointer target');
  assert.equal(hit.parentNode, link); assert.equal(visual.parentNode, link);
  shape.setAttribute('d', 'M 10 20 L 30 40 L 50 60 Z');
  links.refresh(shape);
  assert.equal(link.children[1].attrs.d, shape.attrs.d); assert.equal(hit.parentNode, null);
  assert.ok(link.attrs.class.includes('is-highlighted'));
});

test('rerenders preserve the native focused anchor and new representations inherit asset emphasis', async () => {
  const links = await fixture();
  const label = node('g'), first = links.wrap(label, 'AAPL', 'label');
  first.emit('focusin');
  assert.equal(links.wrap(label, 'AAPL', 'label'), first);
  const arc = node('path'), actual = links.wrap(arc, 'AAPL', 'actual');
  assert.ok(first.attrs.class.includes('is-highlighted')); assert.ok(actual.attrs.class.includes('is-highlighted'));
  links.remove(label);
  assert.ok(!actual.attrs.class.includes('is-highlighted'), 'removing the only focused representation clears the group');
  assert.equal(first.children.length, 0);
});

test('highlight interaction never intercepts or scripts native navigation', async () => {
  const links = await fixture(), anchor = links.wrap(node('path'), 'AAPL', 'actual');
  assert.deepEqual([...anchor.handlers.keys()].sort(), ['focusin', 'focusout', 'pointerenter', 'pointerleave']);
  anchor.emit('pointerenter'); anchor.emit('focusin');
  assert.equal(new URL(anchor.attrs.href).searchParams.get('q'), 'AAPL stock chart');
  assert.equal(anchor.attrs.target, '_blank'); assert.equal(anchor.attrs.rel, 'noopener noreferrer');
});

test('shared emphasis, stationary hit area and reduced-motion CSS preserve shape boundaries', async () => {
  const css = await readFile(new URL('../ui/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.stock-link\s*\{[^}]*cursor:\s*pointer/);
  assert.match(css, /\.stock-link__hit\s*\{[^}]*opacity:\s*0 !important;[^}]*pointer-events:\s*painted/);
  assert.match(css, /\.stock-link\.is-highlighted \.stock-link__visual\s*\{[^}]*brightness\(1\.25\)[^}]*translate\(var\(--stock-offset-x/);
  assert.match(css, /\.stock-link\.is-highlighted \.arc,\s*\.stock-link\.is-highlighted \.tgt\s*\{[^}]*opacity:\s*1/);
  assert.match(css, /\.stock-link\.is-highlighted \.stock-link__visual \.ticker\s*\{[^}]*font-weight:\s*800/);
  assert.match(css, /\.stock-link:focus-visible\s*\{[^}]*outline:\s*2px solid/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\.stock-link__visual\s*\{\s*transition:\s*none;/);
  assert.match(css, /\.stock-link\.is-highlighted \.stock-link__visual\s*\{\s*transform:\s*none;/);
  assert.match(css, /\.ghost\s*\{[^}]*pointer-events:\s*none/, 'the decorative ghost must not intercept native ring links even at zero opacity');
  assert.ok(!css.match(/\.(?:arc|tgt)\s*\{[^}]*fill:\s*none/), 'filled ring sectors must keep their fill');
});
