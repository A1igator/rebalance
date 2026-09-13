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
const noPrivyPortfolios = portfolios.filter(portfolio => portfolio.mode !== 'privy');
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
  removeAttribute(name: string) { delete this.attrs[name]; }
  addEventListener(name: string, fn: () => void) { this.handlers.set(name, [...this.handlers.get(name) || [], fn]); }
  click() { if (!this.disabled) for (const fn of this.handlers.get('click') || []) fn(); }
  showModal() { this.open = true; }
  close() { this.open = false; for (const fn of this.handlers.get('close') || []) fn(); }
}
function content(node: Node): string { return [node.textContent, ...node.children.map(content)].filter(Boolean).join(' '); }
async function browser(options: { origin?: string; onNavigate?: (url: string) => void; onStatusHold?: (event: 'hold' | 'release') => void; hidden?: boolean; hash?: string; pathname?: string; client?: boolean; selector?: boolean; registry?: typeof portfolios; reply?: (call: Call) => Promise<Reply | undefined> } = {}) {
  const elements = new Map<string, Node>(), lifecycle = new Map<string, (() => void)[]>(), timers = new Map<number, () => void>();
  const calls: Call[] = [], navigations: string[] = [], streams: ReadableStreamDefaultController<Uint8Array>[] = [], setupStreams: ReadableStreamDefaultController<Uint8Array>[] = [];
  let timerId = 0, uuidCalls = 0, stops = 0, selectedWallet: string | null = walletA;
  const timerDelays = new Map<number, number>();
  const byId = (id: string) => {
    if (!elements.has(id)) { const node = new Node('div'); node.id = id; elements.set(id, node); }
    return elements.get(id)!;
  };
  const origin = new URL(options.origin ?? 'http://127.0.0.1:4663');
  const location = { hash: options.hash ?? fragment, pathname: options.pathname ?? (options.selector === false ? '/chart' : '/'), origin: origin.origin, hostname: origin.hostname, protocol: origin.protocol, assign: (url: string) => { options.onNavigate?.(url); navigations.push(url); } };
  const window = { location, stop: () => { stops++; },
    rebalanceStatus: options.onStatusHold ? { suspendForControl: () => {
      options.onStatusHold!('hold'); let released = false;
      return () => { if (!released) { released = true; options.onStatusHold!('release'); } };
    } } : undefined,
    addEventListener: (name: string, fn: () => void) => lifecycle.set(name, [...lifecycle.get(name) || [], fn]) };
  const visibility = new Map<string, (() => void)[]>();
  const document = { visibilityState: options.hidden ? "hidden" : "visible", addEventListener: (name: string, fn: () => void) => visibility.set(name, [...visibility.get(name) || [], fn]),
    getElementById: byId, createElement: (tag: string) => new Node(tag), createElementNS: (_namespace: string, tag: string) => new Node(tag) };
  const context = {
    window, URL, AbortController, TextDecoder,
    crypto: { randomUUID: () => { uuidCalls++; return `00000000-0000-4000-8000-${String(uuidCalls).padStart(12, '0')}`; } },
    document,
    setTimeout: (fn: () => void, delay: number) => { timers.set(++timerId, fn); timerDelays.set(timerId, delay); return timerId; },
    clearTimeout: (id: number) => { timers.delete(id); timerDelays.delete(id); },
    fetch: async (url: string, init: { body?: string; signal?: AbortSignal; method?: string } = {}) => {
      const call = { url, body: init.body ? JSON.parse(init.body) : undefined, signal: init.signal, method: init.method };
      calls.push(call);
      const response = await options.reply?.(call);
      if (response) return response;
      if (url === '/api/view/events' || url === '/api/setup/events') {
        const body = new ReadableStream<Uint8Array>({ start(controller) {
          (url === '/api/setup/events' ? setupStreams : streams).push(controller);
          init.signal?.addEventListener('abort', () => { try { controller.error(new Error('Aborted')); } catch {} });
        } });
        return { ...ok(null), body };
      }
      if (url === '/api/view') return ok({ connectedWallet: selectedWallet, canSetup: true, portfolios: options.registry ?? portfolios, chartUrl: portfolios.find(p => p.wallet === selectedWallet)?.chartUrl ?? null });
      if (url === '/api/portfolios') return ok({ portfolios: options.registry ?? portfolios });
      if (url === '/api/connect') { selectedWallet = call.body?.wallet as string; return ok({ wallet: selectedWallet, chartUrl: portfolios.find(p => p.wallet === selectedWallet)?.chartUrl, tradingChanged: false }); }
      if (url === '/api/setup') return ok({ state: 'preparing', mode: call.body?.mode, requestId: call.body?.requestId, message: 'Preparing your wallet…', tradingChanged: false });
      throw new Error(`Unexpected request ${url}`);
    },
  };
  if (options.client !== false) runInNewContext(await readFile(new URL('../ui/view-client.js', import.meta.url), 'utf8'), context);
  if (options.selector !== false) {
    runInNewContext(await readFile(new URL('../ui/allocation-ring.js', import.meta.url), 'utf8'), context);
    runInNewContext(await readFile(new URL('../ui/selector.js', import.meta.url), 'utf8'), context);
  }
  await flush();
  return {
    subscribe: (callback: (value: any) => void) => (window as typeof window & { rebalanceView: { subscribe: (callback: (value: any) => void) => () => void } }).rebalanceView.subscribe(callback),
    async rotate() {
      const stream = streams.at(-1)!;
      stream.enqueue(new TextEncoder().encode('event: rotate\ndata: {}\n\n')); stream.close(); await flush();
    },
    hold: () => (window as typeof window & { rebalanceView: { suspendForControl: () => () => void } }).rebalanceView.suspendForControl(),
    async openSelector() { (window as typeof window & { rebalanceView: { openSelector: () => void } }).rebalanceView.openSelector(); await flush(); },
    byId, calls, navigations, timers, streams, setupStreams, get uuidCalls() { return uuidCalls; }, get stops() { return stops; },
    select: (value: string | null) => { selectedWallet = value; },
    async expire(delay: number) {
      const entry = [...timers].find(([id]) => timerDelays.get(id) === delay);
      assert.ok(entry, `Expected an active ${delay}ms deadline`);
      timers.delete(entry[0]); timerDelays.delete(entry[0]); entry[1](); await flush();
    },
    cards: () => byId('portfolio-grid').children,
    async click(node: Node) { node.click(); await flush(); },
    async send(value: unknown, chunks = false) {
      const bytes = new TextEncoder().encode(`event: view\r\ndata: ${JSON.stringify(value)}\r\n\r\n`);
      if (chunks) { for (const byte of bytes) streams.at(-1)!.enqueue(Uint8Array.of(byte)); }
      else streams.at(-1)!.enqueue(bytes);
      await flush();
    },
    async sendSetup(value: unknown, chunks = false) {
      const bytes = new TextEncoder().encode(`event: setup\r\ndata: ${JSON.stringify(value)}\r\n\r\n`);
      if (chunks) { for (const byte of bytes) setupStreams.at(-1)!.enqueue(Uint8Array.of(byte)); }
      else setupStreams.at(-1)!.enqueue(bytes);
      await flush();
    },
    async visible(value: boolean) { document.visibilityState = value ? "visible" : "hidden"; for (const fn of visibility.get("visibilitychange") || []) fn(); await flush(); },
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
  assert.match(content(page.cards()[0]!), /Ledger Running.*Targets.*Target allocation.*Robinhood.*USDG 5%, AAPL 23.75%, NVDA 23.75%, MSFT 23.75%, AMD 23.75%/);
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
  page.select(walletB); finish(ok({ wallet: walletB, chartUrl: portfolios[1]!.chartUrl, tradingChanged: false })); await flush();
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

const requestId = '00000000-0000-4000-8000-000000000001';
const setupResult = (mode = 'privy', state = 'preparing', extra = {}) =>
  ({ requestId, mode, state, message: 'Preparing your wallet…', tradingChanged: false, ...extra });
const approval = { url: 'https://agents.privy.io/?user_code=ABC12-XYZ34', code: 'ABC12-XYZ34' };

test('setup submits only the selected signer once and follows local progress without any model queue', async () => {
  for (const mode of ['private-key', 'privy', 'ledger']) {
    const page = await browser({ registry: noPrivyPortfolios });
    await page.click(page.cards().at(-1)!); await page.click(page.byId(`setup-${mode}`));
    await page.click(page.byId(`setup-${mode}`));
    const setup = page.calls.filter(c => c.url === '/api/setup');
    assert.equal(setup.length, 1);
    assert.deepEqual(setup[0]!.body, { token, mode, requestId });
    assert.equal(page.uuidCalls, 1);
    assert.match(page.byId('setup-status').textContent, /Preparing your wallet/);
    assert.equal(page.byId('retry-setup').hidden, true);
    assert.equal(page.calls.filter(c => c.url === '/api/setup/events').length, 1);
    assert.deepEqual(page.calls.find(c => c.url === '/api/setup/events')!.body, { token, requestId });
    if (mode === 'privy') {
      await page.sendSetup(setupResult(mode, 'awaiting-approval', { message: 'Approve the matching code in Privy.', approval }), true);
      assert.equal(page.byId('setup-approval').hidden, false);
      assert.equal(page.byId('setup-approval-code').textContent, approval.code);
      assert.equal(page.byId('setup-approval-link').attrs.href, approval.url);
    } else if (mode === 'ledger') {
      await page.sendSetup(setupResult(mode, 'awaiting-device', { message: 'Unlock Ledger and open Ethereum.' }));
      assert.match(page.byId('setup-status').textContent, /Unlock Ledger/);
      assert.equal(page.byId('setup-approval').hidden, true);
    }
    assert.equal(page.navigations.length, 0); assert.equal(page.timers.size, 0);
    assert.equal(page.calls.some(c => c.url === '/api/connect'), false);
    await page.hide();
  }
});

test('Ledger physical address approval needs no Privy URL and does not imply a signing request', async () => {
  const page = await browser({ registry: noPrivyPortfolios });
  await page.click(page.cards().at(-1)!); await page.click(page.byId('setup-ledger'));
  await page.sendSetup(setupResult('ledger', 'awaiting-approval', { message: 'Verify and approve this address on your Ledger.' }));
  assert.match(page.byId('setup-status').textContent, /Verify and approve this address/);
  assert.equal(page.byId('setup-approval').hidden, true);
  assert.equal(page.byId('retry-setup').hidden, true);
  assert.equal(page.calls.some(c => c.url === '/api/connect' || /sign|transaction/.test(c.url)), false);
  await page.sendSetup(setupResult('ledger', 'awaiting-approval', { approval }));
  assert.match(page.byId('setup-status').textContent, /progress is unavailable/);
  assert.equal(page.byId('setup-approval').hidden, true, 'Ledger cannot supply a Privy approval link');
  await page.hide();
});

test('failed, offline and unverified setup keep the exact same UUID and signer on explicit retry', async () => {
  for (const state of ['failed', 'offline', 'uncertain']) {
    const page = await browser({ registry: noPrivyPortfolios, reply: async call => call.url === '/api/setup' ? state === 'offline'
      ? { ok: false, status: 503, json: async () => ({ error: 'PRIVATE native failure' }) }
      : ok(setupResult('privy', state, { message: 'Complete sign-in or try again.' })) : undefined });
    await page.click(page.cards().at(-1)!); await page.click(page.byId('setup-privy'));
    assert.match(page.byId('setup-status').textContent, state === 'failed' ? /Complete sign-in/ : /progress is unavailable/);
    assert.doesNotMatch(page.byId('setup-status').textContent, /PRIVATE/);
    assert.equal(page.byId('retry-setup').hidden, false);
    await page.click(page.byId('retry-setup'));
    const requests = page.calls.filter(c => c.url === '/api/setup');
    assert.equal(requests.length, 2); assert.deepEqual(requests[0]!.body, requests[1]!.body);
    assert.equal(page.uuidCalls, 1); assert.equal(page.navigations.length, 0);
    await page.hide();
  }
});

test('ready setup connects through the existing path and navigates only after verified connection', async () => {
  let finish!: (value: Reply) => void;
  const page = await browser({ registry: noPrivyPortfolios, reply: async call => call.url === '/api/connect' ? new Promise(resolve => { finish = resolve; }) : undefined });
  await page.click(page.cards().at(-1)!); await page.click(page.byId('setup-privy'));
  await page.sendSetup(setupResult('privy', 'awaiting-approval', { approval }));
  await page.sendSetup(setupResult('privy', 'ready', { wallet: walletB, chartUrl: portfolios[1]!.chartUrl, reused: false }));
  assert.equal(page.navigations.length, 0);
  assert.deepEqual(page.calls.find(c => c.url === '/api/connect')!.body, { token, wallet: walletB });
  assert.equal(page.byId('setup-dialog').open, false);
  assert.equal(page.byId('setup-approval').hidden, true);
  assert.equal(page.byId('setup-approval-link').attrs.href, undefined);
  assert.equal(page.calls.find(c => c.url === '/api/setup/events')!.signal!.aborted, true);
  page.select(walletB); finish(ok({ wallet: walletB, chartUrl: portfolios[1]!.chartUrl, tradingChanged: false })); await flush();
  assert.deepEqual(page.navigations, [`http://127.0.0.1:4664/chart${fragment}`]);
  await page.hide();
});

test('Privy reuse stays in the dialog and connects only after an explicit open, for initial or streamed results', async () => {
  for (const immediate of [true, false]) {
    const ready = setupResult('privy', 'ready', { wallet: walletB, chartUrl: portfolios[1]!.chartUrl, reused: true });
    const page = await browser({ registry: noPrivyPortfolios, reply: async call => immediate && call.url === '/api/setup' ? ok(ready) : undefined });
    await page.click(page.cards().at(-1)!); await page.click(page.byId('setup-privy'));
    if (!immediate) await page.sendSetup(ready);
    assert.equal(page.calls.some(c => c.url === '/api/setup/events'), !immediate);
    assert.equal(page.calls.some(c => c.url === '/api/connect'), false);
    assert.deepEqual(page.navigations, []);
    assert.equal(page.byId('setup-dialog').open, true);
    assert.match(page.byId('setup-status').textContent, /already added.*cannot create another Ethereum wallet/);
    assert.equal(page.byId('open-existing-portfolio').hidden, false);
    assert.equal(page.byId('open-existing-portfolio').disabled, false);
    await page.click(page.byId('open-existing-portfolio'));
    assert.deepEqual(page.calls.find(c => c.url === '/api/connect')!.body, { token, wallet: walletB });
    assert.deepEqual(page.navigations, [`http://127.0.0.1:4664/chart${fragment}`]);
    assert.equal(page.uuidCalls, 1);
    await page.hide();
  }
});

test('dismissed Privy reuse cannot connect, and a reopened setup clears the previous open action', async () => {
  const page = await browser({ registry: noPrivyPortfolios });
  await page.click(page.cards().at(-1)!); await page.click(page.byId('setup-privy'));
  await page.click(page.byId('close-setup'));
  await page.sendSetup(setupResult('privy', 'ready', { wallet: walletB, chartUrl: portfolios[1]!.chartUrl, reused: true }));
  await page.click(page.byId('open-existing-portfolio'));
  assert.equal(page.calls.some(c => c.url === '/api/connect'), false);
  await page.click(page.cards().at(-1)!);
  assert.equal(page.byId('open-existing-portfolio').hidden, true);
  assert.equal(page.byId('setup-privy').disabled, false);
  await page.click(page.byId('open-existing-portfolio'));
  assert.equal(page.calls.some(c => c.url === '/api/connect'), false);
  await page.hide();
});

test('closing setup adds the ready wallet without changing attachment; reopening permits a new request', async () => {
  const page = await browser({ registry: noPrivyPortfolios });
  await page.click(page.cards().at(-1)!); await page.click(page.byId('setup-privy'));
  await page.click(page.byId('close-setup'));
  await page.sendSetup(setupResult('privy', 'ready', { wallet: walletB, chartUrl: portfolios[1]!.chartUrl }));
  assert.equal(page.navigations.length, 0); assert.equal(page.calls.some(c => c.url === '/api/connect'), false);
  assert.match(page.byId('setup-status').textContent, /Select it from the grid/);
  await page.click(page.cards().at(-1)!); await page.click(page.byId('setup-private-key'));
  assert.equal(page.uuidCalls, 2);
  assert.deepEqual(page.calls.filter(c => c.url === '/api/setup')[1]!.body,
    { token, mode: 'private-key', requestId: '00000000-0000-4000-8000-000000000002' });
  await page.hide();
});

test('later agent selection prevents setup completion from stealing attachment while dialog stays open', async () => {
  const page = await browser({ registry: noPrivyPortfolios });
  await page.send(snapshot(walletA, noPrivyPortfolios));
  await page.click(page.cards().at(-1)!); await page.click(page.byId('setup-privy'));
  await page.send(snapshot(walletB));
  assert.equal(page.byId('setup-dialog').open, true);
  await page.sendSetup(setupResult('privy', 'ready', { wallet: walletC, chartUrl: 'http://127.0.0.1:4665/chart' }));
  assert.equal(page.calls.some(c => c.url === '/api/connect'), false);
  assert.deepEqual(page.navigations, [`http://127.0.0.1:4664/chart${fragment}`]);
  assert.match(page.byId('setup-status').textContent, /Select it from the grid/);
  await page.hide();
});

test('a changed first stream snapshot also wins over a delayed initial setup response', async () => {
  let finish!: (value: Reply) => void;
  const page = await browser({ registry: noPrivyPortfolios, reply: async call => call.url === '/api/setup' ? new Promise(resolve => { finish = resolve; }) : undefined });
  await page.click(page.cards().at(-1)!); await page.click(page.byId('setup-privy'));
  await page.send(snapshot(walletB));
  finish(ok(setupResult('privy', 'ready', { wallet: walletC, chartUrl: 'http://127.0.0.1:4665/chart' }))); await flush();
  assert.equal(page.calls.some(c => c.url === '/api/connect'), false);
  assert.equal(page.navigations.length, 0);
  assert.match(page.byId('setup-status').textContent, /Select it from the grid/);
  await page.hide();
});

test('invalid setup identities, states and ready destinations never connect or navigate', async () => {
  for (const changed of [
    { requestId: 'wrong-request' }, { mode: 'ledger' }, { tradingChanged: true }, { state: 'accepted' },
    { state: 'awaiting-device' }, { state: 'awaiting-approval' }, { message: { private: true } },
    { state: 'ready', wallet: walletB, chartUrl: 'https://example.com/chart' },
    { state: 'ready', wallet: 'bad-wallet', chartUrl: portfolios[1]!.chartUrl },
    { state: 'ready', wallet: walletB, chartUrl: portfolios[1]!.chartUrl, reused: 'yes' },
  ]) {
    const page = await browser({ registry: noPrivyPortfolios, reply: async call => call.url === '/api/setup' ? ok(setupResult('privy', 'preparing', changed)) : undefined });
    await page.click(page.cards().at(-1)!); await page.click(page.byId('setup-privy'));
    assert.match(page.byId('setup-status').textContent, /progress is unavailable/);
    assert.equal(page.byId('retry-setup').hidden, false);
    assert.equal(page.navigations.length, 0); assert.equal(page.calls.some(c => c.url === '/api/connect'), false);
    await page.hide();
  }
});

test('only the matching official Privy code link can be shown in the approval dialog', async () => {
  for (const changed of [
    { url: 'https://agents.privy.io.attacker.invalid/?user_code=ABC12-XYZ34' },
    { url: 'http://agents.privy.io/?user_code=ABC12-XYZ34' },
    { url: 'https://agents.privy.io:8443/?user_code=ABC12-XYZ34' },
    { url: 'https://name:secret@agents.privy.io/?user_code=ABC12-XYZ34' },
    { url: 'https://agents.privy.io/other?user_code=ABC12-XYZ34' },
    { url: 'https://agents.privy.io/?user_code=ABC12-XYZ34#secret' },
    { url: 'https://agents.privy.io/?user_code=ABC12-XYZ34&user_code=ABC12-XYZ34' },
    { url: 'https://agents.privy.io/?user_code=ABC12-XYZ34&access_token=secret' },
    { code: 'WRONG-CODE' }, { code: '<script>secret</script>' },
  ]) {
    const page = await browser({ registry: noPrivyPortfolios });
    await page.click(page.cards().at(-1)!); await page.click(page.byId('setup-privy'));
    await page.sendSetup(setupResult('privy', 'awaiting-approval', { approval: { ...approval, ...changed } }));
    assert.match(page.byId('setup-status').textContent, /progress is unavailable/);
    assert.equal(page.byId('setup-approval').hidden, true);
    assert.equal(page.byId('setup-approval-link').attrs.href, undefined);
    assert.equal(page.calls.find(c => c.url === '/api/setup/events')!.signal!.aborted, true);
    assert.equal(page.navigations.length, 0);
    await page.hide();
  }
});

test('failed or interrupted setup streams finish cleanly and retry the same request without healthy polling', async () => {
  for (const failed of [true, false]) {
    const page = await browser({ registry: noPrivyPortfolios });
    await page.click(page.cards().at(-1)!); await page.click(page.byId('setup-ledger'));
    if (failed) await page.sendSetup(setupResult('ledger', 'failed', { message: 'Unlock Ledger and try again.' }));
    else { page.setupStreams.at(-1)!.close(); await flush(); }
    assert.equal(page.byId('retry-setup').hidden, false);
    assert.equal(page.calls.find(c => c.url === '/api/setup/events')!.signal!.aborted, true);
    assert.equal(page.timers.size, 0);
    await page.click(page.byId('retry-setup'));
    const requests = page.calls.filter(c => c.url === '/api/setup');
    assert.equal(requests.length, 2); assert.deepEqual(requests[0]!.body, requests[1]!.body);
    await page.hide();
  }
});

test('page suspension aborts setup streaming and restores its read-only stream without resubmitting or stealing selection', async () => {
  const page = await browser({ registry: noPrivyPortfolios });
  await page.click(page.cards().at(-1)!); await page.click(page.byId('setup-privy'));
  await page.hide();
  assert.equal(page.calls.find(c => c.url === '/api/setup/events')!.signal!.aborted, true);
  await page.show();
  assert.equal(page.calls.filter(c => c.url === '/api/setup').length, 1);
  assert.equal(page.calls.filter(c => c.url === '/api/setup/events').length, 2);
  await page.sendSetup(setupResult('privy', 'ready', { wallet: walletB, chartUrl: portfolios[1]!.chartUrl }));
  assert.equal(page.calls.some(c => c.url === '/api/connect'), false);
  assert.equal(page.navigations.length, 0); assert.equal(page.timers.size, 0);
  await page.hide();
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
  assert.equal(page.timers.size, 0, 'healthy streams need no poll timer');
  await page.send(snapshot(walletB));
  assert.match(content(page.cards()[1]!), /This chat/);
  assert.deepEqual(page.navigations, [`http://127.0.0.1:4664/chart${fragment}`]);
  assert.equal(page.calls.filter(c => c.url === '/api/connect').length, 0, 'agent connection changes are observed, not written back');
  assert.equal(page.timers.size, 1, 'only the document navigation deadline is active');
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
  assert.ok(page.cards().every(card => !card.disabled), 'Back restores selectable cards');
  assert.equal(page.byId('portfolio-status').textContent, '');
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
  assert.equal(page.timers.size, 1, 'navigation has a deadline, not a stream poll');
  await page.hide();
  const denied = await browser({ selector: false, reply: async () => ({ ok: false, status: 403, json: async () => ({ error: 'Invalid view' }) }) });
  assert.equal(denied.timers.size, 0, 'invalid capability does not retry indefinitely');
  const missing = await browser({ selector: false, hash: '#view=not-a-token' });
  assert.equal(missing.calls.length, 0);
});

test('fresh authoritative selection wins over delayed initial reads and a stale successful connection response', async () => {
  let finishView!: (value: Reply) => void, finishConnect!: (value: Reply) => void, reads = 0;
  const third = { ...portfolios[0]!, wallet: walletC, chartUrl: 'http://127.0.0.1:4665/chart' };
  const page = await browser({ reply: async call => call.url === '/api/view' ? ++reads === 1
    ? new Promise(resolve => { finishView = resolve; }) : ok(snapshot(walletC, [...portfolios, third]))
    : call.url === '/api/connect' ? new Promise(resolve => { finishConnect = resolve; }) : undefined });
  await page.send(snapshot(walletA));
  await page.click(page.cards()[1]!);
  assert.ok(page.calls.filter(call => call.url === '/api/view/events').every(call => call.signal!.aborted));
  finishView(ok({ connectedWallet: walletA, canSetup: true }));
  finishConnect(ok({ wallet: walletB, chartUrl: portfolios[1]!.chartUrl, tradingChanged: false })); await flush();
  assert.equal(reads, 2, 'fresh readback confirms the actual attachment after the stream was paused');
  assert.deepEqual(page.navigations, [], 'the stale B reply cannot navigate to B or redirect to unrequested C');
  assert.match(page.byId('portfolio-status').textContent, /changed while connecting/);
  assert.equal(page.cards()[1]!.disabled, false);
  assert.equal(page.calls.filter(call => call.url === '/api/connect').length, 1);
  await page.hide();
});

test('invalid targets remain unavailable and invalid view links never claim a chat connection', async () => {
  const page = await browser({ reply: async call => call.url === '/api/view' ? { ok: false, status: 403, json: async () => ({ error: 'Invalid view' }) }
    : call.url === '/api/portfolios' ? ok({ portfolios: [{ ...portfolios[0], targets: { USDG: 9999 }, error: 'Unreadable config' }] }) : undefined });
  assert.match(content(page.cards()[0]!), /Targets unavailable.*Needs attention/);
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


test('an existing Privy portfolio disables its New option and guards direct activation without creating a request', async () => {
  const page = await browser();
  await page.click(page.cards().at(-1)!);
  const choice = page.byId('setup-privy');
  assert.equal(choice.disabled, true);
  assert.equal(page.byId('privy-choice').attrs['data-limited'], 'true');
  assert.equal(page.byId('privy-choice').attrs.tabindex, '0');
  assert.equal(page.byId('privy-choice').attrs['aria-describedby'], 'privy-limit');
  await page.click(choice);
  for (const handler of choice.handlers.get('click') || []) handler();
  await flush();
  assert.equal(page.uuidCalls, 0);
  assert.equal(page.calls.some(call => call.url === '/api/setup' || call.url === '/api/setup/events'), false);
  assert.equal(page.navigations.length, 0);
  assert.equal(page.byId('setup-private-key').disabled, false);
  assert.equal(page.byId('setup-ledger').disabled, false);
  await page.click(page.byId('close-setup'));
  await page.click(page.cards()[1]!);
  assert.deepEqual(page.calls.find(call => call.url === '/api/connect')!.body, { token, wallet: walletB });
  assert.deepEqual(page.navigations, [`http://127.0.0.1:4664/chart${fragment}`]);
  await page.hide();
});

test('Privy availability follows streamed registry changes while the New dialog is open', async () => {
  const page = await browser({ registry: noPrivyPortfolios });
  await page.click(page.cards().at(-1)!);
  assert.equal(page.byId('setup-privy').disabled, false);
  assert.notEqual(page.byId('privy-choice').attrs['data-limited'], 'true');
  await page.send(snapshot(walletA));
  assert.equal(page.byId('setup-dialog').open, true);
  assert.equal(page.byId('setup-privy').disabled, true);
  assert.equal(page.byId('privy-choice').attrs['data-limited'], 'true');
  await page.click(page.byId('setup-privy'));
  assert.equal(page.uuidCalls, 0); assert.equal(page.calls.some(call => call.url === '/api/setup'), false);
  await page.send(snapshot(walletA, noPrivyPortfolios));
  assert.equal(page.byId('setup-privy').disabled, false);
  assert.notEqual(page.byId('privy-choice').attrs['data-limited'], 'true');
  assert.equal(page.byId('privy-choice').attrs.tabindex, '-1');
  assert.notEqual(page.byId('privy-choice').attrs['aria-describedby'], 'privy-limit');
  await page.click(page.byId('setup-privy'));
  assert.equal(page.uuidCalls, 1);
  assert.deepEqual(page.calls.find(call => call.url === '/api/setup')!.body, { token, mode: 'privy', requestId });
  assert.equal(page.navigations.length, 0);
  await page.hide();
});

test('Privy limit leaves local-key and Ledger onboarding available', async () => {
  for (const mode of ['private-key', 'ledger']) {
    const page = await browser();
    await page.click(page.cards().at(-1)!);
    assert.equal(page.byId('setup-privy').disabled, true);
    assert.equal(page.byId(`setup-${mode}`).disabled, false);
    await page.click(page.byId(`setup-${mode}`));
    assert.equal(page.uuidCalls, 1);
    assert.deepEqual(page.calls.filter(call => call.url === '/api/setup').map(call => call.body), [{ token, mode, requestId }]);
    await page.hide();
  }
});

test('a stale initial registry cannot re-enable Privy after a live snapshot reports it added', async () => {
  let finish!: (value: Reply) => void;
  const page = await browser({ reply: async call => call.url === '/api/portfolios' ? new Promise(resolve => { finish = resolve; }) : undefined });
  await page.send(snapshot(walletA));
  await page.click(page.cards().at(-1)!);
  assert.equal(page.byId('setup-privy').disabled, true);
  finish(ok({ portfolios: noPrivyPortfolios })); await flush();
  assert.equal(page.byId('setup-privy').disabled, true);
  assert.equal(page.byId('privy-choice').attrs['data-limited'], 'true');
  await page.click(page.byId('setup-privy'));
  assert.equal(page.uuidCalls, 0); assert.equal(page.calls.some(call => call.url === '/api/setup'), false);
  await page.hide();
});


test('the disabled Privy option explains the existing-wallet limit on hover and keyboard focus', async () => {
  const [html, css] = await Promise.all(['selector.html', 'selector.css'].map(file => readFile(new URL(`../ui/${file}`, import.meta.url), 'utf8')));
  assert.match(html!, /id="privy-choice"[^>]*role="group"/);
  assert.match(html!, /id="privy-limit"[^>]*role="tooltip">Privy Agent Sandbox supports one Ethereum wallet per account\. Your Privy wallet is already added\.<\/span>/);
  assert.match(css!, /\.privy-limit\s*\{[^}]*display:\s*none/);
  assert.match(css!, /\.privy-choice\[data-limited="true"\]:hover \.privy-limit\s*,\s*\.privy-choice\[data-limited="true"\]:focus-visible \.privy-limit\s*\{\s*display:\s*block/);
});


test('background companion tabs release all view streams and only the visible tab reconnects', async () => {
  const pages = await Promise.all(Array.from({ length: 10 }, () => browser({ selector: false })));
  for (const page of pages) await page.send(snapshot(walletA));
  for (const page of pages) await page.visible(false);
  assert.equal(pages.flatMap(page => page.calls).filter(call => call.url === '/api/view/events' && !call.signal!.aborted).length, 0);
  for (const page of pages) await page.retry();
  assert.ok(pages.every(page => page.calls.length === 1 && page.navigations.length === 0));
  const active = pages[0]!;
  await active.visible(true); await active.show(); await active.visible(true);
  assert.equal(active.calls.length, 2, 'visibility and pageshow cannot create duplicate streams');
  assert.equal(pages.flatMap(page => page.calls).filter(call => !call.signal!.aborted).length, 1);
  await active.send(snapshot(walletB));
  assert.deepEqual(active.navigations, [`http://127.0.0.1:4664/chart${fragment}`]);
  assert.equal(pages.flatMap(page => page.calls).filter(call => !call.signal!.aborted).length, 0, 'navigation retains its free connection slot');
  for (const page of pages) await page.hide();
});

test('a grid opened in the background waits for visibility and stays on the grid with the current attachment', async () => {
  const page = await browser({ hidden: true });
  assert.equal(page.calls.filter(call => call.url === '/api/view/events').length, 0);
  await page.visible(true); await page.send(snapshot(walletA));
  await page.visible(false); await page.visible(true); await page.send(snapshot(walletB));
  assert.equal(page.navigations.length, 0);
  assert.match(content(page.cards()[1]!), /This chat/);
  await page.send(snapshot(walletA));
  assert.deepEqual(page.navigations, [`http://127.0.0.1:4663/chart${fragment}`]);
  await page.hide(); await page.visible(true);
  assert.equal(page.calls.filter(call => call.url === '/api/view/events' && !call.signal!.aborted).length, 0, 'visibility cannot restart a page awaiting pageshow');
});

test('switching to Privy approval suspends progress sockets and resumes the same setup intent', async () => {
  const page = await browser({ registry: noPrivyPortfolios });
  await page.send(snapshot(walletA, noPrivyPortfolios));
  await page.click(page.cards().at(-1)!); await page.click(page.byId('setup-privy'));
  await page.sendSetup(setupResult('privy', 'awaiting-approval', { approval }));
  await page.visible(false);
  assert.ok(page.calls.filter(call => call.url.endsWith('/events')).every(call => call.signal!.aborted));
  await page.visible(true);
  await page.send(snapshot(walletA, noPrivyPortfolios));
  await page.sendSetup(setupResult('privy', 'ready', { wallet: walletB, chartUrl: portfolios[1]!.chartUrl }));
  assert.equal(page.calls.filter(call => call.url === '/api/setup').length, 1);
  assert.equal(page.calls.filter(call => call.url === '/api/setup/events').length, 2);
  assert.equal(page.calls.filter(call => call.url === '/api/connect').length, 1);
  assert.equal(page.uuidCalls, 1);
  assert.deepEqual(page.navigations, [`http://127.0.0.1:4664/chart${fragment}`]);
  await page.hide();
});

test('malformed view frames close their old transport before reconnecting', async () => {
  const page = await browser({ selector: false });
  await page.send({ ...snapshot(walletA), portfolios: null });
  assert.equal(page.calls[0]!.signal!.aborted, true);
  await page.retry();
  assert.equal(page.calls.length, 2);
  assert.equal(page.calls.filter(call => !call.signal!.aborted).length, 1);
  await page.send(snapshot(walletA));
  await page.hide();
});


test('Back after a completed selection allows choosing another portfolio without reconnecting automatically', async () => {
  const page = await browser();
  await page.send(snapshot(walletA));
  await page.click(page.cards()[1]!);
  await page.hide(); await page.show();
  await page.send(snapshot(walletB));
  assert.equal(page.calls.filter(call => call.url === '/api/connect').length, 1);
  assert.ok(page.cards().every(card => !card.disabled));
  await page.click(page.cards()[0]!);
  assert.deepEqual(page.calls.filter(call => call.url === '/api/connect').map(call => call.body?.wallet), [walletB, walletA]);
  assert.deepEqual(page.navigations, [`http://127.0.0.1:4664/chart${fragment}`, `http://127.0.0.1:4663/chart${fragment}`]);
  assert.equal(page.uuidCalls, 0);
  await page.hide();
});

test('connection replies received while away cannot navigate a restored selector or show an obsolete error', async () => {
  for (const rejected of [false, true]) {
    let finish!: (value: Reply) => void;
    const page = await browser({ reply: async call => call.url === '/api/connect'
      ? new Promise(resolve => { finish = resolve; }) : undefined });
    await page.send(snapshot(walletA));
    await page.click(page.cards()[1]!);
    await page.hide();
    finish(rejected ? { ok: false, json: async () => ({ error: 'Obsolete connection error' }) }
      : ok({ wallet: walletB, chartUrl: portfolios[1]!.chartUrl, tradingChanged: false }));
    await flush();
    assert.equal(page.navigations.length, 0);
    await page.show(); await page.send(snapshot(rejected ? walletA : walletB));
    assert.ok(page.cards().every(card => !card.disabled));
    assert.equal(page.byId('portfolio-status').textContent, '');
    assert.equal(page.navigations.length, 0);
    assert.equal(page.calls.filter(call => call.url === '/api/connect').length, 1);
    await page.hide();
  }
});

test('a late pre-Back success or failure cannot replace a newer selection in progress', async () => {
  for (const rejected of [false, true]) {
    const finish: ((value: Reply) => void)[] = [];
    const page = await browser({ reply: async call => call.url === '/api/connect'
      ? new Promise(resolve => { finish.push(resolve); }) : undefined });
    await page.send(snapshot(walletA));
    await page.click(page.cards()[1]!);
    await page.hide(); await page.show(); await page.send(snapshot(walletB));
    await page.click(page.cards()[0]!);
    assert.equal(finish.length, 2);
    finish[0]!(rejected ? { ok: false, json: async () => ({ error: 'Obsolete connection error' }) }
      : ok({ wallet: walletB, chartUrl: portfolios[1]!.chartUrl, tradingChanged: false }));
    await flush();
    assert.equal(page.navigations.length, 0);
    assert.ok(page.cards().slice(0, -1).every(card => card.disabled));
    assert.equal(page.byId('portfolio-status').textContent, 'Connecting this portfolio to your chat…');
    finish[1]!(ok({ wallet: walletA, chartUrl: portfolios[0]!.chartUrl, tradingChanged: false }));
    await flush();
    assert.deepEqual(page.navigations, [`http://127.0.0.1:4663/chart${fragment}`]);
    assert.equal(page.calls.filter(call => call.url === '/api/connect').length, 2);
    await page.hide();
  }
});


test('a chart returns to the selector when its chat is detached, including the first snapshot', async () => {
  for(const initial of [false,true]) {
    const page=await browser({selector:false});
    if(!initial) await page.send(snapshot(walletA));
    await page.send(snapshot(null));
    await page.openSelector();
    assert.deepEqual(page.navigations,[`/${fragment}`],'stream and Back response share one navigation');
    assert.equal(page.calls.filter(call=>call.url==='/api/disconnect').length,0,'observing deselection never writes it again');
    await page.hide();
  }
});


test('control holds release the companion connection and preserve the current selection baseline', async () => {
  const page = await browser({ selector: false });
  await page.send(snapshot());
  const request = page.calls.find(call => call.url === '/api/view/events')!;
  const release = page.hold(), releaseNested = page.hold();
  assert.equal(request.signal!.aborted, true, 'the stream connection is released before control dispatch');
  await flush(); await page.retry();
  assert.equal(page.calls.length, 1);
  assert.equal(page.timers.size, 0, 'intentional abort does not schedule a stream retry');
  release(); release(); await flush();
  assert.equal(page.calls.length, 1);
  releaseNested(); releaseNested(); await flush();
  assert.equal(page.calls.length, 2);
  await page.send(snapshot(walletB));
  assert.deepEqual(page.navigations, [`${portfolios[1]!.chartUrl}${fragment}`], 'changed selection while paused still navigates after reconnect');
  await page.hide();
});

test('companion control holds survive visibility and back-forward-cache transitions', async () => {
  const page = await browser({ selector: false });
  await page.send(snapshot());
  const release = page.hold();
  await page.visible(false); await page.visible(true); await page.show();
  assert.equal(page.calls.length, 1);
  release(); await flush();
  assert.equal(page.calls.length, 2);
  const releaseNext = page.hold();
  await page.hide(); releaseNext(); await page.visible(true);
  assert.equal(page.calls.length, 2);
  await page.show(); await page.show();
  assert.equal(page.calls.length, 3);
  await page.hide();
});

test('a late aborted companion response cannot replace selection or reconnect during a control hold', async () => {
  let finish!: (value: Reply) => void;
  let count = 0;
  const page = await browser({ selector: false, reply: async call => call.url === '/api/view/events' && ++count === 1
    ? new Promise(resolve => { finish = resolve; }) : undefined });
  const release = page.hold();
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new TextEncoder().encode(`event: view\ndata: ${JSON.stringify(snapshot(null))}\n\n`));
  } });
  finish({ ...ok(null), body }); await flush(); await page.retry();
  assert.equal(page.navigations.length, 0, 'a stale disconnect frame must not navigate away');
  assert.equal(page.calls.length, 1);
  release(); await flush();
  assert.equal(page.calls.length, 2);
  await page.send(snapshot());
  assert.equal(page.navigations.length, 0);
  await page.hide();
});


test('portfolio selection frees its view stream before POST and holds it through authoritative readback', async () => {
  let finishConnect!: (value: Reply) => void, finishRead!: (value: Reply) => void, readCount = 0;
  const streamSignals: AbortSignal[] = [];
  const page = await browser({ reply: async call => {
    if (call.url === '/api/view/events') streamSignals.push(call.signal!);
    if (call.url === '/api/connect') {
      assert.ok(streamSignals.length > 0 && streamSignals.every(signal => signal.aborted), 'POST must have a free connection slot');
      return new Promise(resolve => { finishConnect = resolve; });
    }
    if (call.url === '/api/view' && ++readCount > 1) {
      assert.ok(streamSignals.every(signal => signal.aborted), 'readback keeps the same connection slot free');
      return new Promise(resolve => { finishRead = resolve; });
    }
    return undefined;
  } });
  await page.click(page.cards()[1]!);
  await page.click(page.cards()[0]!);
  assert.equal(page.calls.filter(call => call.url === '/api/connect').length, 1);
  finishConnect(ok({ wallet: walletB, chartUrl: portfolios[1]!.chartUrl, tradingChanged: false })); await flush();
  assert.equal(page.navigations.length, 0); assert.ok(page.cards().slice(0, -1).every(card => card.disabled));
  assert.ok(streamSignals.every(signal => signal.aborted));
  finishRead(ok(snapshot(walletB))); await flush();
  assert.deepEqual(page.navigations, [`${portfolios[1]!.chartUrl}${fragment}`]);
  assert.equal(page.calls.filter(call => call.url === '/api/connect').length, 1);
  assert.equal(page.uuidCalls, 0);
  assert.ok(streamSignals.every(signal => signal.aborted), 'successful navigation retains its free browser slot until pagehide');
  await page.hide();
});

test('a timed out connection navigates only after readback confirms the requested wallet without repeating POST', async () => {
  let finish!: (value: Reply) => void;
  const page = await browser({ reply: async call => call.url === '/api/connect' ? new Promise(resolve => { finish = resolve; }) : undefined });
  await page.click(page.cards()[1]!);
  const request = page.calls.find(call => call.url === '/api/connect')!;
  page.select(walletB); await page.expire(15000);
  assert.equal(request.signal!.aborted, true, 'deadline ends HTTP waiting, not the server-side connection');
  assert.deepEqual(page.navigations, [`${portfolios[1]!.chartUrl}${fragment}`]);
  finish(ok({ wallet: walletA, chartUrl: portfolios[0]!.chartUrl, tradingChanged: false })); await flush();
  assert.deepEqual(page.navigations, [`${portfolios[1]!.chartUrl}${fragment}`], 'a late result cannot retarget the page');
  assert.equal(page.calls.filter(call => call.url === '/api/connect').length, 1);
  assert.equal(page.calls.filter(call => call.url === '/api/view').length, 2);
  await page.hide();
});

test('timed out selection stays on the grid and unblocks when readback is unselected, another wallet or unavailable', async () => {
  for (const current of [null, walletA, 'unavailable']) {
    let reads = 0;
    const page = await browser({ reply: async call => {
      if (call.url === '/api/connect') return new Promise<Reply>(() => {});
      if (call.url === '/api/view' && ++reads > 1) {
        if (current === 'unavailable') throw new Error('Readback unavailable');
        return ok(snapshot(current));
      }
      return undefined;
    } });
    await page.click(page.cards()[1]!); await page.expire(15000);
    assert.equal(page.navigations.length, 0, String(current));
    assert.equal(page.cards()[1]!.disabled, false, String(current));
    assert.ok(page.byId('portfolio-status').textContent.length > 0);
    assert.doesNotMatch(page.byId('portfolio-status').textContent, /^Connecting/);
    assert.equal(page.calls.filter(call => call.url === '/api/connect').length, 1);
    await page.hide();
  }
});

test('connection deadline includes stalled JSON and ignores late body data after readback', async () => {
  let finishBody!: (value: unknown) => void;
  const page = await browser({ reply: async call => call.url === '/api/connect'
    ? { ok: true, status: 200, json: () => new Promise(resolve => { finishBody = resolve; }) } : undefined });
  await page.click(page.cards()[1]!); page.select(walletB); await page.expire(15000);
  assert.deepEqual(page.navigations, [`${portfolios[1]!.chartUrl}${fragment}`]);
  finishBody({ wallet: walletA, chartUrl: portfolios[0]!.chartUrl, tradingChanged: true }); await flush();
  assert.deepEqual(page.navigations, [`${portfolios[1]!.chartUrl}${fragment}`]);
  assert.equal(page.calls.filter(call => call.url === '/api/connect').length, 1); await page.hide();
});

test('readback has its own bounded deadline even when the HTTP response or JSON body ignores abort', async () => {
  for (const stalled of ['request', 'json']) {
    let reads = 0;
    const page = await browser({ reply: async call => {
      if (call.url !== '/api/view' || ++reads === 1) return undefined;
      return stalled === 'request' ? new Promise<Reply>(() => {}) : { ok: true, status: 200, json: () => new Promise(() => {}) };
    } });
    await page.click(page.cards()[1]!); await page.expire(4500);
    assert.equal(page.navigations.length, 0);
    assert.equal(page.cards()[1]!.disabled, false);
    const read = page.calls.filter(call => call.url === '/api/view').at(-1)!;
    assert.equal(read.signal!.aborted, true);
    assert.equal(page.calls.filter(call => call.url === '/api/connect').length, 1);
    assert.doesNotMatch(page.byId('portfolio-status').textContent, /^Connecting/);
    await page.hide();
  }
});

test('pagehide aborts connection waiting and prevents late selection/readback navigation after pageshow', async () => {
  for (const phase of ['connect', 'readback']) {
    let finish!: (value: Reply) => void, reads = 0;
    const page = await browser({ reply: async call => {
      if (phase === 'connect' && call.url === '/api/connect') return new Promise(resolve => { finish = resolve; });
      if (call.url === '/api/view' && ++reads > 1 && phase === 'readback') return new Promise(resolve => { finish = resolve; });
      return undefined;
    } });
    await page.click(page.cards()[1]!);
    const pending = page.calls.filter(call => call.url === (phase === 'connect' ? '/api/connect' : '/api/view')).at(-1)!;
    await page.hide();
    assert.equal(pending.signal!.aborted, true);
    assert.ok(page.calls.filter(call => call.url === '/api/view/events').every(call => call.signal!.aborted), 'a release cannot reconnect a hidden page');
    await page.show(); await page.send(snapshot(walletA));
    finish(phase === 'connect' ? ok({ wallet: walletB, chartUrl: portfolios[1]!.chartUrl, tradingChanged: false }) : ok(snapshot(walletB)));
    await flush();
    assert.equal(page.navigations.length, 0);
    assert.ok(page.cards().slice(0, -1).every(card => !card.disabled));
    assert.equal(page.byId('portfolio-status').textContent, '');
    assert.equal(page.calls.filter(call => call.url === '/api/connect').length, 1);
    await page.hide();
  }
});


test('same-origin successful selection keeps its stream closed until navigation and a restored selector reconnects once', async () => {
  const page = await browser();
  await page.send(snapshot(walletA)); await page.click(page.cards()[0]!);
  assert.deepEqual(page.navigations, [`${portfolios[0]!.chartUrl}${fragment}`]);
  const requests = () => page.calls.filter(call => call.url === '/api/view/events');
  assert.equal(requests().length, 1);
  assert.ok(requests().every(call => call.signal!.aborted), 'a replacement SSE must not take the HTML navigation slot');
  await page.hide(); assert.equal(requests().length, 1);
  await page.show(); assert.equal(requests().length, 2);
  await page.send(snapshot(walletA));
  assert.equal(page.navigations.length, 1, 'restoration establishes a baseline without repeating navigation');
  assert.ok(page.cards().slice(0, -1).every(card => !card.disabled));
  assert.equal(page.calls.filter(call => call.url === '/api/connect').length, 1);
  await page.hide();
});


test('an uncertain connection error survives resumed snapshots until a new explicit choice or Back', async () => {
  const page = await browser({ reply: async call => call.url === '/api/connect' ? new Promise<Reply>(() => {}) : undefined });
  await page.send(snapshot(walletA)); await page.click(page.cards()[1]!); await page.expire(15000);
  const error = page.byId('portfolio-status').textContent;
  assert.ok(error.length > 0); assert.doesNotMatch(error, /^Connecting/);
  assert.equal(page.cards()[1]!.disabled, false);
  await page.send(snapshot(walletA));
  assert.equal(page.byId('portfolio-status').textContent, error, 'a healthy transport does not establish the prior request outcome');
  assert.equal(page.cards()[1]!.disabled, false);
  assert.equal(page.calls.filter(call => call.url === '/api/connect').length, 1);
  assert.equal(page.navigations.length, 0);
  await page.click(page.cards()[1]!);
  assert.match(page.byId('portfolio-status').textContent, /^Connecting/);
  assert.equal(page.calls.filter(call => call.url === '/api/connect').length, 2, 'only the new explicit click sends another selection');
  await page.hide(); await page.show(); await page.send(snapshot(walletA));
  assert.equal(page.byId('portfolio-status').textContent, '');
  assert.ok(page.cards().slice(0, -1).every(card => !card.disabled));
  assert.equal(page.calls.filter(call => call.url === '/api/connect').length, 2);
  assert.equal(page.navigations.length, 0);
  await page.hide();
});


test('card navigation keeps the current loopback hostname for same-port and cross-port portfolios', async () => {
  for (const linked of [true, false]) {
    for (const [origin, index] of [['http://localhost:4663', 0], ['http://localhost:4666', 1]] as const) {
      const page = await browser({ origin, hash: linked ? fragment : '' });
      await page.click(page.cards()[index]!);
      const chart = new URL(portfolios[index]!.chartUrl); chart.hostname = 'localhost';
      assert.deepEqual(page.navigations, [`${chart.href}${linked ? fragment : ''}`]);
      assert.equal(page.calls.filter(call => call.url === '/api/connect').length, linked ? 1 : 0);
      assert.ok(page.calls.every(call => !call.url.includes(token)));
      await page.hide();
    }
  }
});

test('a timed out card connection keeps localhost when confirmed readback uses the safe saved chart destination', async () => {
  const page = await browser({ origin: 'http://localhost:4666', reply: async call => call.url === '/api/connect' ? new Promise<Reply>(() => {}) : undefined });
  await page.click(page.cards()[1]!); page.select(walletB); await page.expire(15000);
  assert.deepEqual(page.navigations, [`http://localhost:4664/chart${fragment}`]);
  assert.equal(page.calls.filter(call => call.url === '/api/connect').length, 1);
  await page.hide();
});

test('streamed agent wallet changes preserve localhost on both a selector and an open chart', async () => {
  for (const selector of [true, false]) {
    const page = await browser({ origin: 'http://localhost:4666', selector });
    await page.send(snapshot(walletA)); await page.send(snapshot(walletB));
    assert.deepEqual(page.navigations, [`http://localhost:4664/chart${fragment}`]);
    assert.equal(page.calls.filter(call => call.url === '/api/connect').length, 0, 'observed selection is never written back');
    await page.hide();
  }
});

test('ready and explicitly reused Privy setup retain localhost when opening their verified portfolio', async () => {
  for (const reused of [false, true]) {
    const page = await browser({ origin: 'http://localhost:4666', registry: noPrivyPortfolios });
    await page.click(page.cards().at(-1)!); await page.click(page.byId('setup-privy'));
    await page.sendSetup(setupResult('privy', 'ready', { wallet: walletB, chartUrl: portfolios[1]!.chartUrl, reused }));
    if (reused) {
      assert.equal(page.navigations.length, 0);
      await page.click(page.byId('open-existing-portfolio'));
    }
    assert.deepEqual(page.navigations, [`http://localhost:4664/chart${fragment}`]);
    assert.deepEqual(page.calls.filter(call => call.url === '/api/connect').map(call => call.body), [{ token, wallet: walletB }]);
    await page.hide();
  }
});

test('hostname preservation never sanitizes unsafe server destinations into acceptable localhost URLs', async () => {
  for (const chartUrl of ['http://example.com/chart', 'http://user:password@127.0.0.1:4664/chart',
    'https://127.0.0.1:4664/chart', 'http://127.0.0.1:4664/chart?other=1', 'http://127.0.0.1:4664/chart#other',
    'http://127.0.0.1:4664/other']) {
    const page = await browser({ origin: 'http://localhost:4666', reply: async call => call.url === '/api/connect'
      ? ok({ wallet: walletB, chartUrl, tradingChanged: false }) : undefined });
    await page.click(page.cards()[1]!);
    assert.equal(page.navigations.length, 0, chartUrl);
    assert.equal(page.cards()[1]!.disabled, false);
    assert.match(page.byId('portfolio-status').textContent, /could not be verified/);
    await page.hide();
    const chart = await browser({ origin: 'http://localhost:4666', selector: false });
    await chart.send(snapshot(walletA)); await chart.send({ ...snapshot(walletB), chartUrl });
    assert.equal(chart.navigations.length, 0, chartUrl);
    await chart.hide();
  }
});

test('the current page hostname must itself be loopback before retaining it in a navigation', async () => {
  for (const selector of [true, false]) {
    const page = await browser({ origin: 'http://example.com:4666', selector });
    if (selector) {
      await page.click(page.cards()[1]!);
      assert.equal(page.calls.filter(call => call.url === '/api/connect').length, 0);
    } else {
      await page.send(snapshot(walletB));
    }
    assert.equal(page.navigations.length, 0);
    await page.hide();
  }
});


test('companion navigation frees view and chart streams before assign and holds them until real page restoration', async () => {
  for (const destination of ['selector', 'wallet']) {
    const holds: string[] = [], streams: AbortSignal[] = [];
    let statusHeld = false;
    const page = await browser({ origin: 'http://localhost:4666', selector: false,
      onStatusHold: event => { holds.push(event); statusHeld = event === 'hold'; },
      onNavigate: () => {
        assert.equal(statusHeld, true, 'the chart status stream has relinquished its connection');
        assert.ok(streams.length > 0 && streams.every(signal => signal.aborted), 'the view stream closes before HTML navigation');
      }, reply: async call => { if (call.url === '/api/view/events') streams.push(call.signal!); return undefined; },
    });
    await page.send(snapshot(walletA));
    if (destination === 'selector') await page.openSelector(); else await page.send(snapshot(walletB));
    assert.deepEqual(page.navigations, [destination === 'selector' ? `/${fragment}` : `http://localhost:4664/chart${fragment}`]);
    await page.openSelector();
    assert.equal(page.navigations.length, 1, 'duplicate navigation intents coalesce');
    await page.show();
    assert.deepEqual(holds, ['hold'], 'an initial pageshow does not release a pending navigation');
    assert.equal(streams.length, 1);
    await page.hide();
    assert.deepEqual(holds, ['hold'], 'pagehide keeps both transports closed');
    assert.equal(streams.length, 1);
    await page.show();
    assert.deepEqual(holds, ['hold', 'release']);
    assert.equal(streams.length, 2, 'a restored page establishes exactly one new view stream');
    assert.equal(streams[1]!.aborted, false);
    assert.equal(page.calls.some(call => call.url === '/api/connect'), false);
    await page.hide();
  }
});

test('a rejected browser navigation releases its transport holds immediately', async () => {
  const holds: string[] = [];
  const page = await browser({ selector: false, onStatusHold: event => holds.push(event),
    onNavigate: () => { throw new Error('Fixture navigation blocked'); } });
  await page.send(snapshot(walletA));
  try { await page.openSelector(); } catch (error) { assert.match(String(error), /Fixture navigation blocked/); }
  await flush();
  assert.deepEqual(holds, ['hold', 'release']);
  assert.equal(page.navigations.length, 0);
  const requests = page.calls.filter(call => call.url === '/api/view/events');
  assert.equal(requests.length, 2);
  assert.equal(requests[0]!.signal!.aborted, true);
  assert.equal(requests[1]!.signal!.aborted, false);
  assert.equal(page.calls.some(call => call.url === '/api/connect'), false);
  await page.hide();
});


test('navigation ignores later selection frames already buffered in the same aborted stream chunk', async () => {
  const page = await browser({ origin: 'http://localhost:4666' });
  await page.send(snapshot(walletA));
  const frames = [snapshot(walletB), snapshot(walletC)].map(value => `event: view\ndata: ${JSON.stringify(value)}\n\n`).join('');
  page.streams.at(-1)!.enqueue(new TextEncoder().encode(frames)); await flush();
  assert.deepEqual(page.navigations, [`http://localhost:4664/chart${fragment}`]);
  assert.match(content(page.cards()[1]!), /This chat/, 'the later buffered frame cannot overwrite the snapshot that initiated navigation');
  assert.ok(page.calls.filter(call => call.url === '/api/view/events').every(call => call.signal!.aborted));
  assert.equal(page.calls.some(call => call.url === '/api/connect'), false);
  await page.hide();
});

test('a saved selection with a stalled chart load recovers the cards without replaying selection', async () => {
  const page = await browser(); await page.send(snapshot());
  await page.click(page.cards()[1]!);
  assert.match(page.byId('portfolio-status').textContent, /Opening portfolio/);
  assert.ok(page.cards().slice(0, -1).every(card => card.disabled));
  await page.expire(15000);
  assert.equal(page.stops, 1);
  assert.match(page.byId('portfolio-status').textContent, /connection was saved.*chart did not open/);
  assert.ok(page.cards().slice(0, -1).every(card => !card.disabled));
  await page.send(snapshot(walletB));
  await page.send(snapshot(walletB));
  assert.equal(page.navigations.length, 1);
  assert.equal(page.calls.filter(call => call.url === '/api/connect').length, 1);
  assert.match(page.byId('portfolio-status').textContent, /chart did not open/);
  assert.equal(page.calls.filter(call => call.url === '/api/disconnect').length, 0);
  await page.click(page.cards()[1]!);
  assert.equal(page.navigations.length, 2, 'an explicit click may retry');
  await page.hide(); await page.show();
  assert.equal(page.stops, 1, 'pagehide cancels the old navigation deadline');
  assert.equal(page.byId('portfolio-status').textContent, '');
  await page.hide();
});

test('view-only chart navigation times out visibly without attaching or changing a portfolio', async () => {
  const page = await browser({ hash: '' });
  await page.click(page.cards()[0]!); await page.expire(15000);
  assert.equal(page.stops, 1);
  assert.match(page.byId('portfolio-status').textContent, /^The chart did not open/);
  assert.ok(page.cards().slice(0, -1).every(card => !card.disabled));
  assert.equal(page.calls.some(call => call.method === 'POST'), false);
  await page.hide();
});

test('a stalled automatic return to the selector releases streams and requires explicit retry', async () => {
  const holds: string[] = [];
  const page = await browser({ selector: false, onStatusHold: event => holds.push(event) });
  await page.send(snapshot()); await page.send(snapshot(null));
  assert.deepEqual(page.navigations, [`/${fragment}`]);
  await page.expire(15000);
  assert.equal(page.stops, 1); assert.deepEqual(holds, ['hold', 'release']);
  await page.send(snapshot(null)); await page.send(snapshot(null));
  assert.equal(page.navigations.length, 1, 'the unchanged stream must not loop navigation');
  await page.openSelector(); assert.equal(page.navigations.length, 2);
  assert.equal(page.calls.filter(call => !call.url.endsWith('/events')).length, 0);
  await page.hide(); await page.show(); await page.hide();
});

test('a stalled agent-driven chart change retains its error after fresh connection snapshots', async () => {
  const holds: string[] = [];
  const page = await browser({ onStatusHold: event => holds.push(event) });
  await page.send(snapshot()); await page.send(snapshot(walletB));
  await page.expire(15000);
  assert.equal(page.stops, 1); assert.deepEqual(holds, ['hold', 'release']);
  await page.send(snapshot(walletB)); await page.send(snapshot(walletB));
  assert.equal(page.navigations.length, 1);
  assert.match(page.byId('portfolio-status').textContent, /page did not open/);
  assert.ok(page.cards().slice(0, -1).every(card => !card.disabled));
  await page.hide();
});


test('planned view rotation reads fresh attachment without a false disconnection or reconnect loop', async () => {
  const page = await browser({ selector: false });
  const updates: any[] = []; page.subscribe(value => updates.push(value));
  await page.send(snapshot(walletA)); await page.rotate();
  assert.equal(updates.some(value => value.error), false);
  assert.equal(updates.at(-1).snapshot.connectedWallet, walletA);
  assert.equal(page.calls.filter(call => call.url === '/api/view').length, 1);
  assert.equal(page.streams.length, 1);
  assert.equal(page.calls.filter(call => call.url === '/api/connect').length, 0);
  await page.expire(15000); assert.equal(page.streams.length, 2);
  await page.hide();
});

test('rotation readback follows actual attachment changes while a stalled or denied read fails closed', async () => {
  const changed = await browser({ selector: false });
  await changed.send(snapshot(walletA)); changed.select(walletB); await changed.rotate();
  assert.deepEqual(changed.navigations, [`${portfolios[1]!.chartUrl}${fragment}`]);
  assert.equal(changed.calls.some(call => call.url === '/api/connect'), false); await changed.hide();
  for (const phase of ['transport', 'body', 'denied']) {
    let finish!: (value: any) => void;
    const page = await browser({ selector: false, reply: async call => call.url === '/api/view'
      ? phase === 'denied' ? { ok: false, status: 403, json: async () => ({}) }
      : phase === 'transport' ? new Promise(resolve => { finish = resolve; })
      : { ok: true, json: () => new Promise(resolve => { finish = resolve; }) } : undefined });
    const updates: any[] = []; page.subscribe(value => updates.push(value));
    await page.send(snapshot(walletA)); await page.rotate();
    if (phase !== 'denied') {
      assert.equal(updates.some(value => value.error), false);
      await page.expire(4500);
    }
    assert.equal(typeof updates.at(-1).error, 'string');
    assert.equal(updates.at(-1).unauthorized, phase === 'denied');
    const count = updates.length;
    if (finish) finish(phase === 'transport' ? ok(snapshot(walletB)) : snapshot(walletB));
    await flush(); assert.equal(updates.length, count); assert.equal(page.navigations.length, 0);
    assert.equal(page.calls.some(call => call.url === '/api/connect'), false); await page.hide();
  }
});

test('a hidden page cancels planned-rotation readback and ignores its later attachment', async () => {
  let finish!: (value: Reply) => void;
  const page = await browser({ selector: false, reply: async call => call.url === '/api/view' ? new Promise(resolve => { finish = resolve; }) : undefined });
  const updates: any[] = []; page.subscribe(value => updates.push(value));
  await page.send(snapshot(walletA)); await page.rotate(); await page.hide();
  assert.equal(page.calls.find(call => call.url === '/api/view')!.signal!.aborted, true);
  finish(ok(snapshot(walletB))); await flush();
  assert.equal(updates.length, 1); assert.equal(page.navigations.length, 0);
  await page.show(); assert.equal(page.streams.length, 2); await page.hide();
});
