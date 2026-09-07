import { createHash } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { watch, type FSWatcher } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { portfolioRoot, connectionPath, resolveProfile } from '../scripts/profile-routing.mjs';
import { portfolios } from './profiles.js';
import { readView, viewState, connectView } from './view-session.js';
import { WalletSetups } from './wallet-setup.js';
import { ensurePortfolioChart } from './view.js';
import { fileURLToPath } from 'node:url';
import { DATA, loadConfig } from './config.js';
import { status, type Status } from './runtime.js';
import { stringifyJson } from './storage.js';
import { createGasDisplayReader, type GasDisplay } from './gas-display.js';
import { GAS_REFERENCE } from './gas-reference.js';
import { projectRebalanceFees } from './fee-projection.js';
import { chartPort } from './chart-address.js';

const assets = {
  '/': ['selector.html', 'text/html; charset=utf-8'],
  '/chart': ['index.html', 'text/html; charset=utf-8'],
  '/selector.js': ['selector.js', 'text/javascript; charset=utf-8'],
  '/selector.css': ['selector.css', 'text/css; charset=utf-8'],
  '/view-client.js': ['view-client.js', 'text/javascript; charset=utf-8'],
  '/allocation-ring.js': ['allocation-ring.js', 'text/javascript; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
} as const;

type ChartDependencies = {
  walletSetups: WalletSetups;
  dataDir: string;
  rootDir: string;
  ensureChart: typeof ensurePortfolioChart;
  readStatus: () => Promise<Status>;
  readGas: () => Promise<GasDisplay>;
  readConfig: typeof loadConfig;
  watchChanges: (directory: string, listener: (event: string, filename: string | null) => void) => FSWatcher;
};
const publicFiles = new Set(['status.json', 'config.json', 'cycle.json', 'wallet.json', 'run.lock', 'stop.json']);

function streamStatus(response: ServerResponse, deps: ChartDependencies): void {
  let watcher: FSWatcher | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let reading = false;
  let writable = true;
  let dirty = true;
  let lastPayload: string | undefined;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    watcher?.close();
    response.off('drain', drain);
    response.off('error', fail);
  };
  const fail = () => { cleanup(); response.destroy(); };
  const schedule = () => {
    if (closed || !dirty || reading || !writable || timer) return;
    timer = setTimeout(() => { timer = undefined; void flush(); }, 20);
  };
  const drain = () => { writable = true; schedule(); };
  const flush = async () => {
    if (closed || reading || !writable || !dirty) return;
    reading = true; dirty = false;
    try {
      const payload = stringifyJson(await deps.readStatus()).trimEnd();
      if (closed) return;
      if (payload !== lastPayload) {
        // SSE permits repeated data lines; preserve bigint-safe public JSON.
        writable = response.write(`event: status\n${payload.split('\n').map(line => `data: ${line}`).join('\n')}\n\n`);
        lastPayload = payload;
      }
    } catch { fail(); }
    finally { reading = false; schedule(); }
  };
  response.once('close', cleanup);
  response.on('error', fail);
  response.on('drain', drain);
  try {
    // Watch the directory so atomic replacement does not orphan an inode watch.
    watcher = deps.watchChanges(deps.dataDir, (_event, filename) => {
      if (filename !== null && !publicFiles.has(filename)) return;
      dirty = true; schedule();
    });
    watcher.on('error', fail);
    watcher.on('close', () => { if (!closed) fail(); });
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' });
    response.flushHeaders();
    writable = response.write('retry: 1000\n\n');
    void flush();
  } catch {
    cleanup();
    if (response.headersSent) response.destroy();
    else response.writeHead(503).end('Status temporarily unavailable');
  }
}

