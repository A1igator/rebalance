import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const token = 'a'.repeat(64), fragment = `#view=${token}`;
const walletA = `0x${'1'.repeat(40)}`, walletB = `0x${'2'.repeat(40)}`, walletC = `0x${'3'.repeat(40)}`;
const targets = { AMD: 2375, MSFT: 2375, NVDA: 2375, AAPL: 2375, USDG: 500 };
const portfolios = [
  { wallet: walletA, chainId: 4663, mode: 'ledger', targets, running: true, chartUrl: 'http://127.0.0.1:4663/chart' },
  { wallet: walletB, chainId: 4663, mode: 'privy', targets, running: false, chartUrl: 'http://127.0.0.1:4664/chart', allocationObjective: 'user-risk' },
];
type Reply = { ok: boolean; status?: number; json: () => Promise<unknown>; body?: ReadableStream<Uint8Array> };
type Call = { url: string; body?: Record<string, unknown>; signal?: AbortSignal; method?: string };
const ok = (value: unknown): Reply => ({ ok: true, status: 200, json: async () => value });
const flush = async () => { await new Promise<void>(resolve => setImmediate(resolve)); };
class Node {
  id = ''; className = ''; textContent = ''; type = ''; hidden = false; disabled = false; open = false;
  attrs: Record<string, string> = {}; style: Record<string, string> = {}; children: Node[] = [];
  handlers = new Map<string, (() => void)[]>();
  constructor(readonly tag: string) {}
  append(...children: Node[]) { this.children.push(...children); }
  replaceChildren() { this.children = []; }
  setAttribute(name: string, value: string) { this.attrs[name] = value; }
  addEventListener(name: string, fn: () => void) { this.handlers.set(name, [...this.handlers.get(name) || [], fn]); }
  click() { if (!this.disabled) for (const fn of this.handlers.get('click') || []) fn(); }
  showModal() { this.open = true; }
  close() { this.open = false; }
}
function content(node: Node): string { return [node.textContent, ...node.children.map(content)].filter(Boolean).join(' '); }
async function browser(options: { hash?: string; pathname?: string; client?: boolean; selector?: boolean; reply?: (call: Call) => Promise<Reply | undefined> } = {}) {
  const elements = new Map<string, Node>(), lifecycle = new Map<string, (() => void)[]>(), timers = new Map<number, () => void>();
  const calls: Call[] = [], navigations: string[] = [], streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  let timerId = 0, uuidCalls = 0;
  const byId = (id: string) => {
    if (!elements.has(id)) { const node = new Node('div'); node.id = id; elements.set(id, node); }
    return elements.get(id)!;
  };
  const location = { hash: options.hash ?? fragment, pathname: options.pathname ?? (options.selector === false ? '/chart' : '/'), origin: 'http://127.0.0.1:4663', hostname: '127.0.0.1', protocol: 'http:', assign: (url: string) => navigations.push(url) };
  const window = { location, addEventListener: (name: string, fn: () => void) => lifecycle.set(name, [...lifecycle.get(name) || [], fn]) };
  const context = {
    window, URL, AbortController, TextDecoder,
    crypto: { randomUUID: () => { uuidCalls++; return `00000000-0000-4000-8000-${String(uuidCalls).padStart(12, '0')}`; } },
    document: { getElementById: byId, createElement: (tag: string) => new Node(tag) },
    setTimeout: (fn: () => void) => { timers.set(++timerId, fn); return timerId; }, clearTimeout: (id: number) => timers.delete(id),
    fetch: async (url: string, init: { body?: string; signal?: AbortSignal; method?: string } = {}) => {
      const call = { url, body: init.body ? JSON.parse(init.body) : undefined, signal: init.signal, method: init.method };
      calls.push(call);
      const response = await options.reply?.(call);
      if (response) return response;
      if (url === '/api/view/events') {
        const body = new ReadableStream<Uint8Array>({ start(controller) {
          streams.push(controller);
          init.signal?.addEventListener('abort', () => { try { controller.error(new Error('Aborted')); } catch {} });
        } });
        return { ...ok(null), body };
      }
      if (url === '/api/view') return ok({ connectedWallet: walletA, canSetup: true });
      if (url === '/api/portfolios') return ok({ portfolios });
      if (url === '/api/connect') return ok({ wallet: call.body?.wallet, chartUrl: portfolios.find(p => p.wallet === call.body?.wallet)?.chartUrl, tradingChanged: false });
      if (url === '/api/setup') return ok({ state: 'accepted', requestId: call.body?.requestId, message: 'Setup request queued. Continue in your agent.' });
      throw new Error(`Unexpected request ${url}`);
    },
  };
  if (options.client !== false) runInNewContext(await readFile(new URL('../ui/view-client.js', import.meta.url), 'utf8'), context);
  if (options.selector !== false) runInNewContext(await readFile(new URL('../ui/selector.js', import.meta.url), 'utf8'), context);
  await flush();
  return {
    byId, calls, navigations, timers, streams, get uuidCalls() { return uuidCalls; },
    cards: () => byId('portfolio-grid').children,
    async click(node: Node) { node.click(); await flush(); },
    async send(value: unknown, chunks = false) {
      const bytes = new TextEncoder().encode(`event: view\r\ndata: ${JSON.stringify(value)}\r\n\r\n`);
      if (chunks) { for (const byte of bytes) streams.at(-1)!.enqueue(Uint8Array.of(byte)); }
      else streams.at(-1)!.enqueue(bytes);
      await flush();
    },
    async hide() { for (const fn of lifecycle.get('pagehide') || []) fn(); await flush(); },
    async show() { for (const fn of lifecycle.get('pageshow') || []) fn(); await flush(); },
    async retry() { const current = [...timers]; timers.clear(); for (const [, fn] of current) fn(); await flush(); },
  };
}
const snapshot = (wallet: string | null = walletA, values = portfolios) => ({ connectedWallet: wallet, canSetup: true, chartUrl: wallet ? values.find(p => p.wallet === wallet)?.chartUrl ?? 'http://127.0.0.1:4665/chart' : null, portfolios: values });

