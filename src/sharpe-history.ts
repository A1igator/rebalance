import { createHash } from 'node:crypto';
import { ASSETS } from './assets.js';
import { validateReturnHistory, type ReturnHistory } from './allocation-metrics.js';

export type SharpeHistoryProvenance = {
  preset: 'stock-usdg-1y';
  fetchedAt: string;
  firstCloseDate: string;
  firstReturnDate: string;
  lastReturnDate: string;
  observationCount: number;
  historySha256: string;
  sources: { stocks: Record<string, string>; usdg: string };
  stockPriceBasis: 'Yahoo split/dividend-adjusted underlying share close';
  cashPriceBasis: 'Kraken USDG/USD daily close';
  dateAlignment: 'Common equity calendar dates; US equity and UTC USDG closes differ; no filling or interpolation';
};

const DAY = 86_400_000;
const TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
// Coverage heuristic for this one-year daily preset, not a holiday-calendar proof.
const MIN_ANNUAL_CLOSES = 200;
const USDG_URL = 'https://api.kraken.com/0/public/OHLC?pair=USDGUSD&interval=1440';
const STOCK_BASIS = 'Yahoo split/dividend-adjusted underlying share close' as const;
const CASH_BASIS = 'Kraken USDG/USD daily close' as const;
const ALIGNMENT = 'Common equity calendar dates; US equity and UTC USDG closes differ; no filling or interpolation' as const;
const dateOnly = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export type SharpeHistoryFailure =
  | { code: 'network-access-denied' | 'network-unavailable' | 'timeout' | 'invalid-history' }
  | { code: 'provider-http'; provider: 'yahoo' | 'kraken'; status: number };

/** Only these structured fields cross the CLI boundary; raw causes stay local. */
export class SharpeHistoryError extends Error {
  readonly failure: Readonly<SharpeHistoryFailure>;
  constructor(failure: SharpeHistoryFailure, detail?: string) {
    super(detail === undefined ? sharpeHistoryFailureMessage(failure)
      : `Sharpe history unavailable: ${detail}. No allocation was changed.`);
    this.name = 'SharpeHistoryError';
    this.failure = Object.freeze({ ...failure });
  }
}
export function getSharpeHistoryFailure(error: unknown): SharpeHistoryFailure {
  if (error instanceof SharpeHistoryError) {
    const value = error.failure;
    if (value.code === 'provider-http' && ['yahoo', 'kraken'].includes(value.provider) &&
        Number.isInteger(value.status) && value.status >= 100 && value.status <= 599) {
      return { code: 'provider-http', provider: value.provider, status: value.status };
    }
    if (value.code === 'network-access-denied' || value.code === 'network-unavailable' ||
        value.code === 'timeout' || value.code === 'invalid-history') return { code: value.code };
  }
  return { code: 'invalid-history' };
}
export function sharpeHistoryFailureMessage(value: SharpeHistoryFailure): string {
  const unchanged = 'No policy or targets were saved.';
  switch (value.code) {
    case 'network-access-denied': return `Local network permissions denied the history request. ${unchanged}`;
    case 'network-unavailable': return `The history providers could not be reached. Check this environment's network access. ${unchanged}`;
    case 'timeout': return `The history request timed out. ${unchanged}`;
    case 'provider-http': return `${value.provider === 'yahoo' ? 'Yahoo Finance' : 'Kraken'} returned HTTP ${value.status}. ${unchanged}`;
    case 'invalid-history': return `The requested history was incomplete or invalid. ${unchanged}`;
  }
}
const failure = (reason: string) => new SharpeHistoryError({ code: 'invalid-history' }, reason);

