import { providerKey } from './paymaster-config.js';

export type PaymasterRpc = (method: string, params: unknown[], route?: 'wallet' | 'bundler') => Promise<unknown>;
const METHODS = new Set(['wallet_prepareCalls', 'wallet_sendPreparedCalls', 'wallet_getCallsStatus', 'eth_getUserOperationReceipt', 'pm_getPaymasterStubData']);
const LIMIT = 262144;
export class PaymasterRpcError extends Error {
  constructor(readonly retryable: boolean, submission = false) {
    super(submission
      ? 'The paymaster submission outcome is unknown; retain its operation hash and reconcile without resubmitting.'
      : 'The paymaster request is unavailable or was rejected. Check the Alchemy app, active USDG policy, billing and token balance.');
    this.name = 'PaymasterRpcError';
  }
}
const validCredential = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{16,256}$/.test(value);
/** Fixed provider hosts, bounded private responses and fixed diagnostics. No SDK telemetry or automatic retries. */
export function alchemyRpc(overrides: { fetch?: typeof fetch; key?: () => Promise<string>; timeoutMs?: number } = {}): PaymasterRpc {
  const request = overrides.fetch ?? globalThis.fetch;
  const key = overrides.key ?? providerKey;
  const timeoutMs = overrides.timeoutMs ?? 15000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error('Invalid paymaster request timeout');
  let id = 0;
  let credential: string | undefined;
  let loading: Promise<string> | undefined;
  return async (method, params, route = 'wallet') => {
    if (!METHODS.has(method) || !Array.isArray(params) || !['wallet', 'bundler'].includes(route)) throw new Error('Unsupported paymaster request');
    const controller = new AbortController();
    let retryable = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Race the whole response, including its body. Abort alone cannot bound a
    // transport or stream that ignores abort; cancellation itself is not awaited.
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { retryable = true; controller.abort(); reject(new Error('Paymaster timeout')); }, timeoutMs);
    });
    const requestId = ++id;
    try {
      if (credential === undefined) {
        loading ??= Promise.resolve().then(key).then(value => {
          if (!validCredential(value)) throw new Error('Invalid credential');
          credential = value; return value;
        }).finally(() => { loading = undefined; });
        await Promise.race([loading, expired]);
      }
      if (controller.signal.aborted) throw new Error();
      const url = `${route === 'wallet' ? 'https://api.g.alchemy.com' : 'https://robinhood-mainnet.g.alchemy.com'}/v2/${credential}`;
      const payload = JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params });
      if (new TextEncoder().encode(payload).byteLength > LIMIT) throw new Error();
      // A warmed client invokes fetch synchronously, before its first await.
      // Dispatch relies on this when releasing config.lock after invocation.
      let response: Response;
      try {
        response = await Promise.race([request(url, { method: 'POST', body: payload,
          headers: { 'content-type': 'application/json', accept: 'application/json' }, signal: controller.signal,
          redirect: 'error', credentials: 'omit', cache: 'no-store' }), expired]);
      } catch { retryable = true; throw new Error(); }
      if (!response.ok) { retryable = response.status === 408 || response.status === 429 || response.status >= 500; throw new Error(); }
      if (!response.body) throw new Error();
      const contentLength = response.headers.get('content-length');
      if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > LIMIT)) throw new Error();
      reader = response.body.getReader();
      const chunks: Uint8Array[] = []; let length = 0;
      for (;;) {
        let next: ReadableStreamReadResult<Uint8Array>;
        try { next = await Promise.race([reader.read(), expired]); }
        catch { retryable = true; throw new Error(); }
        if (next.done) break;
        length += next.value.byteLength;
        if (length > LIMIT) throw new Error();
        chunks.push(next.value);
      }
      const bytes = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const body: unknown = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes));
      if (controller.signal.aborted || !body || typeof body !== 'object' || Array.isArray(body) ||
          !('jsonrpc' in body) || body.jsonrpc !== '2.0' || !('id' in body) || body.id !== requestId) throw new Error();
      if ('error' in body) {
        const error = body.error;
        // Only well-formed numeric protocol codes classify transient failures.
        // Provider message/data text never influences retries or public output.
        retryable = !Object.hasOwn(body, 'result') && !!error && typeof error === 'object' && !Array.isArray(error) &&
          'code' in error && typeof error.code === 'number' && [-32603, -32005, 429].includes(error.code) &&
          'message' in error && typeof error.message === 'string';
        throw new Error();
      }
      if (!('result' in body) || !Object.hasOwn(body, 'result')) throw new Error();
      return body.result;
    } catch {
      throw new PaymasterRpcError(retryable, method === 'wallet_sendPreparedCalls');
    } finally {
      clearTimeout(timer); controller.abort();
      if (reader) void reader.cancel().catch(() => {});
    }
  };
}
