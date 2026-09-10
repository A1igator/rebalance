import assert from 'node:assert/strict';
import { test } from 'node:test';
import { alchemyRpc, PaymasterRpcError } from '../src/paymaster-rpc.js';

const fixtureKey = 'fixture_only_alchemy_key_12345';
const result = (id: number, value: unknown = { prepared: true }) => new Response(JSON.stringify({ jsonrpc: '2.0', id, result: value }));
const fakeFetch = (handler: (url: string, init: RequestInit) => Response | Promise<Response>): typeof fetch =>
  ((url: string | URL | Request, init?: RequestInit) => handler(String(url), init!)) as typeof fetch;
const rejected = (submission = false) => (error: unknown) => {
  assert.ok(error instanceof Error);
  assert.match(error.message, submission ? /outcome is unknown.*without resubmitting/ : /request is unavailable or was rejected/);
  assert.doesNotMatch(error.message, /fixture_only|https?:|provider secret|private-response/);
  assert.equal(error.cause, undefined);
  return true;
};

test('prepared clients cache the credential and initiate submission synchronously before returning its promise', async () => {
  let keys = 0;
  const calls: { url: string; init: RequestInit; payload: Record<string, unknown> }[] = [];
  let finishSend!: (response: Response) => void;
  const client = alchemyRpc({ key: async () => { keys++; return fixtureKey; }, fetch: fakeFetch((url, init) => {
    const payload = JSON.parse(init.body as string); calls.push({ url, init, payload });
    return payload.method === 'wallet_sendPreparedCalls' ? new Promise<Response>(resolve => { finishSend = resolve; }) : result(payload.id);
  }) });
  await client('wallet_prepareCalls', [{ chainId: '0x1237' }]);
  const sent = client('wallet_sendPreparedCalls', [{ signature: 'public-fixture' }]);
  assert.equal(calls.length, 2, 'fetch must begin while the caller still owns its short config lock');
  assert.equal(keys, 1);
  assert.equal(calls[1]!.url, `https://api.g.alchemy.com/v2/${fixtureKey}`);
  assert.deepEqual(calls[1]!.payload, { jsonrpc: '2.0', id: 2, method: 'wallet_sendPreparedCalls', params: [{ signature: 'public-fixture' }] });
  const options = calls[1]!.init;
  assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
  assert.equal(options.credentials, 'omit'); assert.equal(options.cache, 'no-store');
  assert.deepEqual(options.headers, { 'content-type': 'application/json', accept: 'application/json' });
  finishSend(result(2, { accepted: true }));
  assert.deepEqual(await sent, { accepted: true });
  assert.equal(options.signal?.aborted, true);
  await client('eth_getUserOperationReceipt', ['0x1234'], 'bundler');
  assert.equal(calls[2]!.url, `https://robinhood-mainnet.g.alchemy.com/v2/${fixtureKey}`);
  assert.equal(keys, 1);
});

test('concurrent initial reads share one credential load and retain distinct JSON-RPC ids', async () => {
  let keys = 0; let unlock!: (key: string) => void;
  const ids: number[] = [];
  const client = alchemyRpc({ key: () => { keys++; return new Promise(resolve => { unlock = resolve; }); }, fetch: fakeFetch((_url, init) => {
    const { id } = JSON.parse(init.body as string); ids.push(id); return result(id);
  }) });
  const one = client('wallet_prepareCalls', []), two = client('wallet_getCallsStatus', []);
  await Promise.resolve(); assert.equal(keys, 1); assert.deepEqual(ids, []);
  unlock(fixtureKey); await Promise.all([one, two]);
  assert.deepEqual(ids, [1, 2]);
});

test('unsupported methods, routes and malformed params never load credentials or call fetch', async () => {
  let calls = 0;
  const client = alchemyRpc({ key: async () => { calls++; return fixtureKey; }, fetch: fakeFetch(() => { calls++; return result(1); }) });
  for (const [method, params, route] of [['eth_sendRawTransaction', [], 'bundler'], ['wallet_prepareCalls', {}, 'wallet'], ['wallet_prepareCalls', [], 'https://evil.invalid']] as const) {
    await assert.rejects(client(method, params as unknown as unknown[], route as 'wallet'), /Unsupported paymaster request/);
  }
  assert.equal(calls, 0);
  for (const timeoutMs of [0, -1, 1.5, NaN, Infinity, 30001]) assert.throws(() => alchemyRpc({ timeoutMs }), /Invalid paymaster request timeout/);
});

