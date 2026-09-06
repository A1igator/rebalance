import { createServer, type ServerResponse } from 'node:http';
import { watch, type FSWatcher } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { DATA, loadConfig } from './config.js';
import { status, type Status } from './runtime.js';
import { stringifyJson } from './storage.js';
import { createGasDisplayReader, type GasDisplay } from './gas-display.js';
import { GAS_REFERENCE } from './gas-reference.js';
import { projectRebalanceFees } from './fee-projection.js';

const assets = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
} as const;

type ChartDependencies = {
  dataDir: string;
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

export async function serve(port = 4663, overrides: Partial<ChartDependencies> = {}) {
  const deps: ChartDependencies = { dataDir: DATA, readStatus: status, readGas: createGasDisplayReader(), readConfig: loadConfig,
    watchChanges: (directory, listener) => watch(directory, listener), ...overrides };
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'");
    const host = request.headers.host;
    const address = server.address();
    const boundPort = typeof address === 'object' && address ? address.port : port;
    if ((host !== `127.0.0.1:${boundPort}` && host !== `localhost:${boundPort}`) ||
        (request.headers.origin !== undefined && request.headers.origin !== `http://${host}`)) {
      response.writeHead(403).end('Local chart only'); return;
    }
    if (request.url === '/api/status/events') {
      if (request.method !== 'GET') { response.writeHead(405, { Allow: 'GET' }).end('View only'); return; }
      streamStatus(response, deps); return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' }).end('View only'); return;
    }
    try {
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
    closeChart: () => closing ??= new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      // SSE responses intentionally stay open. End their sockets on shutdown,
      // which also closes their file watchers through response cleanup.
      server.closeAllConnections();
    }),
  });
}