test('bare selector displays saved targets and signer choices without linking a chat or creating a wallet', async () => {
  const page = await browser({ hash: '' });
  assert.deepEqual(page.calls.map(c => c.url), ['/api/portfolios']);
  assert.match(page.byId('view-notice').textContent, /Viewing only.*through your agent/);
  assert.equal(page.cards().length, 3);
  assert.match(content(page.cards()[0]!), /Ledger Running.*Robinhood.*Target allocation.*USDG 5% AAPL 23.75% NVDA 23.75% MSFT 23.75% AMD 23.75%/);
  assert.match(page.cards()[0]!.attrs['aria-label']!, new RegExp(walletA));
  assert.match(page.cards()[0]!.attrs['aria-label']!, /Saved target allocation/);
  await page.click(page.cards().at(-1)!);
  assert.equal(page.byId('setup-dialog').open, true);
  for (const mode of ['private-key', 'privy', 'ledger']) assert.equal(page.byId(`setup-${mode}`).disabled, true);
  await page.click(page.cards()[1]!);
  assert.deepEqual(page.navigations, ['http://127.0.0.1:4664/chart']);
  assert.equal(page.uuidCalls, 0);
  assert.equal(page.calls.length, 1);
});

test('linked card selection waits for connection success and preserves the view fragment across wallet ports', async () => {
  let finish!: (value: Reply) => void;
  const page = await browser({ reply: async call => call.url === '/api/connect' ? new Promise(resolve => { finish = resolve; }) : undefined });
  assert.match(content(page.cards()[0]!), /This chat/);
  await page.click(page.cards()[1]!);
  assert.equal(page.navigations.length, 0);
  assert.ok(page.cards().slice(0, -1).every(card => card.disabled));
  await page.click(page.cards()[0]!);
  assert.equal(page.calls.filter(c => c.url === '/api/connect').length, 1);
  assert.deepEqual(page.calls.find(c => c.url === '/api/connect')!.body, { token, wallet: walletB });
  finish(ok({ wallet: walletB, chartUrl: portfolios[1]!.chartUrl, tradingChanged: false })); await flush();
  assert.deepEqual(page.navigations, [`http://127.0.0.1:4664/chart${fragment}`]);
  assert.ok(page.calls.every(c => !c.url.includes(token)));
  await page.hide();
});

test('connection errors and unverified or external chart responses never navigate or claim success', async () => {
  for (const response of [
    { ok: false, json: async () => ({ error: 'Agent connection unavailable.' }) },
    ok({ wallet: walletA, chartUrl: portfolios[1]!.chartUrl, tradingChanged: false }),
    ok({ wallet: walletB, chartUrl: 'https://example.com/chart', tradingChanged: false }),
    ok({ wallet: walletB, chartUrl: 'http://127.0.0.1:4664/chart', tradingChanged: true }),
  ]) {
    const page = await browser({ reply: async call => call.url === '/api/connect' ? response : undefined });
    await page.click(page.cards()[1]!);
    assert.equal(page.navigations.length, 0);
    assert.match(page.byId('portfolio-status').textContent, /unavailable|could not be verified/);
    assert.equal(page.cards()[1]!.disabled, false);
    await page.hide();
  }
});