async function streamView(response: ServerResponse, deps: ChartDependencies, token: string) {
  const view = await readView(deps.rootDir, token);
  const directory = resolve(deps.rootDir, 'connections');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (response.destroyed) return;
  const file = basename(connectionPath(deps.rootDir, view.sessionId));
  const watchers: FSWatcher[] = [];
  let closed = false, reading = false, dirty = true, writable = true;
  let last: string | undefined;
  const profileWatchers = new Map<string, FSWatcher>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const close = () => { if (closed) return; closed = true; clearTimeout(timer); for (const w of watchers) w.close(); for (const w of profileWatchers.values()) w.close(); };
  const fail = () => { close(); response.destroy(); };
  const schedule = () => {
    if (closed || reading || !dirty || !writable || timer) return;
    timer = setTimeout(() => { timer = undefined; void flush(); }, 20);
  };
  const watchDirectory = (path: string, names: readonly string[]) => {
    const w = watch(path, (_event, name) => { if (name === null || names.includes(String(name))) { dirty = true; schedule(); } });
    w.on('error', fail); watchers.push(w);
  };
  const flush = async () => {
    if (closed || reading || !dirty || !writable) return;
    reading = true; dirty = false;
    try {
      const [state, entries] = await Promise.all([viewState(deps.rootDir, token), portfolios(deps.rootDir)]);
      const routed = await import('../scripts/profile-routing.mjs').then(module => module.readProfiles(deps.rootDir));
      if (closed) return;
      const directories = new Set(routed.filter(p => p.directory !== '.').map(p => p.dataDir));
      for (const [path, watcher] of profileWatchers) if (!directories.has(path)) { watcher.close(); profileWatchers.delete(path); }
      for (const path of directories) if (!profileWatchers.has(path)) {
        try {
          const w = watch(path, (_event, name) => { if (name === null || ['config.json','run.lock','stop.json','chart.lock'].includes(String(name))) { dirty = true; schedule(); } });
          w.on('error', fail); profileWatchers.set(path, w);
        } catch { /* Unavailable wallets already have their own unavailable card. */ }
      }
      const current = entries.find(p => p.wallet.toLowerCase() === state.connectedWallet?.toLowerCase());
      const payload = JSON.stringify({ ...state, chartUrl: current?.chartUrl ?? null, portfolios: entries });
      if (!closed && payload !== last) { writable = response.write(`event: view\ndata: ${payload}\n\n`); last = payload; }
    } catch { fail(); }
    finally { reading = false; schedule(); }
  };
  response.once('close', close); response.on('error', fail);
  response.on('drain', () => { writable = true; schedule(); });
  try {
    if (response.destroyed) { close(); return; }
    watchDirectory(directory, [file]);
    watchDirectory(deps.rootDir, ['portfolios.json','config.json','run.lock','stop.json','chart.lock']);
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' });
    response.flushHeaders();
    await flush();
  } catch { fail(); }
}

async function streamSetup(response: ServerResponse, deps: ChartDependencies, token: string, requestId: string) {
  // Authorize before watching; install the directory watch before the first snapshot.
  await deps.walletSetups.read(token, requestId);
  let watcher: FSWatcher | undefined, closed = false, reading = false, dirty = true, writable = true;
  let last: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const close = () => { if (closed) return; closed = true; clearTimeout(timer); watcher?.close(); };
  const fail = () => { close(); response.destroy(); };
  const schedule = () => {
    if (closed || reading || !dirty || !writable || timer) return;
    timer = setTimeout(() => { timer = undefined; void flush(); }, 20);
  };
  const flush = async () => {
    if (closed || reading || !dirty || !writable) return;
    reading = true; dirty = false;
    try {
      const result = await deps.walletSetups.read(token, requestId);
      if (closed) return;
      const payload = JSON.stringify(result);
      if (payload !== last) { writable = response.write(`event: setup\ndata: ${payload}\n\n`); last = payload; }
      if (result.state === 'ready' || result.state === 'failed') { close(); response.end(); }
    } catch { fail(); }
    finally { reading = false; schedule(); }
  };
  response.once('close', close); response.on('error', fail);
  response.on('drain', () => { writable = true; schedule(); });
  try {
    watcher = deps.watchChanges(deps.walletSetups.directory, () => { dirty = true; schedule(); });
    watcher.on('error', fail);
    watcher.on('close', () => { if (!closed) fail(); });
    if (response.destroyed) { close(); return; }
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' });
    response.flushHeaders(); await flush();
  } catch { fail(); }
}

