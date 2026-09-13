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
  textContent = ''; title = ''; hidden = false; disabled = false;
  attrs: Record<string, string> = {}; dataset: Record<string, string> = {};
  handlers = new Map<string, (() => void)[]>();
  setAttribute(name: string, value: string) { this.attrs[name] = value; }
  removeAttribute(name: string) { delete this.attrs[name]; }
  addEventListener(name: string, handler: () => void) { this.handlers.set(name, [...this.handlers.get(name) || [], handler]); }
  click() { if (!this.disabled) this.dispatch('click'); }
  dispatch(name: string) { for (const handler of this.handlers.get(name) || []) handler(); }
}
type Controls = { updateStatus: (value: unknown, disconnected?: boolean) => void; updateRunner: (value: unknown, disconnected?: boolean) => void };
async function browser(options: { token?: string | null; reply?: (call: Call) => Promise<Reply | undefined>; onTransport?: (event: string) => void } = {}) {
  const nodes = new Map<string, Node>(), events = new Map<string, (() => void)[]>(), subscribers = new Set<(value: unknown) => void>();
  const timers = new Map<number, () => void>(), calls: Call[] = [];
  const html = await readFile(new URL('../ui/index.html', import.meta.url), 'utf8');
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map(match => match[1]));
  let uuidCalls = 0, timerId = 0, now = 1_000_000;
  const byId = (id: string) => {
    assert.ok(ids.has(id), `Control references missing markup: ${id}`);
    if (!nodes.has(id)) { const node = new Node(); node.hidden = id === 'control-message'; nodes.set(id, node); }
    return nodes.get(id)!;
  };
  const holdTransport = (name: string) => {
    options.onTransport?.(`hold:${name}`);
    return () => options.onTransport?.(`release:${name}`);
  };
  const window: { rebalanceControls?: Controls; rebalanceView: { token: string | null; subscribe: (callback: (value: unknown) => void) => () => void; suspendForControl: () => () => void }; rebalanceStatus: { suspendForControl: () => () => void }; addEventListener: (name: string, handler: () => void) => void } = {
    rebalanceView: { token: options.token === undefined ? token : options.token,
      subscribe: callback => { subscribers.add(callback); return () => subscribers.delete(callback); },
      suspendForControl: () => holdTransport('view') },
    rebalanceStatus: { suspendForControl: () => holdTransport('status') },
    addEventListener: (name, handler) => events.set(name, [...events.get(name) || [], handler]),
  };
  runInNewContext(await readFile(new URL('../ui/portfolio-controls.js', import.meta.url), 'utf8'), {
    window, document: { getElementById: byId }, AbortController, URL, Date: { now: () => now },
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
  return { byId, calls, timers, advance: (milliseconds: number) => { now += milliseconds; }, get uuidCalls() { return uuidCalls; },
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
  for (const state of ['starting', 'stopping', 'setting-up', 'deferred', 'unavailable', 'not-a-state']) {
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
  assert.match(page.byId('portfolio-run').title, /Start this Ledger wallet/);
  assert.match(page.byId('portfolio-run').title, /Calibur is Uniswap wallet code/);
  assert.match(page.byId('portfolio-run').title, /two Ledger signatures and one transaction paid in ETH/);
  await page.click('portfolio-run');
  assert.deepEqual(page.posts().map(call => ({ url: call.url, body: call.body })), [
    { url: '/api/runner', body: { token, wallet, action: 'start', requestId } },
  ]);
  assert.match(page.byId('portfolio-run').title, /Stop this Ledger portfolio and cancel waiting device prompts/);
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

test('explorer link uses the full displayed wallet without requiring runner or chat authorization', async () => {
  const page = await browser({ token: null });
  await page.status();
  assert.equal(page.byId('wallet-explorer').attrs.href, `https://robinhoodchain.blockscout.com/address/${wallet}`);
  assert.match(page.byId('wallet-explorer-label').textContent, /0x1111.*1111/);
  assert.match(page.byId('wallet-explorer').attrs['aria-label'], new RegExp(wallet));
  assert.match(page.byId('wallet-explorer').attrs['aria-label'], /opens in a new tab/);
  assert.equal(page.byId('wallet-explorer').attrs['aria-disabled'], 'false');
  assert.equal(page.byId('wallet-explorer').attrs.tabindex, undefined);
  assert.equal(page.byId('portfolio-run').disabled, true);
  await page.click('wallet-explorer');
  assert.equal(page.calls.length, 0); assert.equal(page.uuidCalls, 0);
});

test('explorer link stays pinned to the chart wallet when runner and attachment refer to another wallet', async () => {
  const page = await browser(); await page.status();
  await page.runner(runner('running', otherWallet));
  await page.view({ snapshot: { connectedWallet: otherWallet } });
  assert.equal(page.byId('wallet-explorer').attrs.href, `https://robinhoodchain.blockscout.com/address/${wallet}`);
  await page.status(chart(otherWallet));
  assert.equal(page.byId('wallet-explorer').attrs.href, `https://robinhoodchain.blockscout.com/address/${otherWallet}`);
  assert.match(page.byId('wallet-explorer-label').textContent, /0x2222.*2222/);
  await page.status(chart(otherWallet), true);
  assert.equal(page.byId('wallet-explorer').attrs.href, `https://robinhoodchain.blockscout.com/address/${otherWallet}`, 'a known public wallet remains useful when status updates disconnect');
  assert.equal(page.byId('portfolio-run').disabled, true);
  assert.equal(page.calls.length, 0);
});

test('missing, malformed and wrong-chain wallets remove any prior explorer destination', async () => {
  const page = await browser();
  assert.equal(page.byId('wallet-explorer').attrs.href, undefined);
  for (const snapshot of [null, { wallet }, { chain: { id: 1 }, wallet }, { chain: { id: '4663' }, wallet },
    chart('bad-wallet'), chart(`${wallet}/transactions`), chart(`${wallet}#view=${token}`), chart('javascript:alert(1)')]) {
    await page.status(); await page.status(snapshot);
    assert.equal(page.byId('wallet-explorer').attrs.href, undefined);
    assert.equal(page.byId('wallet-explorer').attrs['aria-disabled'], 'true');
    assert.equal(page.byId('wallet-explorer').attrs.tabindex, '-1');
    assert.equal(page.byId('wallet-explorer-label').textContent, 'Address');
    await page.click('wallet-explorer', true);
  }
  assert.equal(page.calls.length, 0); assert.equal(page.uuidCalls, 0);
});

test('chart uses native external links and a collapsed accessible Settings panel', async () => {
  const [html, app, controls] = await Promise.all(['index.html', 'app.js', 'portfolio-controls.js'].map(file => readFile(new URL(`../ui/${file}`, import.meta.url), 'utf8')));
  const anchor = html!.match(/<a\b[^>]*id="wallet-explorer"[^>]*>/)?.[0];
  assert.ok(anchor);
  assert.match(anchor, /target="_blank"/); assert.match(anchor, /rel="noopener noreferrer"/);
  assert.match(anchor, /referrerpolicy="no-referrer"/); assert.doesNotMatch(anchor, /\bhref=/);
  assert.doesNotMatch(html!, /copy-address|funding-fallback|funding-address|Latest trade|why-trade|why-receipt/);
  assert.doesNotMatch(html!, />Details<|>Fees<|id="panel"|id="sum"/);
  assert.match(html!, /id="settings-toggle"[^>]*aria-expanded="false"[^>]*aria-controls="settings-panel"/);
  assert.match(html!, /id="settings-panel"[^>]*aria-hidden="true"[^>]*inert/);
  assert.match(html!, /Drift trigger/); assert.match(html!, /Cycle interval/); assert.match(html!, /Fee target/);
  assert.doesNotMatch(controls!, /clipboard|window\.open/);
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

test('late runner replies cannot retarget the explorer link after the chart wallet changes', async () => {
  const pending = deferred<Reply>();
  const page = await browser({ reply: async call => call.method === 'POST' ? pending.promise : ok(runner('running')) });
  await page.ready(); await page.click('portfolio-run');
  await page.status(chart(otherWallet));
  pending.resolve(ok(result())); await flush();
  assert.equal(page.byId('wallet-explorer').attrs.href, `https://robinhoodchain.blockscout.com/address/${otherWallet}`);
  assert.match(page.byId('wallet-explorer-label').textContent, /0x2222.*2222/);
  assert.equal(page.posts().length, 1);
});

test('page suspension removes the explorer destination and restoration never triggers a request', async () => {
  const page = await browser(); await page.status();
  await page.lifecycle('pagehide');
  assert.equal(page.byId('wallet-explorer').attrs.href, undefined);
  assert.equal(page.byId('wallet-explorer').attrs['aria-disabled'], 'true');
  await page.lifecycle('pageshow');
  assert.equal(page.byId('wallet-explorer').attrs.href, `https://robinhoodchain.blockscout.com/address/${wallet}`);
  await page.timersRun();
  assert.equal(page.calls.length, 0); assert.equal(page.uuidCalls, 0);
});


const cancelledRequestId = '99999999-1111-4111-8111-111111111111';
const failedLedger = (outcome = 'cancelled') => ({ ...chart(), mode: 'ledger', armed: true,
  ledgerPrompt: { suspended: true, connected: true, outcome },
  ledgerRequest: { id: cancelledRequestId, chainId: 4663, wallet, state: 'finished', outcome } });

test('Ledger Retry requires a suspended request, matching attached running wallet and connected device', async () => {
  const page = await browser(); await page.ready('running');
  assert.equal(page.byId('ledger-retry').hidden, true);
  await page.status(failedLedger());
  assert.equal(page.byId('ledger-retry').hidden, false); assert.equal(page.byId('ledger-retry').disabled, false);
  assert.match(page.byId('ledger-retry').attrs['aria-label'], /^Retry Ledger rebalance for 0x1111…1111$/);
  assert.equal(page.byId('ledger-retry').attrs['aria-busy'], 'false');
  assert.equal(page.byId('ledger-retry').textContent, '', 'rendering never replaces the refresh SVG with text');
  for (const snapshot of [{ ...failedLedger(), mode: 'privy' }, { ...failedLedger(), armed: false },
    { ...failedLedger(), ledgerPrompt: { suspended: false, connected: true } },
    { ...failedLedger(), ledgerRequest: { ...failedLedger().ledgerRequest, wallet: otherWallet } },
    { ...failedLedger(), ledgerRequest: { ...failedLedger().ledgerRequest, state: 'consumed' } }]) {
    await page.status(snapshot); await page.click('ledger-retry', true); assert.equal(page.posts().length, 0);
  }
  for (const state of ['stopped', 'starting', 'stopping', 'unavailable']) {
    await page.status(failedLedger()); await page.runner(runner(state));
    assert.equal(page.byId('ledger-retry').disabled, true); await page.click('ledger-retry', true);
  }
  await page.runner(runner('running')); await page.status(failedLedger(), true);
  assert.equal(page.byId('ledger-retry').disabled, true);
  await page.status({ ...failedLedger(), ledgerPrompt: { suspended: true, connected: false } });
  assert.equal(page.byId('ledger-retry').disabled, true);
  assert.match(page.byId('ledger-retry').title, /Connect USB, unlock Ledger and open Ethereum/);
  await page.status(failedLedger('unsupported')); assert.equal(page.byId('ledger-retry').disabled, false);
  assert.match(page.byId('ledger-retry').title, /after resolving Ledger signing support/);
  await page.status(failedLedger()); await page.view({ snapshot: { connectedWallet: otherWallet } });
  assert.match(page.byId('ledger-retry').title, /Open this portfolio through your agent/);
  await page.click('ledger-retry', true); assert.equal(page.posts().length, 0);
});

test('Retry posts one fresh UUID tied to the failed request, with no runner command or automatic replay', async () => {
  const pending = deferred<Reply>();
  const page = await browser({ reply: async call => call.url === '/api/ledger/retry' ? pending.promise : undefined });
  await page.ready('running'); await page.status(failedLedger());
  await page.click('ledger-retry'); await page.click('ledger-retry', true);
  assert.equal(page.byId('ledger-retry').attrs['aria-busy'], 'true');
  assert.match(page.byId('ledger-retry').attrs['aria-label'], /^Sending Ledger retry for /);
  assert.match(page.byId('ledger-retry').title, /^Sending the retry request/);
  assert.equal(page.posts().length, 1); assert.equal(page.uuidCalls, 1);
  assert.deepEqual(page.posts()[0], { url: '/api/ledger/retry', method: 'POST', signal: undefined,
    body: { token, wallet, requestId, retryOf: cancelledRequestId } });
  assert.equal(page.byId('portfolio-run').disabled, false, 'Stop remains available while a retry is in flight');
  pending.resolve(ok({ wallet, requestId, retryOf: cancelledRequestId, outcome: 'requested' })); await flush();
  assert.equal(page.byId('ledger-retry').attrs['aria-busy'], 'true');
  assert.match(page.byId('ledger-retry').attrs['aria-label'], /^Waiting for Ledger retry status for /);
  await page.status(failedLedger()); await page.click('ledger-retry', true); await page.timersRun();
  assert.equal(page.posts().length, 1, 'unchanged failed status cannot resend');
  await page.status({ ...failedLedger(), ledgerRequest: { ...failedLedger().ledgerRequest, id: requestId } });
  assert.equal(page.byId('ledger-retry').disabled, false, 'a newly finished request permits another explicit Retry');
  assert.equal(page.byId('ledger-retry').attrs['aria-busy'], 'false');
  assert.match(page.byId('ledger-retry').attrs['aria-label'], /^Retry Ledger rebalance for /);
  assert.ok(page.calls.every(call => !call.url.includes(token)));
});

test('unverified Retry replies never claim success or silently retry, and view/lifecycle changes remain closed', async () => {
  for (const failure of ['network', 'wrong-wallet', 'wrong-source', 'http']) {
    const page = await browser({ reply: async call => {
      if (call.url !== '/api/ledger/retry') return undefined;
      if (failure === 'network') throw new Error('Fixture network failure');
      if (failure === 'http') return { ok: false, status: 409, json: async () => ({ error: 'Changed request' }) };
      return ok({ wallet: failure === 'wrong-wallet' ? otherWallet : wallet, requestId,
        retryOf: failure === 'wrong-source' ? requestId : cancelledRequestId, outcome: 'requested' });
    } });
    await page.ready('running'); await page.status(failedLedger()); await page.click('ledger-retry'); await page.timersRun();
    assert.equal(page.posts().length, 1); assert.match(page.byId('control-message').textContent, /Could not confirm/);
    assert.equal(page.byId('ledger-retry').disabled, false, 'another deliberate click still targets the exact old failure; the backend rejects it if already replaced');
    assert.equal(page.byId('ledger-retry').attrs['aria-busy'], 'false');
    await page.lifecycle('pagehide'); await page.lifecycle('pageshow');
    await page.click('ledger-retry', true); assert.equal(page.posts().length, 1);
  }
});


test('Stop reaches Start after PID exit without another file event and never repeats the action', async () => {
  let processAlive = true;
  const page = await browser({ reply: async call => call.method === 'POST'
    ? ok(result('stopping', { outcome: 'stop-requested' })) : ok(runner(processAlive ? 'stopping' : 'stopped')) });
  await page.ready('running'); await page.click('portfolio-run');
  assert.equal(page.byId('portfolio-run').textContent, 'Stopping…');
  assert.equal(page.posts().length, 1);
  const initialReads = page.calls.filter(call => call.method === 'GET').length;
  processAlive = false; // No SSE/file event is emitted when the old PID disappears.
  await page.timersRun();
  assert.equal(page.byId('portfolio-run').textContent, 'Start');
  assert.equal(page.byId('portfolio-run').disabled, false);
  assert.equal(page.calls.filter(call => call.method === 'GET').length, initialReads + 1);
  await page.timersRun(); await page.timersRun();
  assert.equal(page.calls.filter(call => call.method === 'GET').length, initialReads + 1, 'stable runners have no healthy polling');
  assert.equal(page.posts().length, 1); assert.equal(page.uuidCalls, 1); assert.equal(page.timers.size, 0);
});

test('a starting state reconciles to running with read-only transition refresh', async () => {
  const page = await browser({ reply: async () => ok(runner('running')) });
  await page.ready('starting'); await page.timersRun();
  assert.equal(page.byId('portfolio-run').textContent, 'Stop');
  assert.equal(page.calls.length, 1); assert.equal(page.posts().length, 0); assert.equal(page.uuidCalls, 0);
  await page.timersRun(); assert.equal(page.calls.length, 1); assert.equal(page.timers.size, 0);
});

test('transition refreshes are serial and cannot replace a newer runner event', async () => {
  const read = deferred<Reply>();
  const page = await browser({ reply: async () => read.promise });
  await page.ready('stopping'); await page.timersRun();
  assert.equal(page.calls.length, 1);
  await page.status(); await page.view();
  assert.equal(page.calls.length, 1, 'extra render hints do not dispatch concurrent reads');
  await page.runner(runner('stopped'));
  read.resolve(ok(runner('stopping'))); await flush();
  assert.equal(page.byId('portfolio-run').textContent, 'Start');
  await page.timersRun(); assert.equal(page.calls.length, 1); assert.equal(page.posts().length, 0);
});

test('transition refresh stops on deselection, stale status or page suspension', async () => {
  for (const invalidation of ['view', 'status', 'pagehide']) {
    const page = await browser(); await page.ready('stopping');
    if (invalidation === 'view') await page.view({ snapshot: { connectedWallet: null } });
    else if (invalidation === 'status') await page.status(chart(), true);
    else await page.lifecycle('pagehide');
    await page.timersRun();
    assert.equal(page.calls.length, 0, invalidation); assert.equal(page.timers.size, 0, invalidation);
  }
});

test('an unresolved transition has a finite read budget without claiming it stopped or retrying controls', async () => {
  const page = await browser({ reply: async () => ok(runner('stopping')) });
  await page.ready('stopping');
  for (let i = 0; i < 40; i++) await page.timersRun();
  assert.equal(page.calls.length, 30);
  assert.equal(page.byId('portfolio-run').textContent, 'Unavailable');
  assert.match(page.byId('portfolio-run').title, /Refresh the page/);
  assert.equal(page.byId('portfolio-run').disabled, true);
  assert.equal(page.timers.size, 0); assert.equal(page.posts().length, 0); assert.equal(page.uuidCalls, 0);
});


test('a never-settling control POST stops blocking UI, reports unknown outcome and only reads back status', async () => {
  for (const action of ['start', 'stop']) {
    const page = await browser({ reply: async call => call.method === 'POST' ? new Promise<Reply>(() => {}) : ok(runner('stopped')) });
    await page.ready(action === 'start' ? 'stopped' : 'running'); await page.click('portfolio-run');
    assert.equal(page.byId('portfolio-run').disabled, true);
    const sent = page.posts()[0]!; assert.equal(sent.signal?.aborted, false);
    await page.timersRun();
    assert.equal(sent.signal?.aborted, true, 'only the HTTP waiting signal is aborted');
    assert.equal(page.byId('portfolio-run').textContent, 'Start');
    assert.equal(page.byId('portfolio-run').disabled, false);
    assert.match(page.byId('control-message').textContent, /outcome is unknown and it may still finish/);
    assert.doesNotMatch(page.byId('control-message').textContent, /cancelled|stop completed/i);
    assert.equal(page.calls.filter(call => call.method === 'GET').length, 1);
    await page.timersRun(); await page.timersRun();
    assert.equal(page.posts().length, 1); assert.equal(page.uuidCalls, 1); assert.equal(page.timers.size, 0);
  }
});

test('late control response after its deadline cannot replace current state or erase unknown outcome', async () => {
  const late = deferred<Reply>();
  let currentState = 'starting';
  const page = await browser({ reply: async call => call.method === 'POST' ? late.promise : ok(runner(currentState)) });
  await page.ready('stopped'); await page.click('portfolio-run'); await page.timersRun();
  assert.equal(page.byId('portfolio-run').textContent, 'Starting…');
  assert.match(page.byId('control-message').textContent, /outcome is unknown/);
  currentState = 'running'; await page.timersRun();
  assert.equal(page.byId('portfolio-run').textContent, 'Stop');
  late.resolve(ok(result('stopped'))); await flush();
  assert.equal(page.byId('portfolio-run').textContent, 'Stop');
  assert.match(page.byId('control-message').textContent, /outcome is unknown/);
  assert.equal(page.posts().length, 1); assert.equal(page.uuidCalls, 1);
  await page.timersRun(); assert.equal(page.timers.size, 0);
});

test('the control response deadline includes a stalled JSON response body', async () => {
  const page = await browser({ reply: async call => call.method === 'POST'
    ? { ok: true, status: 200, json: () => new Promise(() => {}) } : ok(runner('stopped')) });
  await page.ready(); await page.click('portfolio-run'); await page.timersRun();
  assert.match(page.byId('control-message').textContent, /outcome is unknown/);
  assert.equal(page.byId('portfolio-run').textContent, 'Start');
  assert.equal(page.posts().length, 1); assert.equal(page.calls.filter(call => call.method === 'GET').length, 1);
});


test('runner actions release stream slots before POST and retain them until readback settles', async () => {
  const events: string[] = [], held = new Set<string>(), post = deferred<Reply>(), read = deferred<Reply>();
  const page = await browser({ onTransport: event => {
    events.push(event);
    const [action, name] = event.split(':');
    if (action === 'hold') held.add(name!); else held.delete(name!);
  }, reply: async call => {
    assert.deepEqual([...held].sort(), ['status', 'view'], 'control and reconciliation need both persistent stream slots free');
    events.push(call.method);
    return call.method === 'POST' ? post.promise : read.promise;
  } });
  await page.ready('stopped'); await page.click('portfolio-run');
  assert.deepEqual(events, ['hold:view', 'hold:status', 'POST']);
  await page.click('portfolio-run', true); assert.equal(page.posts().length, 1);
  post.resolve(ok(result())); await flush();
  assert.deepEqual(events, ['hold:view', 'hold:status', 'POST', 'GET']);
  assert.equal(page.byId('portfolio-run').disabled, true, 'readback finishes before streams resume or another action is possible');
  read.resolve(ok(runner('running'))); await flush();
  assert.deepEqual(events, ['hold:view', 'hold:status', 'POST', 'GET', 'release:status', 'release:view']);
  assert.equal(held.size, 0); assert.equal(page.byId('portfolio-run').textContent, 'Stop');
  assert.equal(page.posts().length, 1); assert.equal(page.uuidCalls, 1);
});

test('stream holds survive a command timeout until failed readback, then release with an honest unknown outcome', async () => {
  const events: string[] = [], read = deferred<Reply>();
  const page = await browser({ onTransport: event => events.push(event), reply: async call => {
    events.push(call.method);
    return call.method === 'POST' ? new Promise<Reply>(() => {}) : read.promise;
  } });
  await page.ready('stopped'); await page.click('portfolio-run'); await page.timersRun();
  assert.deepEqual(events, ['hold:view', 'hold:status', 'POST', 'GET']);
  read.reject(new Error('Status transport unavailable')); await flush();
  assert.deepEqual(events, ['hold:view', 'hold:status', 'POST', 'GET', 'release:status', 'release:view']);
  assert.equal(page.byId('portfolio-run').textContent, 'Unavailable');
  assert.match(page.byId('control-message').textContent, /outcome is unknown.*may still finish/);
  assert.match(page.byId('control-message').textContent, /Check the runner state before trying again/);
  assert.doesNotMatch(page.byId('control-message').textContent, /button shows current|cancelled/i);
  await page.timersRun();
  assert.equal(page.posts().length, 1); assert.equal(page.uuidCalls, 1);
});

test('stream holds release after malformed control replies and page suspension without dispatching again', async () => {
  for (const suspend of [false, true]) {
    const events: string[] = [], post = deferred<Reply>();
    const page = await browser({ onTransport: event => events.push(event), reply: async call => {
      events.push(call.method);
      return call.method === 'POST' ? post.promise : ok(runner('stopped'));
    } });
    await page.ready('running'); await page.click('portfolio-run');
    if (suspend) await page.lifecycle('pagehide');
    post.resolve(ok({ ...result(), requestId: 'not-this-request' })); await flush();
    assert.deepEqual(events, ['hold:view', 'hold:status', 'POST', ...suspend ? [] : ['GET'], 'release:status', 'release:view']);
    assert.equal(page.posts().length, 1); assert.equal(page.uuidCalls, 1);
    if (suspend) {
      assert.equal(page.byId('portfolio-run').disabled, true);
      await page.lifecycle('pageshow'); await page.click('portfolio-run', true);
      assert.equal(page.posts().length, 1, 'transport release does not restore stale action authority');
    }
  }
});


test('the later stopping transition read frees stream slots again after the control has reconciled', async () => {
  const held = new Set<string>(), events: string[] = [];
  let reads = 0;
  const page = await browser({ onTransport: event => {
    events.push(event);
    const [action, name] = event.split(':');
    if (action === 'hold') held.add(name!); else held.delete(name!);
  }, reply: async call => {
    assert.deepEqual([...held].sort(), ['status', 'view'], 'each control and transition read must have a browser connection slot');
    events.push(call.method);
    if (call.method === 'POST') return ok(result('stopping', { outcome: 'stop-requested' }));
    return ok(runner(++reads === 1 ? 'stopping' : 'stopped'));
  } });
  await page.ready('running'); await page.click('portfolio-run');
  assert.equal(page.byId('portfolio-run').textContent, 'Stopping…');
  assert.equal(held.size, 0, 'live streams have resumed after the initial readback');
  assert.equal(reads, 1);
  await page.timersRun(); // The PID exits without a new stream event.
  assert.equal(page.byId('portfolio-run').textContent, 'Start');
  assert.equal(held.size, 0); assert.equal(reads, 2);
  assert.deepEqual(events, ['hold:view', 'hold:status', 'POST', 'GET', 'release:status', 'release:view',
    'hold:view', 'hold:status', 'GET', 'release:status', 'release:view']);
  await page.timersRun();
  assert.equal(reads, 2, 'a stable state resumes streams without healthy polling');
  assert.equal(page.posts().length, 1); assert.equal(page.uuidCalls, 1);
});

const caliburRunner = (stage = 'needed', state = 'stopped', address = wallet) => ({ ...runner(state, address), calibur: { state: stage } });

test('Ledger Start explains first Calibur setup only when readiness is absent, needed or unknown', async () => {
  const page = await browser(); await page.ready(); await page.status({ ...chart(), mode: 'ledger' });
  for (const summary of [runner(), caliburRunner('needed'), caliburRunner('unknown')]) {
    await page.runner(summary);
    assert.equal(page.byId('portfolio-run').textContent, 'Start'); assert.equal(page.byId('portfolio-run').disabled, false);
    assert.match(page.byId('portfolio-run').title, /Uniswap wallet code that batches token approvals and swaps/);
    assert.match(page.byId('portfolio-run').title, /two Ledger signatures and one transaction paid in ETH/);
    assert.match(page.byId('portfolio-run').title, /later rebalances need one transaction signature/);
  }
  await page.runner(caliburRunner('ready'));
  assert.match(page.byId('portfolio-run').title, /backend opens device prompts automatically/);
  assert.doesNotMatch(page.byId('portfolio-run').title, /First setup/);
  for (const mode of ['privy', 'private-key']) {
    await page.status({ ...chart(), mode }); await page.runner(caliburRunner('needed'));
    assert.match(page.byId('portfolio-run').title, /Start automatic rebalancing/);
    assert.doesNotMatch(page.byId('portfolio-run').title, /Calibur/);
  }
  assert.equal(page.posts().length, 0);
});

test('setup stage labels require the current wallet and never dispatch another Start', async () => {
  const page = await browser(); await page.ready(); await page.status({ ...chart(), mode: 'ledger' });
  for (const [stage, label] of [['authorizing', 'Authorize Calibur…'], ['signing', 'Confirm setup…'],
    ['confirming', 'Waiting for setup receipt…'], ['unknown', 'Setting up Calibur…'], ['unexpected-stage', 'Setting up Calibur…']]) {
    await page.runner(caliburRunner(stage, 'setting-up'));
    assert.equal(page.byId('portfolio-run').textContent, label);
    assert.equal(page.byId('portfolio-run').dataset.state, 'setting-up');
    assert.equal(page.byId('portfolio-run').disabled, true);
    assert.equal(page.byId('portfolio-run').attrs['aria-busy'], 'true');
    assert.match(page.byId('portfolio-run').title, /First setup needs two Ledger signatures/);
    await page.click('portfolio-run', true);
  }
  await page.runner(caliburRunner('authorizing', 'setting-up', otherWallet));
  assert.equal(page.byId('portfolio-run').textContent, 'Unavailable');
  await page.click('portfolio-run', true);
  assert.equal(page.posts().length, 0); assert.equal(page.uuidCalls, 0);
});

test('one Start can enter setup, advance stage and become running without another POST', async () => {
  let stage = 'authorizing', state = 'setting-up';
  const page = await browser({ reply: async call => call.method === 'POST'
    ? ok({ ...caliburRunner(stage, state), requestId, outcome: 'setting-up' }) : ok(caliburRunner(stage, state)) });
  await page.ready(); await page.status({ ...chart(), mode: 'ledger' }); await page.runner(caliburRunner());
  await page.click('portfolio-run');
  assert.equal(page.byId('portfolio-run').textContent, 'Authorize Calibur…');
  assert.equal(page.byId('control-message').hidden, true);
  assert.deepEqual(page.posts().map(call => ({ url: call.url, body: call.body })), [
    { url: '/api/runner', body: { token, wallet, action: 'start', requestId } },
  ]);
  stage = 'signing'; await page.timersRun();
  assert.equal(page.byId('portfolio-run').textContent, 'Confirm setup…');
  stage = 'confirming'; await page.runner(caliburRunner(stage, state)); await page.timersRun();
  assert.equal(page.byId('portfolio-run').textContent, 'Waiting for setup receipt…');
  stage = 'ready'; state = 'running'; await page.timersRun();
  assert.equal(page.byId('portfolio-run').textContent, 'Stop'); assert.equal(page.byId('portfolio-run').disabled, false);
  assert.equal(page.byId('portfolio-run').attrs['aria-busy'], 'false');
  await page.timersRun(); assert.equal(page.timers.size, 0);
  assert.equal(page.posts().length, 1); assert.equal(page.uuidCalls, 1);
});

test('setup refresh lasts beyond ordinary transitions but stops at five minutes across stage changes', async () => {
  let stage = 'authorizing';
  const page = await browser({ reply: async () => ok(caliburRunner(stage, 'setting-up')) });
  await page.ready(); await page.status({ ...chart(), mode: 'ledger' }); await page.runner(caliburRunner(stage, 'setting-up'));
  for (let i = 0; i < 31; i++) await page.timersRun();
  assert.equal(page.byId('portfolio-run').textContent, 'Authorize Calibur…');
  assert.equal(page.calls.length, 31, 'setup is not exhausted by the ordinary 30-read budget');
  page.advance(299_000); stage = 'signing'; await page.runner(caliburRunner(stage, 'setting-up')); await page.timersRun();
  assert.equal(page.byId('portfolio-run').textContent, 'Confirm setup…');
  const reads = page.calls.length;
  page.advance(1000); stage = 'confirming'; await page.timersRun();
  assert.equal(page.calls.length, reads, 'no read starts after the five-minute deadline');
  assert.equal(page.byId('portfolio-run').textContent, 'Unavailable'); assert.equal(page.byId('portfolio-run').disabled, true);
  assert.match(page.byId('portfolio-run').title, /may still finish; refresh the page/);
  await page.timersRun(); assert.equal(page.timers.size, 0); assert.equal(page.posts().length, 0);
});

test('setup also has a finite read count and never extends ordinary Start or Stop transitions', async () => {
  for (const state of ['setting-up', 'starting', 'stopping']) {
    const page = await browser({ reply: async () => ok(caliburRunner('confirming', state)) });
    await page.ready(); await page.status({ ...chart(), mode: 'ledger' }); await page.runner(caliburRunner('confirming', state));
    for (let i = 0; i < 305; i++) await page.timersRun();
    assert.equal(page.calls.length, state === 'setting-up' ? 300 : 30);
    assert.equal(page.byId('portfolio-run').textContent, 'Unavailable');
    assert.equal(page.timers.size, 0); assert.equal(page.posts().length, 0);
  }
});

test('setup status does not loosen control uncertainty, stale response or selection barriers', async () => {
  const post = deferred<Reply>(), read = deferred<Reply>();
  const page = await browser({ reply: async call => call.method === 'POST' ? post.promise : read.promise });
  await page.ready(); await page.status({ ...chart(), mode: 'ledger' }); await page.click('portfolio-run');
  await page.runner(caliburRunner('authorizing', 'setting-up'));
  assert.equal(page.byId('portfolio-run').textContent, 'Authorize Calibur…', 'a fresh setup event can be displayed during a pending POST');
  await page.timersRun(); // Existing HTTP deadline still applies; do not resend.
  assert.match(page.byId('control-message').textContent, /outcome is unknown/);
  await page.runner(caliburRunner('signing', 'setting-up'));
  read.resolve(ok(caliburRunner('authorizing', 'setting-up'))); await flush();
  assert.equal(page.byId('portfolio-run').textContent, 'Confirm setup…', 'the older read cannot rewind the device stage');
  post.resolve(ok({ ...caliburRunner('authorizing', 'setting-up'), requestId, outcome: 'setting-up' })); await flush();
  assert.equal(page.byId('portfolio-run').textContent, 'Confirm setup…');
  assert.match(page.byId('control-message').textContent, /outcome is unknown/);
  await page.view({ snapshot: { connectedWallet: otherWallet } }); await page.timersRun();
  await page.click('portfolio-run', true);
  assert.equal(page.byId('portfolio-run').disabled, true);
  assert.equal(page.timers.size, 0); assert.equal(page.posts().length, 1); assert.equal(page.uuidCalls, 1);
});


const setupRejected = (address = wallet) => ({ ...caliburRunner('needed', 'stopped', address),
  message: 'Calibur setup was cancelled on the Ledger. Press Start when ready to try again.' });

test('an accepted Start surfaces a later setup rejection from GET or SSE without another control request', async () => {
  for (const delivery of ['GET', 'SSE']) {
    let rejected = false;
    const page = await browser({ reply: async call => call.method === 'POST'
      ? ok({ ...caliburRunner('authorizing', 'setting-up'), requestId: call.body!.requestId, outcome: 'starting' })
      : ok(rejected ? setupRejected() : caliburRunner('authorizing', 'setting-up')) });
    await page.ready(); await page.status({ ...chart(), mode: 'ledger' }); await page.click('portfolio-run');
    assert.equal(page.byId('control-message').hidden, true);
    rejected = true;
    if (delivery === 'GET') await page.timersRun();
    else await page.runner(setupRejected());
    assert.equal(page.byId('control-message').textContent, setupRejected().message, delivery);
    assert.equal(page.byId('control-message').hidden, false);
    assert.equal(page.byId('portfolio-run').textContent, 'Start');
    assert.equal(page.byId('portfolio-run').disabled, false);
    await page.timersRun();
    assert.equal(page.posts().length, 1); assert.equal(page.uuidCalls, 1);
    assert.equal(page.timers.size, 0);
    rejected = false; await page.click('portfolio-run');
    assert.equal(page.byId('control-message').hidden, true, 'an explicit new attempt clears the older failure');
    assert.equal(page.posts().length, 2); assert.equal(page.uuidCalls, 2);
  }
});

test('a fresh page shows a stopped setup failure only for the fresh displayed Ledger wallet', async () => {
  const page = await browser();
  await page.runner(setupRejected());
  assert.equal(page.byId('control-message').hidden, true, 'runner identity alone does not select a wallet');
  await page.status({ ...chart(otherWallet), mode: 'ledger' });
  assert.equal(page.byId('control-message').hidden, true, 'a different chart wallet cannot inherit the failure');
  await page.status({ ...chart(), mode: 'ledger' });
  assert.equal(page.byId('control-message').textContent, setupRejected().message);
  assert.equal(page.byId('control-message').hidden, false);
  await page.status({ ...chart(otherWallet), mode: 'ledger' });
  assert.equal(page.byId('control-message').hidden, true, 'switching the chart removes the old wallet failure');
  await page.status({ ...chart(), mode: 'ledger' }, true);
  assert.equal(page.byId('control-message').hidden, true, 'disconnected status cannot present a fresh failure');
  await page.status({ ...chart(), mode: 'raw-key' });
  assert.equal(page.byId('control-message').hidden, true);
  await page.status({ ...chart(), mode: 'ledger' });
  await page.runner({ ...setupRejected(), message: 'x'.repeat(500) });
  assert.equal(page.byId('control-message').textContent.length, 400);
  await page.runner(caliburRunner('ready', 'running'));
  assert.equal(page.byId('control-message').hidden, true, 'a current running update clears the stopped failure');
  assert.equal(page.posts().length, 0);
});

test('setup failure summaries cannot overwrite unknown control outcomes from timeouts or uncertain replies', async () => {
  for (const outcome of ['timeout', 'uncertain']) {
    const page = await browser({ reply: async call => call.method === 'GET' ? ok(setupRejected())
      : outcome === 'timeout' ? new Promise<Reply>(() => {})
      : ok({ ...setupRejected(), requestId: call.body!.requestId, outcome: 'uncertain', message: 'The control outcome is unknown.' }) });
    await page.ready(); await page.status({ ...chart(), mode: 'ledger' }); await page.click('portfolio-run');
    if (outcome === 'timeout') await page.timersRun();
    assert.match(page.byId('control-message').textContent, /outcome is unknown/);
    await page.runner(setupRejected());
    assert.match(page.byId('control-message').textContent, /outcome is unknown/, 'an uncorrelated SSE is not receipt for the request');
    assert.doesNotMatch(page.byId('control-message').textContent, /cancelled on the Ledger/);
    await page.timersRun(); assert.equal(page.posts().length, 1);
  }
});

test('an older setup failure read cannot overwrite a newer streamed setup stage', async () => {
  const read = deferred<Reply>();
  const page = await browser({ reply: async () => read.promise });
  await page.ready(); await page.status({ ...chart(), mode: 'ledger' });
  await page.runner(caliburRunner('authorizing', 'setting-up')); await page.timersRun();
  await page.runner(caliburRunner('signing', 'setting-up'));
  read.resolve(ok(setupRejected())); await flush();
  assert.equal(page.byId('portfolio-run').textContent, 'Confirm setup…');
  assert.equal(page.byId('control-message').hidden, true);
  await page.runner(setupRejected(otherWallet));
  assert.equal(page.byId('control-message').hidden, true);
  assert.equal(page.byId('portfolio-run').textContent, 'Unavailable');
  assert.equal(page.posts().length, 0);
});
