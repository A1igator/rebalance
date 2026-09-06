// Display-only public data. Never used for transaction fees or portfolio valuation.
export type GasDisplay = {
  gasPriceWei: string | null;
  ethUsdE8: string | null;
  gasObservedAt: string | null;
  usdObservedAt: string | null;
};

export const GAS_DISPLAY_CACHE_MS = 30_000;
export const GAS_DISPLAY_TIMEOUT_MS = 4_000;
export const GAS_DISPLAY_RPC = 'https://rpc.mainnet.chain.robinhood.com';
export const ETH_USD_SPOT_URL = 'https://api.coinbase.com/v2/prices/ETH-USD/spot';
const MAX_RESPONSE_BYTES = 16_384;

export type GasDisplayDependencies = {
  fetch: typeof globalThis.fetch;
  now: () => number;
  rpcUrl: string;
  timeoutMs: number;
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid public quote');
  return value as Record<string, unknown>;
}

function quantity(value: unknown): bigint {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/i.test(value)) {
    throw new Error('Invalid RPC quantity');
  }
  return BigInt(value);
}

function dollarPrice(value: unknown): string {
  // Limit input before BigInt conversion; retain exact decimal USD with eight places.
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,11})(?:\.\d{1,8})?$/.test(value)) {
    throw new Error('Invalid ETH/USD price');
  }
  const [whole, fraction = ''] = value.split('.');
  const price = BigInt(whole) * 100_000_000n + BigInt(fraction.padEnd(8, '0'));
  if (price <= 0n) throw new Error('Invalid ETH/USD price');
  return price.toString();
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.ok || !response.body) throw new Error('Public quote unavailable');
  const body = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await body.read();
      if (done) break;
      size += value.length;
      if (size > MAX_RESPONSE_BYTES) throw new Error('Public quote too large');
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally {
    // Also releases oversized or interrupted responses without consuming more data.
    void body.cancel().catch(() => {});
  }
}

export function createGasDisplayReader(overrides: Partial<GasDisplayDependencies> = {}): () => Promise<GasDisplay> {
  const dependencies: GasDisplayDependencies = {
    fetch: globalThis.fetch, now: Date.now, rpcUrl: GAS_DISPLAY_RPC,
    timeoutMs: GAS_DISPLAY_TIMEOUT_MS, ...overrides,
  };
  if (!Number.isFinite(dependencies.timeoutMs) || dependencies.timeoutMs <= 0) {
    throw new Error('Invalid public quote timeout');
  }
  const state: GasDisplay = { gasPriceWei: null, ethUsdE8: null, gasObservedAt: null, usdObservedAt: null };
  let lastAttempt: number | null = null;
  let inFlight: Promise<void> | null = null;

  async function request(url: string, init?: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('Public quote timed out')); }, dependencies.timeoutMs);
    });
    try {
      return await Promise.race([
        dependencies.fetch(url, { ...init, signal: controller.signal, redirect: 'error', credentials: 'omit' }).then(boundedJson),
        timeout,
      ]);
    } finally {
      clearTimeout(timer!);
      controller.abort();
    }
  }

  async function rpc(method: 'eth_chainId' | 'eth_gasPrice', id: number): Promise<bigint> {
    const response = object(await request(dependencies.rpcUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params: [] }),
    }));
    if (response.jsonrpc !== '2.0' || response.id !== id || 'error' in response) throw new Error('Invalid RPC response');
    return quantity(response.result);
  }

  async function refreshGas(): Promise<void> {
    const [chainId, price] = await Promise.all([rpc('eth_chainId', 1), rpc('eth_gasPrice', 2)]);
    if (chainId !== 4663n || price <= 0n) throw new Error('Invalid Robinhood gas quote');
    const observedAt = new Date(dependencies.now()).toISOString();
    state.gasPriceWei = price.toString();
    state.gasObservedAt = observedAt;
  }

  async function refreshUsd(): Promise<void> {
    const response = object(await request(ETH_USD_SPOT_URL));
    const data = object(response.data);
    if (data.base !== 'ETH' || data.currency !== 'USD') throw new Error('Invalid price identity');
    const price = dollarPrice(data.amount);
    const observedAt = new Date(dependencies.now()).toISOString();
    state.ethUsdE8 = price;
    state.usdObservedAt = observedAt;
  }

  return async () => {
    // One refresh for all callers, including failures. Clock rollback expires the cache.
    const now = dependencies.now();
    if (!inFlight && (lastAttempt === null || now < lastAttempt || now - lastAttempt >= GAS_DISPLAY_CACHE_MS)) {
      lastAttempt = now;
      inFlight = Promise.allSettled([refreshGas(), refreshUsd()]).then(() => {}).finally(() => { inFlight = null; });
    }
    await inFlight;
    return { ...state };
  };
}
