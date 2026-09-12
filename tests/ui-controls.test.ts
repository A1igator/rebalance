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
async function browser(options: { token?: string | null; reply?: (call: Call) => Promise<Reply | undefined> } = {}) {
  const nodes = new Map<string, Node>(), events = new Map<string, (() => void)[]>(), subscribers = new Set<(value: unknown) => void>();
  const timers = new Map<number, () => void>(), calls: Call[] = [];
  const html = await readFile(new URL('../ui/index.html', import.meta.url), 'utf8');
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map(match => match[1]));
  let uuidCalls = 0, timerId = 0;
  const byId = (id: string) => {
    assert.ok(ids.has(id), `Control references missing markup: ${id}`);
    if (!nodes.has(id)) { const node = new Node(); node.hidden = id === 'control-message'; nodes.set(id, node); }
    return nodes.get(id)!;
  };
  const window: { rebalanceControls?: Controls; rebalanceView: { token: string | null; subscribe: (callback: (value: unknown) => void) => () => void }; addEventListener: (name: string, handler: () => void) => void } = {
    rebalanceView: { token: options.token === undefined ? token : options.token,
      subscribe: callback => { subscribers.add(callback); return () => subscribers.delete(callback); } },
    addEventListener: (name, handler) => events.set(name, [...events.get(name) || [], handler]),
  };
  runInNewContext(await readFile(new URL('../ui/portfolio-controls.js', import.meta.url), 'utf8'), {
    window, document: { getElementById: byId }, AbortController, URL,
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
  return { byId, calls, timers, get uuidCalls() { return uuidCalls; },
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
  assert.match(page.byId('portfolio-run').title, /Start this Ledger wallet/);
  assert.match(page.byId('portfolio-run').title, /backend opens device prompts automatically; physically confirm each transaction/);
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