// Node fetch nests OS errors in cause (and sometimes AggregateError.errors).
// Bound traversal, avoid getters/cycles, and never infer permission denial from
// message text, a provider HTTP status, or an arbitrary remote response field.
function networkFailure(error: unknown): SharpeHistoryFailure {
  const queue: unknown[] = [error];
  const seen = new Set<object>();
  for (let visited = 0; queue.length && visited < 16; visited++) {
    const item = queue.shift();
    if (!item || typeof item !== 'object' || seen.has(item)) continue;
    seen.add(item);
    const own = (key: string): unknown => {
      try { return Object.getOwnPropertyDescriptor(item, key)?.value; } catch { return undefined; }
    };
    if (own('code') === 'EPERM' || own('code') === 'EACCES') return { code: 'network-access-denied' };
    queue.push(own('cause'));
    const errors = own('errors');
    if (Array.isArray(errors)) queue.push(...errors.slice(0, 16));
  }
  return { code: 'network-unavailable' };
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
const seconds = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const nyDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });

function equityDate(timestamp: number): string {
  const parts = nyDate.formatToParts(new Date(timestamp * 1000));
  return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)!.value).join('-');
}

async function boundedJson(response: Response, url: string, provider: 'yahoo' | 'kraken', signal: AbortSignal): Promise<unknown> {
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new SharpeHistoryError(response.status >= 100 && response.status <= 599
      ? { code: 'provider-http', provider, status: response.status } : { code: 'network-unavailable' });
  }
  if (!response.body || response.redirected || (response.url && response.url !== url) ||
      !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') || signal.aborted) {
    void response.body?.cancel().catch(() => {});
    throw failure('a provider did not return the expected JSON response');
  }
  const declaredSize = response.headers.get('content-length');
  if (declaredSize !== null && (!/^\d+$/.test(declaredSize) || Number(declaredSize) > MAX_RESPONSE_BYTES)) {
    void response.body.cancel().catch(() => {});
    throw failure('a provider response exceeded the size limit');
  }
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw failure('a provider response exceeded the size limit');
      chunks.push(value);
    }
    signal.throwIfAborted();
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw failure('a provider returned malformed JSON'); }
  } catch (error) {
    if (error instanceof SharpeHistoryError) throw error;
    throw new SharpeHistoryError(networkFailure(error));
  } finally { signal.removeEventListener('abort', cancel); cancel(); }
}

type Closes = Map<string, number>;
function yahooCloses(value: unknown, symbol: string, firstDay: string, today: string, nowMs: number): Closes {
  const bad = () => failure(`${symbol} adjusted share data is missing or malformed`);
  if (!record(value) || !record(value.chart) || value.chart.error !== null ||
      !Array.isArray(value.chart.result) || value.chart.result.length !== 1) throw bad();
  const result = value.chart.result[0];
  if (!record(result) || !record(result.meta) || result.meta.symbol !== symbol || result.meta.currency !== 'USD' ||
      result.meta.instrumentType !== 'EQUITY' || result.meta.exchangeTimezoneName !== 'America/New_York' ||
      result.meta.dataGranularity !== '1d' || result.meta.range !== '1y' || !Array.isArray(result.timestamp) ||
      result.timestamp.length < 21 || result.timestamp.length > 2001 || !record(result.indicators) ||
      !Array.isArray(result.indicators.adjclose) || result.indicators.adjclose.length !== 1 ||
      !record(result.indicators.adjclose[0]) || !Array.isArray(result.indicators.adjclose[0].adjclose) ||
      !Array.isArray(result.indicators.quote) || result.indicators.quote.length !== 1 ||
      !record(result.indicators.quote[0]) || !Array.isArray(result.indicators.quote[0].close)) throw bad();
  const adjusted: unknown[] = result.indicators.adjclose[0].adjclose;
  const unadjusted: unknown[] = result.indicators.quote[0].close;
  if (adjusted.length !== result.timestamp.length || unadjusted.length !== result.timestamp.length) throw bad();
  const closes: Closes = new Map();
  let previous = 0;
  const seenDates = new Set<string>();
  for (let i = 0; i < result.timestamp.length; i++) {
    const timestamp: unknown = result.timestamp[i];
    if (!seconds(timestamp) || timestamp <= previous || timestamp * 1000 > nowMs) throw bad();
    previous = timestamp;
    const date = equityDate(timestamp);
    if (seenDates.has(date)) throw bad();
    seenDates.add(date);
    // A daily chart timestamp is not proof that its daily bar has closed. Use
    // only earlier UTC dates, matching the complete cash-candle boundary.
    if (date >= today || date < firstDay) continue;
    if (!positive(adjusted[i]) || !positive(unadjusted[i])) throw bad();
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    if (weekday === 0 || weekday === 6) throw bad();
    closes.set(date, adjusted[i] as number);
  }
  return closes;
}