test('credential failures and invalid credentials have fixed diagnostics and cannot reach the provider', async () => {
  for (const key of [async () => { throw new Error(`provider secret https://fixture.invalid/${fixtureKey}`); }, async () => `bad/${fixtureKey}`]) {
    let requests = 0;
    const client = alchemyRpc({ key, fetch: fakeFetch(() => { requests++; return result(1); }) });
    await assert.rejects(client('wallet_prepareCalls', []), rejected());
    await assert.rejects(client('wallet_sendPreparedCalls', []), rejected(true));
    assert.equal(requests, 0);
  }
});

for (const phase of ['prepare', 'send'] as const) {
  test(`${phase} failures never retry or reveal private provider diagnostics`, async () => {
    const method = phase === 'send' ? 'wallet_sendPreparedCalls' : 'wallet_prepareCalls';
    const cases = [
      () => { throw new Error(`https://api.g.alchemy.com/v2/${fixtureKey}: provider secret`); },
      () => Promise.reject(new Error('private-response')),
      () => new Response('private-response', { status: 500 }),
      () => new Response(null, { status: 204 }),
      () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { data: 'provider secret' } })),
      () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: null, result: {} })),
      () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 2, result: {} })),
      () => new Response(JSON.stringify({ jsonrpc: '1.0', id: 1, result: {} })),
      () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1 })),
      () => new Response('private-response'),
      () => new Response('null'),
      () => new Response('[]'),
      () => new Response(new Uint8Array([0xff, 0xfe])),
    ];
    for (const response of cases) {
      let attempts = 0;
      const client = alchemyRpc({ key: async () => fixtureKey, fetch: fakeFetch(() => { attempts++; return response(); }) });
      await assert.rejects(client(method, []), rejected(phase === 'send'));
      assert.equal(attempts, 1);
    }
  });
}

test('null bundler result remains a normal retention miss', async () => {
  const client = alchemyRpc({ key: async () => fixtureKey, fetch: fakeFetch(() => result(1, null)) });
  assert.equal(await client('eth_getUserOperationReceipt', ['public-hash'], 'bundler'), null);
});

test('response bounds cover oversized headers and streamed bodies independently', async () => {
  for (const makeResponse of [
    () => new Response('{}', { headers: { 'content-length': '262145' } }),
    () => new Response('{}', { headers: { 'content-length': 'invalid' } }),
    () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array(131072)); controller.enqueue(new Uint8Array(131073)); controller.close();
    } }), { headers: { 'content-length': '2' } }),
  ]) {
    let calls = 0;
    const client = alchemyRpc({ key: async () => fixtureKey, fetch: fakeFetch(() => { calls++; return makeResponse(); }) });
    await assert.rejects(client('wallet_prepareCalls', []), rejected()); assert.equal(calls, 1);
  }
  const prefix = JSON.stringify({ jsonrpc: '2.0', id: 1, result: '' });
  const value = 'a'.repeat(262144 - prefix.length);
  const client = alchemyRpc({ key: async () => fixtureKey, fetch: fakeFetch(() => result(1, value)) });
  assert.equal(await client('wallet_prepareCalls', []), value, 'exact response limit remains usable');
});

test('oversized and non-serializable request bodies fail before fetch', async () => {
  let calls = 0;
  const client = alchemyRpc({ key: async () => fixtureKey, fetch: fakeFetch(() => { calls++; return result(1); }) });
  const circular: unknown[] = []; circular.push(circular);
  for (const params of [['a'.repeat(262144)], circular, [1n]]) await assert.rejects(client('wallet_prepareCalls', params), rejected());
  assert.equal(calls, 0);
});