test('plain-text API rejection gives an actionable error without leaking a JSON parser failure', async () => {
  const page = await browser({ reply: async call => call.url === '/api/connect'
    ? { ok: false, status: 403, json: async () => { throw new SyntaxError('Unexpected token O'); } } : undefined });
  await page.click(page.cards()[1]!);
  assert.match(page.byId('portfolio-status').textContent, /view link is unavailable.*through your agent/);
  assert.doesNotMatch(page.byId('portfolio-status').textContent, /Unexpected token|JSON/);
  assert.equal(page.navigations.length, 0);
  await page.hide();
});

test('setup submits only the selected signer once and reports queued without navigating or auto-selecting', async () => {
  for (const mode of ['private-key', 'privy', 'ledger']) {
    const page = await browser();
    await page.click(page.cards().at(-1)!);
    await page.click(page.byId(`setup-${mode}`));
    await page.click(page.byId(`setup-${mode}`));
    const setup = page.calls.filter(c => c.url === '/api/setup');
    assert.equal(setup.length, 1);
    assert.deepEqual(setup[0]!.body, { token, mode, requestId: '00000000-0000-4000-8000-000000000001' });
    assert.equal(page.uuidCalls, 1);
    assert.match(page.byId('setup-status').textContent, /queued.*agent/);
    assert.equal(page.navigations.length, 0);
    assert.equal(page.calls.some(c => c.url === '/api/connect'), false);
    assert.equal(page.cards().length, 3);
    await page.hide();
  }
});

test('pending, uncertain and offline setup keep the same logical request on explicit retry', async () => {
  for (const state of ['pending', 'uncertain', 'offline']) {
    const page = await browser({ reply: async call => call.url === '/api/setup' ? state === 'offline'
      ? { ok: false, status: 503, json: async () => ({ error: 'Agent is offline. Open your agent and check the request.' }) }
      : ok({ state, requestId: call.body!.requestId, message: '' }) : undefined });
    await page.click(page.cards().at(-1)!); await page.click(page.byId('setup-privy'));
    assert.match(page.byId('setup-status').textContent, new RegExp(state === 'offline' ? 'offline' : state));
    assert.equal(page.byId('retry-setup').hidden, false);
    await page.click(page.byId('retry-setup'));
    const requests = page.calls.filter(c => c.url === '/api/setup');
    assert.equal(requests.length, 2); assert.deepEqual(requests[0]!.body, requests[1]!.body);
    assert.equal(page.uuidCalls, 1); assert.equal(page.navigations.length, 0);
    await page.hide();
  }
});

test('view stream updates cards and follows only subsequent selection changes, so Back stays on the grid', async () => {
  const page = await browser();
  await page.send(snapshot(walletA), true);
  assert.equal(page.navigations.length, 0, 'the initial snapshot never redirects the selector');
  await page.send(snapshot(walletA));
  assert.equal(page.navigations.length, 0);
  const third = { ...portfolios[0]!, wallet: walletC, chartUrl: 'http://127.0.0.1:4665/chart' };
  await page.send(snapshot(walletA, [...portfolios, third]));
  assert.equal(page.cards().length, 4, 'registry changes appear without a reload');
  await page.send(snapshot(walletB));
  assert.match(content(page.cards()[1]!), /This chat/);
  assert.deepEqual(page.navigations, [`http://127.0.0.1:4664/chart${fragment}`]);
  assert.equal(page.calls.filter(c => c.url === '/api/connect').length, 0, 'agent connection changes are observed, not written back');
  assert.equal(page.timers.size, 0, 'healthy streams need no poll timer');
  await page.hide();
  const back = await browser();
  await back.send(snapshot(walletB));
  assert.equal(back.navigations.length, 0);
  await back.hide();
});

test('chart connection watcher follows later changes without touching pricing endpoints and aborts on navigation', async () => {
  const page = await browser({ selector: false });
  assert.deepEqual(page.calls.map(c => c.url), ['/api/view/events']);
  assert.deepEqual(page.calls[0]!.body, { token });
  await page.send(snapshot(walletA)); await page.send(snapshot(walletB));
  assert.deepEqual(page.navigations, [`http://127.0.0.1:4664/chart${fragment}`]);
  await page.hide();
  assert.equal(page.calls[0]!.signal!.aborted, true); assert.equal(page.timers.size, 0);
  await page.show();
  assert.equal(page.calls.length, 2);
  await page.send(snapshot(walletB));
  assert.equal(page.navigations.length, 1, 'restoring unchanged selection does not navigate again');
  await page.hide();
});