function decimal(value: unknown, allowZero = false): number {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value)) throw failure('USDG prices are malformed');
  const number = Number(value);
  if (!Number.isFinite(number) || (allowZero ? number < 0 : number <= 0)) throw failure('USDG prices are malformed');
  return number;
}

/** Kraken documents its last OHLC row as uncommitted, regardless of since.
 * https://docs.kraken.com/api-reference/market-data/get-ohlc-data */
function krakenCloses(value: unknown, firstDay: string, today: string, nowMs: number): Closes {
  const bad = () => failure('USDG/USD daily data is missing, stale or malformed');
  if (!record(value) || !Array.isArray(value.error) || value.error.length !== 0 || !record(value.result) ||
      Object.keys(value.result).length !== 2 || !seconds(value.result.last) || value.result.last * 1000 > nowMs ||
      !Array.isArray(value.result.USDGUSD) || value.result.USDGUSD.length < 22 || value.result.USDGUSD.length > 720) throw bad();
  const rows: unknown[] = value.result.USDGUSD;
  const closes: Closes = new Map();
  let previous = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!Array.isArray(row) || row.length !== 8 || !seconds(row[0]) || row[0] % 86_400 !== 0 ||
        row[0] * 1000 > nowMs || (previous !== 0 && row[0] - previous !== 86_400) ||
        !Number.isSafeInteger(row[7]) || row[7] < 0) throw bad();
    previous = row[0];
    const date = dateOnly(row[0] * 1000);
    // Reject malformed values even on an excluded incomplete candle. No cash
    // price is inferred from a peg or filled from the preceding observation.
    const [open, high, low, close] = row.slice(1, 5).map(item => decimal(item));
    decimal(row[5], true); decimal(row[6], true);
    if (low > Math.min(open, close) || high < Math.max(open, close) || high < low) throw bad();
    if (i === rows.length - 1) {
      if (date !== today) throw bad();
      continue;
    }
    if (date >= today) throw bad();
    if (date >= firstDay) closes.set(date, close);
  }
  return closes;
}

/** One explicit, read-only fetch of the labelled stock/USDG proxy preset.
 * Yahoo's adjusted-close definition: https://help.yahoo.com/kb/SLN28256.html
 * The chart endpoint is provider-controlled, not a stable published API contract.
 * Bounds detect incomplete coverage, not every missing exchange holiday/session.
 */