test('credential, ignored-abort transport and stalled body each obey the timeout without retries', async () => {
  let calls = 0;
  const missingKey = alchemyRpc({ timeoutMs: 15, key: () => new Promise(() => {}), fetch: fakeFetch(() => { calls++; return result(1); }) });
  await assert.rejects(missingKey('wallet_prepareCalls', []), rejected()); assert.equal(calls, 0);
  let signal: AbortSignal | null | undefined;
  const hungFetch = alchemyRpc({ timeoutMs: 15, key: async () => fixtureKey, fetch: fakeFetch((_url, init) => {
    calls++; signal = init.signal; return new Promise(() => {});
  }) });
  await assert.rejects(hungFetch('wallet_sendPreparedCalls', []), rejected(true));
  assert.equal(calls, 1); assert.equal(signal?.aborted, true);
  let cancelled = 0;
  const stalledBody = alchemyRpc({ timeoutMs: 15, key: async () => fixtureKey, fetch: fakeFetch(() => {
    calls++; return new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled++; return new Promise(() => {}); } }));
  }) });
  await assert.rejects(stalledBody('wallet_prepareCalls', []), rejected());
  assert.equal(calls, 2); assert.equal(cancelled, 1);
});


test('temporary outages are classified for local retry while invalid setup and malformed evidence need attention', async () => {
  const cases: { response: () => Response | Promise<Response>; retryable: boolean }[] = [
    { response: () => Promise.reject(new Error('private-response')), retryable: true },
    { response: () => new Response('private-response', { status: 408 }), retryable: true },
    { response: () => new Response('private-response', { status: 429 }), retryable: true },
    { response: () => new Response('private-response', { status: 500 }), retryable: true },
    { response: () => new Response('private-response', { status: 503 }), retryable: true },
    { response: () => new Response('private-response', { status: 401 }), retryable: false },
    { response: () => new Response('private-response', { status: 403 }), retryable: false },
    { response: () => new Response('private-response', { status: 400 }), retryable: false },
    { response: () => new Response('malformed'), retryable: false },
    { response: () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: 'private-response' } })), retryable: false },
    { response: () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('private-response')); } })), retryable: true },
  ];
  for (const { response, retryable } of cases) {
    const client = alchemyRpc({ key: async () => fixtureKey, fetch: fakeFetch(response) });
    await assert.rejects(client('wallet_prepareCalls', []), error => {
      assert.ok(error instanceof PaymasterRpcError); assert.equal(error.retryable, retryable);
      return rejected()(error);
    });
  }
  const noCredentials = alchemyRpc({ key: async () => { throw new Error('provider secret'); } });
  await assert.rejects(noCredentials('wallet_prepareCalls', []), error => {
    assert.ok(error instanceof PaymasterRpcError); assert.equal(error.retryable, false); return rejected()(error);
  });
  const timeout = alchemyRpc({ timeoutMs: 10, key: async () => fixtureKey, fetch: fakeFetch(() => new Promise(() => {})) });
  await assert.rejects(timeout('wallet_prepareCalls', []), error => {
    assert.ok(error instanceof PaymasterRpcError); assert.equal(error.retryable, true); return rejected()(error);
  });
});


test('only valid numeric JSON-RPC transient codes allow local retry without interpreting provider text', async () => {
  const cases: { error: unknown; retryable: boolean; id?: number; result?: unknown }[] = [
    ...[-32603, -32005, 429].map(code => ({ error: { code, message: 'private-response' }, retryable: true })),
    ...[-32602, -32000, 401, 403].map(code => ({ error: { code, message: 'timeout rate limit 429' }, retryable: false })),
    { error: { code: '429', message: 'private-response' }, retryable: false },
    { error: { code: 429 }, retryable: false },
    { error: { code: -32005, message: {} }, retryable: false },
    { error: { code: -32603, message: 'private-response' }, retryable: false, id: 2 },
    { error: { code: -32603, message: 'private-response' }, retryable: false, result: {} },
    { error: null, retryable: false },
  ];
  for (const entry of cases) {
    let attempts = 0;
    const client = alchemyRpc({ key: async () => fixtureKey, fetch: fakeFetch(() => {
      attempts++;
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: entry.id ?? 1, error: entry.error,
        ...(Object.hasOwn(entry, 'result') ? { result: entry.result } : {}) }));
    }) });
    await assert.rejects(client('wallet_prepareCalls', []), error => {
      assert.ok(error instanceof PaymasterRpcError); assert.equal(error.retryable, entry.retryable);
      return rejected()(error);
    });
    assert.equal(attempts, 1);
  }
});