test('browser Back restores the grid without bouncing after a card response beat the stream update', async () => {
  const page = await browser();
  await page.send(snapshot(walletA));
  await page.click(page.cards()[1]!);
  assert.deepEqual(page.navigations, [`http://127.0.0.1:4664/chart${fragment}`]);
  await page.hide(); await page.show();
  await page.send(snapshot(walletB));
  assert.equal(page.navigations.length, 1, 'restored selector accepts current selection as its new baseline');
  assert.match(content(page.cards()[1]!), /This chat/);
  await page.send(snapshot(walletA));
  assert.deepEqual(page.navigations, [`http://127.0.0.1:4664/chart${fragment}`, `http://127.0.0.1:4663/chart${fragment}`]);
  await page.hide();
});

test('chart restoration still follows agent selection changes that happened while the page was suspended', async () => {
  const page = await browser({ selector: false });
  await page.send(snapshot(walletA));
  await page.hide(); await page.show(); await page.send(snapshot(walletB));
  assert.deepEqual(page.navigations, [`http://127.0.0.1:4664/chart${fragment}`]);
  await page.hide();
});

test('malformed and unsafe stream updates cannot leak the handle; failures reconnect without polling healthy streams', async () => {
  const page = await browser({ selector: false });
  await page.send(snapshot(walletA));
  await page.send({ ...snapshot(walletB), chartUrl: 'http://example.com/chart' });
  assert.equal(page.navigations.length, 0); assert.equal(page.timers.size, 1);
  await page.retry(); assert.equal(page.calls.length, 2);
  await page.send(snapshot(walletB));
  assert.deepEqual(page.navigations, [`http://127.0.0.1:4664/chart${fragment}`]);
  assert.equal(page.timers.size, 0);
  await page.hide();
  const denied = await browser({ selector: false, reply: async () => ({ ok: false, status: 403, json: async () => ({ error: 'Invalid view' }) }) });
  assert.equal(denied.timers.size, 0, 'invalid capability does not retry indefinitely');
  const missing = await browser({ selector: false, hash: '#view=not-a-token' });
  assert.equal(missing.calls.length, 0);
});

test('fresh streamed selection wins over delayed initial reads and stale connection responses', async () => {
  let finishView!: (value: Reply) => void, finishConnect!: (value: Reply) => void;
  const page = await browser({ reply: async call => call.url === '/api/view' ? new Promise(resolve => { finishView = resolve; })
    : call.url === '/api/connect' ? new Promise(resolve => { finishConnect = resolve; }) : undefined });
  await page.send(snapshot(walletA));
  await page.click(page.cards()[1]!);
  const third = { ...portfolios[0]!, wallet: walletC, chartUrl: 'http://127.0.0.1:4665/chart' };
  await page.send(snapshot(walletC, [...portfolios, third]));
  finishView(ok({ connectedWallet: walletA, canSetup: true }));
  finishConnect(ok({ wallet: walletB, chartUrl: portfolios[1]!.chartUrl, tradingChanged: false })); await flush();
  assert.deepEqual(page.navigations, [`http://127.0.0.1:4665/chart${fragment}`]);
  assert.match(content(page.cards()[2]!), /This chat/);
  assert.match(page.byId('portfolio-status').textContent, /changed while connecting/);
  await page.hide();
});

test('invalid targets remain unavailable and invalid view links never claim a chat connection', async () => {
  const page = await browser({ reply: async call => call.url === '/api/view' ? { ok: false, status: 403, json: async () => ({ error: 'Invalid view' }) }
    : call.url === '/api/portfolios' ? ok({ portfolios: [{ ...portfolios[0], targets: { USDG: 9999 }, error: 'Unreadable config' }] }) : undefined });
  assert.match(content(page.cards()[0]!), /Targets unavailable.*Configuration needs attention/);
  assert.doesNotMatch(content(page.cards()[0]!), /This chat|99\.99%/);
  assert.match(page.byId('view-notice').textContent, /Viewing only/);
  await page.click(page.cards()[0]!);
  assert.equal(page.calls.some(c => c.url === '/api/connect'), false);
  await page.hide();
});

test('both entry pages load the shared watcher, and chart Back retains only a valid view handle', async () => {
  const [chart, grid, script] = await Promise.all(['index.html', 'selector.html', 'app.js'].map(file => readFile(new URL(`../ui/${file}`, import.meta.url), 'utf8')));
  for (const page of [chart!, grid!]) assert.match(page, /src="\/view-client\.js" defer/);
  assert.match(chart!, /id="portfolios-back" href="\/"/);
  assert.doesNotMatch(grid!, /<input|<textarea|localStorage|sessionStorage/);
  const navigation = script!.slice(0, script!.indexOf('  const percent')) + '\n})();';
  for (const [hash, expected] of [[fragment, `/${fragment}`], ['', '/'], ['#view=invalid', '/']]) {
    const link = new Node('a');
    runInNewContext(navigation, { document: { getElementById: () => link }, window: { location: { hash } } });
    assert.equal(link.attrs.href, expected);
  }
});