export async function fetchSharpeHistory(assetIds: readonly string[], options: {
  now?: Date; fetch?: typeof globalThis.fetch;
} = {}): Promise<{ history: ReturnHistory; provenance: SharpeHistoryProvenance }> {
  if (!Array.isArray(assetIds) || assetIds.length !== 5 || new Set(assetIds).size !== 5 || !assetIds.includes('USDG') ||
      assetIds.some(id => typeof id !== 'string' || !Object.hasOwn(ASSETS, id))) {
    throw failure('this preset requires USDG and four configured manifest stocks');
  }
  const nowMs = (options.now ?? new Date()).getTime();
  if (!Number.isSafeInteger(nowMs) || nowMs < Date.UTC(2000, 0, 1) || typeof (options.fetch ?? globalThis.fetch) !== 'function') {
    throw failure('the history request is invalid');
  }
  const fetchedAt = new Date(nowMs).toISOString();
  const today = dateOnly(nowMs);
  const start = new Date(`${today}T00:00:00Z`);
  start.setUTCFullYear(start.getUTCFullYear() - 1);
  const firstDay = dateOnly(start.getTime());
  const ids = [...assetIds].sort();
  const stocks = ids.filter(id => id !== 'USDG');
  const sources = { stocks: Object.fromEntries(stocks.map(id => [id,
    `https://query1.finance.yahoo.com/v8/finance/chart/${ASSETS[id as keyof typeof ASSETS].symbol}?range=1y&interval=1d&events=div%2Csplits&includeAdjustedClose=true`])), usdg: USDG_URL };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let responses: unknown[];
  let timedOut = false;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { timedOut = true; controller.abort(); reject(new SharpeHistoryError({ code: 'timeout' })); }, TIMEOUT_MS);
    });
    responses = await Promise.race([Promise.all([...stocks.map(id => sources.stocks[id]), USDG_URL].map(async url => {
      let response: Response;
      try { response = await (options.fetch ?? globalThis.fetch)(url, { method: 'GET', signal: controller.signal,
        redirect: 'error', credentials: 'omit', cache: 'no-store', headers: { accept: 'application/json' } }); }
      catch (error) { throw new SharpeHistoryError(networkFailure(error)); }
      return boundedJson(response, url, url === USDG_URL ? 'kraken' : 'yahoo', controller.signal);
    })), deadline]);
  } catch (error) {
    // Abort can synchronously reject fetch or cancel a reader before the timer's
    // promise wins its race. The local deadline still determines this outcome.
    if (timedOut) throw new SharpeHistoryError({ code: 'timeout' });
    if (error instanceof SharpeHistoryError) throw error;
    throw failure('a provider response could not be validated');
  } finally { if (timer !== undefined) clearTimeout(timer); controller.abort(); }
  const stockCloses = stocks.map((id, index) => yahooCloses(responses[index], id, firstDay, today, nowMs));
  const cash = krakenCloses(responses[stocks.length], firstDay, today, nowMs);
  const dates = [...stockCloses[0].keys()];
  // All selected shares use the same US equity calendar. Silently dropping a
  // missing stock row would turn a multi-session move into a claimed daily one.
  if (stockCloses.some(closes => closes.size !== dates.length || dates.some(date => !closes.has(date)))) {
    throw failure('stock calendars disagree; incomplete sessions cannot be silently dropped');
  }
  if (dates.length < MIN_ANNUAL_CLOSES || dates.length > 2001 || Date.parse(dates[0]) - start.getTime() > 10 * DAY ||
      nowMs - Date.parse(dates.at(-1)!) > 7 * DAY ||
      dates.some((date, i) => (i > 0 && Date.parse(date) - Date.parse(dates[i - 1]) > 7 * DAY))) {
    throw failure('the one-year sample is incomplete, sparse or stale');
  }
  if (dates.some(date => !cash.has(date))) throw failure('USDG prices do not cover every selected equity session');
  const series = Object.fromEntries(ids.map(id => [id, id === 'USDG' ? cash : stockCloses[stocks.indexOf(id)]]));
  const observations = dates.slice(1).map((date, index) => ({ date, returns: Object.fromEntries(ids.map(id =>
    [id, series[id].get(date)! / series[id].get(dates[index])! - 1])) }));
  let history: ReturnHistory;
  try {
    history = validateReturnHistory({ source: `${STOCK_BASIS}: ${Object.values(sources.stocks).join(' ')}; ${CASH_BASIS}: ${USDG_URL}; ${ALIGNMENT}. Frozen one-year test preset; zero return benchmark; no annualization or execution costs.`,
      basis: 'underlying-proxy', quoteCurrency: 'USD', interval: 'daily', asOf: fetchedAt,
      benchmarkPeriodReturn: 0, observations }, ids);
  } catch { throw failure('the aligned return panel failed validation'); }
  return { history, provenance: { preset: 'stock-usdg-1y', fetchedAt, firstCloseDate: dates[0],
    firstReturnDate: observations[0].date, lastReturnDate: observations.at(-1)!.date, observationCount: observations.length,
    historySha256: createHash('sha256').update(JSON.stringify(history)).digest('hex'), sources,
    stockPriceBasis: STOCK_BASIS, cashPriceBasis: CASH_BASIS, dateAlignment: ALIGNMENT } };
}