export async function serve(port = chartPort(), overrides: Partial<ChartDependencies> = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('Invalid chart port.');
  const rootDir = overrides.rootDir ?? overrides.dataDir ?? portfolioRoot();
  const deps: ChartDependencies = { walletSetups: new WalletSetups(rootDir), dataDir: DATA, rootDir: overrides.dataDir ?? portfolioRoot(), ensureChart: ensurePortfolioChart, readStatus: status, readGas: createGasDisplayReader(), readConfig: loadConfig,
    watchChanges: (directory, listener) => watch(directory, listener), ...overrides };
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'");
    const host = request.headers.host;
    const address = server.address();
    const boundPort = typeof address === 'object' && address ? address.port : port;
    if ((host !== `127.0.0.1:${boundPort}` && host !== `localhost:${boundPort}`) ||
        (request.headers.origin !== undefined && request.headers.origin !== `http://${host}`)) {
      response.writeHead(403).end('Local chart only'); return;
    }
    if (['/api/view', '/api/connect', '/api/setup', '/api/setup/status', '/api/setup/events', '/api/view/events'].includes(request.url ?? '')) {
      if (request.method !== 'POST') { response.writeHead(405, { Allow: 'POST' }).end('Use POST'); return; }
      if (request.headers.origin !== `http://${host}` || request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') {
        response.writeHead(403).end('Same-origin JSON required'); return;
      }
      try {
        let body = '';
        for await (const chunk of request) {
          body += chunk;
          if (Buffer.byteLength(body) > 2048) { response.writeHead(413).end('Request too large'); return; }
        }
        let input: Record<string, unknown>;
        try { input = JSON.parse(body); } catch { response.writeHead(400).end('Invalid JSON'); return; }
        if (!input || typeof input !== 'object' || Array.isArray(input)) { response.writeHead(400).end('Invalid request'); return; }
        const allowed = request.url === '/api/connect' ? ['token','wallet'] : request.url === '/api/setup' ? ['token','mode','requestId'] : request.url?.startsWith('/api/setup/') ? ['token','requestId'] : ['token'];
        if (Object.keys(input).some(key => !allowed.includes(key)) || allowed.some(key => typeof input[key] !== 'string')) {
          response.writeHead(400).end('Invalid request fields'); return;
        }
        try { await readView(deps.rootDir, input.token as string); }
        catch { response.writeHead(403).end('Open this view through the agent to reconnect it.'); return; }
        if (request.url === '/api/view/events') { await streamView(response, deps, input.token as string); return; }
        if (request.url === '/api/setup/events') { await streamSetup(response, deps, input.token as string, input.requestId as string); return; }
        let result: unknown;
        if (request.url === '/api/view') result = await viewState(deps.rootDir, input.token as string);
        else if (request.url === '/api/connect') {
          const profile = await resolveProfile(deps.rootDir, { wallet: input.wallet as string });
          await deps.ensureChart(profile);
          const connected = await connectView(deps.rootDir, input.token as string, input.wallet as string);
          result = { wallet: connected.wallet, chartUrl: connected.chartUrl, tradingChanged: false };
        } else if (request.url === '/api/setup/status') result = await deps.walletSetups.read(input.token as string, input.requestId as string);
        else result = await deps.walletSetups.begin( input.token as string, input.mode as 'private-key' | 'privy' | 'ledger', input.requestId as string);
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(stringifyJson(result));
      } catch { if (!response.headersSent) response.writeHead(503, { 'Content-Type': 'application/json' }).end(stringifyJson({ error: 'The view request could not be verified. Reconnect through the agent before retrying.' })); else response.destroy(); }
      return;
    }
    if (request.url === '/api/status/events') {
      if (request.method !== 'GET') { response.writeHead(405, { Allow: 'GET' }).end('View only'); return; }
      streamStatus(response, deps); return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' }).end('View only'); return;
    }
    try {
      if (request.url === '/api/view/identity') {
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(request.method === 'HEAD' ? undefined : stringifyJson({ app: 'Rebalance', viewVersion: 1, scope: createHash('sha256').update(resolve(deps.dataDir)).digest('hex') })); return;
      }
      if (request.url === '/api/portfolios') {
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(request.method === 'HEAD' ? undefined : stringifyJson({ portfolios: await portfolios(deps.rootDir) })); return;
      }
      if (request.url === '/api/gas') {
        if (request.method === 'HEAD') {
          response.writeHead(200, { 'Content-Type': 'application/json' }).end(); return;
        }
        // Public fixed-price projection only. Unavailable local holdings must not
        // hide independent gas/ETH quotes or turn into a fabricated zero fee.
        const [gas, rebalance] = await Promise.all([
          deps.readGas(),
          Promise.all([deps.readStatus(), deps.readConfig()])
            .then(([snapshot, config]) => projectRebalanceFees(snapshot, config)).catch(() => null),
        ]);
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(stringifyJson({ ...gas, reference: GAS_REFERENCE, rebalance }));
        return;
      }
      if (request.url === '/api/status') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(request.method === 'HEAD' ? undefined : stringifyJson(await deps.readStatus()));
        return;
      }
      const asset = assets[request.url as keyof typeof assets];
      if (!asset) { response.writeHead(404).end('Not found'); return; }
      const body = await readFile(fileURLToPath(new URL(`../ui/${asset[0]}`, import.meta.url)));
      response.writeHead(200, { 'Content-Type': asset[1] });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch { response.writeHead(503).end('Status temporarily unavailable'); }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  let closing: Promise<void> | undefined;
  return Object.assign(server, {
    closeChart: () => closing ??= Promise.all([deps.walletSetups.close(), new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      // SSE responses intentionally stay open. End their sockets on shutdown,
      // which also closes their file watchers through response cleanup.
      server.closeAllConnections();
    })]).then(() => {}),
  });
}
