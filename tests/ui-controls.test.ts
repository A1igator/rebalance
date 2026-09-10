import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const token = 'a'.repeat(64);
const wallet = `0x${'1'.repeat(40)}`, otherWallet = `0x${'2'.repeat(40)}`;
const requestId = '00000000-0000-4000-8000-000000000001';
const flush = async () => { await new Promise<void>(resolve => setImmediate(resolve)); };
type Reply = { ok: boolean; status?: number; json: () => Promise<unknown> };
type Call = { url: string; method: string; body?: Record<string, unknown>; signal?: AbortSignal };
const ok = (value: unknown): Reply => ({ ok: true, status: 200, json: async () => value });
const chart = (address = wallet) => ({ chain: { id: 4663 }, wallet: address });
const runner = (state = 'stopped', address = wallet) => ({ wallet: address, state });
const result = (state = 'running', extra = {}) => ({ ...runner(state), outcome: state === 'running' ? 'started' : 'stopped', requestId, message: '', ...extra });
function deferred<T = void>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
class Node {
  textContent = ''; title = ''; hidden = false; disabled = false; value = ''; readOnly = false; selected = 0; focused = 0;
  attrs: Record<string, string> = {}; dataset: Record<string, string> = {};
  handlers = new Map<string, (() => void)[]>();
  setAttribute(name: string, value: string) { this.attrs[name] = value; }
  removeAttribute(name: string) { delete this.attrs[name]; }
  addEventListener(name: string, handler: () => void) { this.handlers.set(name, [...this.handlers.get(name) || [], handler]); }
  click() { if (!this.disabled) this.dispatch('click'); }
  dispatch(name: string) { for (const handler of this.handlers.get(name) || []) handler(); }
  focus() { this.focused++; }
  select() { this.selected++; }
  setSelectionRange(_start: number, _end: number) { this.selected++; }
}
type Controls = { updateStatus: (value: unknown, disconnected?: boolean) => void; updateRunner: (value: unknown, disconnected?: boolean) => void };
async function browser(options: { token?: string | null; clipboard?: false | ((text: string) => Promise<void>); reply?: (call: Call) => Promise<Reply | undefined> } = {}) {
  const nodes = new Map<string, Node>(), events = new Map<string, (() => void)[]>(), subscribers = new Set<(value: unknown) => void>();
  const timers = new Map<number, () => void>(), calls: Call[] = [], copied: string[] = [];
  let uuidCalls = 0, timerId = 0;
  const byId = (id: string) => {
    if (!nodes.has(id)) { const node = new Node(); node.hidden = ['funding-fallback', 'control-message'].includes(id); nodes.set(id, node); }
    return nodes.get(id)!;
  };
  const window: { rebalanceControls?: Controls; rebalanceView: { token: string | null; subscribe: (callback: (value: unknown) => void) => () => void }; addEventListener: (name: string, handler: () => void) => void } = {
    rebalanceView: { token: options.token === undefined ? token : options.token,
      subscribe: callback => { subscribers.add(callback); return () => subscribers.delete(callback); } },
    addEventListener: (name, handler) => events.set(name, [...events.get(name) || [], handler]),
  };
  const clipboard = options.clipboard === false ? undefined : { writeText: async (text: string) => {
    copied.push(text); if (options.clipboard) await options.clipboard(text);
  } };
  runInNewContext(await readFile(new URL('../ui/portfolio-controls.js', import.meta.url), 'utf8'), {
    window, document: { getElementById: byId }, navigator: { clipboard }, AbortController, URL,
    crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++uuidCalls).padStart(12, '0')}` },
    setTimeout: (callback: () => void) => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: (id: number) => timers.delete(id),
    fetch: async (url: string, init: { method?: string; body?: string; signal?: AbortSignal } = {}) => {
      const call = { url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined, signal: init.signal };
      calls.push(call);
      const response = await options.reply?.(call); if (response) return response;
      if (url === '/api/runner' && call.method === 'GET') return ok(runner());
      throw new Error(`Unexpected mocked request ${call.method} ${url}`);
    },
  });
  await flush();
  const controls = window.rebalanceControls!;
  assert.ok(controls, 'the chart controls expose their input boundary');
  return { byId, calls, copied, timers, get uuidCalls() { return uuidCalls; },
    posts: () => calls.filter(call => call.method === 'POST'),
    async status(value: unknown = chart(), disconnected = false) { controls.updateStatus(value, disconnected); await flush(); },
    async runner(value: unknown = runner(), disconnected = false) { controls.updateRunner(value, disconnected); await flush(); },
    async view(value: unknown = { snapshot: { connectedWallet: wallet } }) { for (const subscriber of subscribers) subscriber(value); await flush(); },
    async ready(state = 'stopped') { controls.updateStatus(chart()); controls.updateRunner(runner(state)); for (const subscriber of subscribers) subscriber({ snapshot: { connectedWallet: wallet } }); await flush(); },
    async click(id: string, force = false) { if (force) byId(id).dispatch('click'); else byId(id).click(); await flush(); },
    async lifecycle(name: string) { for (const handler of events.get(name) || []) handler(); await flush(); },
    async timersRun() { const pending = [...timers.values()]; timers.clear(); for (const callback of pending) callback(); await flush(); },
  };
}

test('runner controls require matching fresh chart, runner and chat attachment inputs', async () => {
  const page = await browser();
  assert.equal(page.byId('portfolio-run').disabled, true);
  await page.status(); assert.equal(page.byId('portfolio-run').disabled, true);
  await page.runner(); assert.equal(page.byId('portfolio-run').disabled, true);
  await page.view(); assert.equal(page.byId('portfolio-run').disabled, false);
  assert.match(page.byId('portfolio-run').textContent, /Start/i);
  await page.view({ snapshot: { connectedWallet: otherWallet } }); assert.equal(page.byId('portfolio-run').disabled, true);
  await page.click('portfolio-run', true); assert.equal(page.posts().length, 0); assert.equal(page.uuidCalls, 0);
  await page.view(); assert.equal(page.byId('portfolio-run').disabled, false);
  await page.runner(runner('stopped', otherWallet)); assert.equal(page.byId('portfolio-run').disabled, true);
  await page.runner(); await page.status(chart(otherWallet)); assert.equal(page.byId('portfolio-run').disabled, true);
});

test('running enables Stop, while transition, deferred and unavailable states cannot dispatch', async () => {
  const page = await browser(); await page.ready('running');
  assert.equal(page.byId('portfolio-run').disabled, false); assert.match(page.byId('portfolio-run').textContent, /Stop/i);
  for (const state of ['starting', 'stopping', 'deferred', 'unavailable', 'not-a-state']) {
    await page.runner(runner(state));
    assert.equal(page.byId('portfolio-run').disabled, true, state);
    await page.click('portfolio-run', true);
  }
  assert.equal(page.posts().length, 0); assert.equal(page.uuidCalls, 0);
});

test('stale or disconnected inputs, absent wallet and missing view capability fail closed', async () => {
  const page = await browser(); await page.ready();
  await page.status(chart(), true); assert.equal(page.byId('portfolio-run').disabled, true);
  await page.status(); assert.equal(page.byId('portfolio-run').disabled, false);
  await page.runner(runner(), true); assert.equal(page.byId('portfolio-run').disabled, true);
  await page.runner(); assert.equal(page.byId('portfolio-run').disabled, false);
  await page.view({ error: 'Connection updates unavailable.', unauthorized: false }); assert.equal(page.byId('portfolio-run').disabled, true);
  await page.view(); await page.status(null); assert.equal(page.byId('portfolio-run').disabled, true);
  await page.status({ wallet: 'bad-wallet' }); assert.equal(page.byId('portfolio-run').disabled, true);
  for (const capability of [null]) {
    const denied = await browser({ token: capability }); await denied.ready();
    await denied.click('portfolio-run', true); assert.equal(denied.posts().length, 0); assert.equal(denied.uuidCalls, 0);
  }
});

test('loading, incoming state changes and page restoration never automatically start or stop a runner', async () => {
  const page = await browser(); await page.ready();
  for (const state of ['starting', 'running', 'stopping', 'stopped', 'deferred']) await page.runner(runner(state));
  await page.lifecycle('pagehide'); await page.lifecycle('pageshow'); await page.ready(); await page.timersRun();
  assert.equal(page.posts().length, 0); assert.equal(page.uuidCalls, 0);
});

test('an explicit start sends one pinned request and duplicate activation is ignored while pending', async () => {
  const gate = deferred<Reply>();
  const page = await browser({ reply: async call => call.method === 'POST' ? gate.promise : ok(runner('running')) });
  await page.ready(); await page.click('portfolio-run');
  assert.equal(page.byId('portfolio-run').disabled, true);
  await page.click('portfolio-run'); await page.click('portfolio-run', true);
  assert.equal(page.uuidCalls, 1); assert.equal(page.posts().length, 1);
  assert.equal(page.posts()[0]!.url, '/api/runner');
  assert.deepEqual(page.posts()[0]!.body, { token, wallet, action: 'start', requestId });
  assert.ok(page.calls.every(call => !call.url.includes(token)));
  gate.resolve(ok(result())); await flush();
  assert.match(page.byId('portfolio-run').textContent, /Stop/i);
  assert.equal(page.posts().length, 1);
});

test('Ledger Start describes monitoring and uses only the ordinary runner control', async () => {
  const page = await browser({ reply: async call => call.method === 'POST' ? ok(result()) : ok(runner('running')) });
  await page.ready(); await page.status({ ...chart(), mode: 'ledger' });
  assert.equal(page.byId('portfolio-run').disabled, false);
  assert.match(page.byId('portfolio-run').title, /Start monitoring this Ledger wallet/);
  assert.match(page.byId('portfolio-run').title, /separate request and physical confirmation/);
  await page.click('portfolio-run');
  assert.deepEqual(page.posts().map(call => ({ url: call.url, body: call.body })), [
    { url: '/api/runner', body: { token, wallet, action: 'start', requestId } },
  ]);
  assert.match(page.byId('portfolio-run').title, /Stop monitoring this Ledger portfolio/);
  await page.status({ ...chart(), mode: 'privy' }); await page.runner(runner('stopped'));
  assert.match(page.byId('portfolio-run').title, /Start automatic rebalancing/);
  assert.equal(page.posts().length, 1);
});

test('explicit stop uses stop action and never infers it from unrelated operation or chart state', async () => {
  const page = await browser({ reply: async call => call.method === 'POST' ? ok(result('stopped')) : undefined });
  await page.ready('running');
  await page.status({ ...chart(), operation: { status: 'cooling-down' }, graph: { node: 'interval' } });
  await page.click('portfolio-run');
  assert.deepEqual(page.posts()[0]!.body, { token, wallet, action: 'stop', requestId });
  assert.match(page.byId('portfolio-run').textContent, /Start/i);
  assert.equal(page.posts().length, 1);
});

test('wrong wallet, request ID, state and malformed runner replies never claim a successful start', async () => {
  for (const value of [result('running', { wallet: otherWallet }), result('running', { requestId: 'wrong-request' }),
    result('unsupported'), { requestId, wallet }, null]) {
    const page = await browser({ reply: async call => call.method === 'POST' ? ok(value) : undefined });
    await page.ready(); await page.click('portfolio-run'); await page.timersRun();
    assert.doesNotMatch(page.byId('portfolio-run').textContent, /^Stop$/i);
    assert.equal(page.posts().length, 1); assert.equal(page.uuidCalls, 1);
    assert.equal(page.byId('control-message').hidden, false);
  }
});

test('failed runner requests may reconcile with a read but never retry the action automatically', async () => {
  for (const failure of ['network', 'http', 'json']) {
    const page = await browser({ reply: async call => {
      if (call.method !== 'POST') return undefined;
      if (failure === 'network') throw new Error('Network unavailable');
      if (failure === 'json') return { ok: true, json: async () => { throw new SyntaxError('Invalid JSON'); } };
      return { ok: false, status: 503, json: async () => ({ error: 'Runner unavailable.' }) };
    } });
    await page.ready(); await page.click('portfolio-run'); await page.timersRun();
    assert.equal(page.posts().length, 1); assert.equal(page.uuidCalls, 1);
    assert.equal(page.byId('control-message').hidden, false);
    assert.doesNotMatch(page.byId('portfolio-run').textContent, /^Stop$/i);
  }
});

test('an attachment change during a pending action cannot re-enable controls for the old wallet', async () => {
  const gate = deferred<Reply>();
  const page = await browser({ reply: async call => call.method === 'POST' ? gate.promise : ok(runner('running')) });
  await page.ready(); await page.click('portfolio-run');
  await page.view({ snapshot: { connectedWallet: otherWallet } });
  gate.resolve(ok(result())); await flush();
  assert.equal(page.byId('portfolio-run').disabled, true);
  await page.click('portfolio-run', true);
  assert.equal(page.posts().length, 1); assert.equal(page.uuidCalls, 1);
});

test('address copying uses the full displayed wallet and shows Copied only after clipboard success', async () => {
  const gate = deferred();
  const page = await browser({ clipboard: () => gate.promise });
  await page.status();
  assert.match(page.byId('copy-address-label').textContent, /0x1111.*1111/);
  await page.click('copy-address');
  assert.deepEqual(page.copied, [wallet]);
  assert.doesNotMatch(page.byId('copy-address-label').textContent, /Copied/i);
  gate.resolve(); await flush();
  assert.match(page.byId('copy-address-label').textContent, /Copied/i);
  assert.equal(page.byId('funding-fallback').hidden, true);
  assert.equal(page.posts().length, 0);
});

test('denied or unavailable clipboard exposes and selects the exact address without claiming it was copied', async () => {
  for (const clipboard of [false as const, async () => { throw new Error('Clipboard denied'); }]) {
    const page = await browser({ clipboard }); await page.status();
    await page.click('copy-address');
    assert.equal(page.byId('funding-fallback').hidden, false);
    assert.equal(page.byId('funding-address').value, wallet);
    assert.ok(page.byId('funding-address').selected > 0);
    assert.doesNotMatch(page.byId('copy-address-label').textContent, /Copied/i);
    assert.equal(page.posts().length, 0);
  }
});

test('missing or malformed chart wallet cannot copy an address or expose a stale funding address', async () => {
  const page = await browser();
  await page.click('copy-address', true); assert.deepEqual(page.copied, []);
  await page.status(); await page.status({ wallet: 'not-an-address' });
  assert.equal(page.byId('copy-address').disabled, true);
  await page.click('copy-address', true); assert.deepEqual(page.copied, []);
  assert.equal(page.byId('funding-fallback').hidden, true);
  assert.equal(page.byId('funding-address').value, '');
});

test('chart markup gives copy fallback a readonly selectable field and loads controls before chart updates', async () => {
  const [html, app] = await Promise.all(['index.html', 'app.js'].map(file => readFile(new URL(`../ui/${file}`, import.meta.url), 'utf8')));
  assert.match(html!, /<input[^>]*id="funding-address"[^>]*readonly/);
  assert.match(html!, /id="control-message"[^>]*role="status"/);
  assert.ok(html!.indexOf('/portfolio-controls.js') >= 0);
  assert.ok(html!.indexOf('/portfolio-controls.js') < html!.indexOf('/app.js'));
  assert.match(app!, /rebalanceControls\??\.updateStatus/);
});

test('a delayed reconciliation read cannot replace newer runner events or mark them disconnected', async () => {
  for (const fail of [false, true]) {
    const read = deferred<Reply>();
    const page = await browser({ reply: async call => call.method === 'POST'
      ? ok(result('starting', { outcome: 'starting' })) : read.promise });
    await page.ready(); await page.click('portfolio-run');
    assert.equal(page.calls.filter(call => call.method === 'GET').length, 1);
    await page.runner(runner('running'));
    if (fail) read.reject(new Error('Old read failed')); else read.resolve(ok(runner('stopped')));
    await flush();
    assert.equal(page.byId('portfolio-run').dataset.state, 'running');
    assert.equal(page.byId('portfolio-run').disabled, false);
    assert.match(page.byId('portfolio-run').textContent, /^Stop$/i);
    assert.equal(page.posts().length, 1);
  }
});

test('a delayed command response cannot replace a newer runner event while reconciliation is pending', async () => {
  const command = deferred<Reply>(), read = deferred<Reply>();
  const page = await browser({ reply: async call => call.method === 'POST' ? command.promise : read.promise });
  await page.ready(); await page.click('portfolio-run');
  await page.runner(runner('running'));
  command.resolve(ok(result('starting', { outcome: 'starting' }))); await flush();
  assert.equal(page.byId('portfolio-run').dataset.state, 'running');
  read.resolve(ok(runner('running'))); await flush();
  assert.match(page.byId('portfolio-run').textContent, /^Stop$/i);
  assert.equal(page.posts().length, 1);
});

test('each later explicit action receives a new request ID after the previous action finishes', async () => {
  let state = 'stopped';
  const page = await browser({ reply: async call => {
    if (call.method === 'GET') return ok(runner(state));
    state = call.body?.action === 'start' ? 'running' : 'stopped';
    return ok(result(state, { requestId: call.body?.requestId }));
  } });
  await page.ready(); await page.click('portfolio-run'); await page.click('portfolio-run');
  assert.equal(page.uuidCalls, 2);
  assert.deepEqual(page.posts().map(call => call.body), [
    { token, wallet, action: 'start', requestId },
    { token, wallet, action: 'stop', requestId: '00000000-0000-4000-8000-000000000002' },
  ]);
  await page.timersRun(); assert.equal(page.posts().length, 2);
});

test('restoring a chart requires fresh attachment and both fresh status inputs before allowing another action', async () => {
  const page = await browser(); await page.ready();
  await page.lifecycle('pagehide'); await page.lifecycle('pageshow');
  assert.equal(page.byId('portfolio-run').disabled, true);
  await page.status(); assert.equal(page.byId('portfolio-run').disabled, true);
  await page.runner(); assert.equal(page.byId('portfolio-run').disabled, true);
  await page.view(); assert.equal(page.byId('portfolio-run').disabled, false);
  assert.equal(page.posts().length, 0); assert.equal(page.uuidCalls, 0);
});

test('an old clipboard operation cannot claim success or expose a previous wallet after the displayed address changes', async () => {
  for (const fail of [false, true]) {
    const copy = deferred();
    const page = await browser({ clipboard: () => copy.promise });
    await page.status(); await page.click('copy-address');
    await page.status(chart(otherWallet));
    if (fail) copy.reject(new Error('Late clipboard denial')); else copy.resolve();
    await flush();
    assert.deepEqual(page.copied, [wallet]);
    assert.match(page.byId('copy-address-label').textContent, /0x2222.*2222/);
    assert.doesNotMatch(page.byId('copy-address-label').textContent, /Copied/i);
    assert.equal(page.byId('funding-fallback').hidden, true);
    assert.equal(page.byId('funding-address').value, '');
    assert.equal(page.byId('copy-address').disabled, false);
  }
});

test('an earlier copy confirmation timeout cannot hide a newer runner-control error', async () => {
  const page = await browser({ reply: async call => {
    if (call.method === 'POST') throw new Error('Connection interrupted');
    return undefined;
  } });
  await page.ready(); await page.click('copy-address');
  assert.match(page.byId('copy-address-label').textContent, /Copied/i);
  await page.click('portfolio-run');
  assert.match(page.byId('control-message').textContent, /could not confirm/i);
  await page.timersRun();
  assert.equal(page.byId('control-message').hidden, false);
  assert.match(page.byId('control-message').textContent, /could not confirm/i);
  assert.equal(page.posts().length, 1);
});
