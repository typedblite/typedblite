/**
 * The demo server: what every device and window talks to.
 *
 * - `/net/<device>/hub/…` — the **switchboard**. It proxies to the hub, subject to that device's
 *   link. A link that is down destroys the socket, so the device sees exactly the network error it
 *   would see with no connection, and live connections are cut the moment the switch is thrown.
 * - `/api/…` — the control page's view and its switches: links, and the hub process itself.
 * - `/control` — the control page. Everything else is the client build (`.build/`).
 *
 * 🔴 The hub is a child process, so stopping it is a real outage, not a flag. A hub that cannot be
 * reached is answered 502 — and since ADR-009 D7 the replicator treats that as a failed sync. The
 * original demo had to fake a refused connection here instead, because a 5xx then read as "in sync".
 */
import { fork, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEVICES = ['pwa', 'electron', 'android'] as const;
export type DeviceName = (typeof DEVICES)[number];

export interface DemoServerOptions {
  /** 0 picks a free port. */
  readonly port?: number;
  readonly host?: string;
  /** 0 picks a free port for the hub on its first start; restarts reuse it. */
  readonly hubPort?: number;
  /** Where the hub's store lives. */
  readonly dataDir: string;
  /** The client build to serve, if there is one. */
  readonly clientDir?: string;
  readonly log?: (line: string) => void;
}

export interface DemoServer {
  readonly url: string;
  readonly port: number;
  hubRunning(): boolean;
  startHub(): Promise<void>;
  stopHub(): Promise<void>;
  setLink(device: string, up: boolean): void;
  links(): Record<string, boolean>;
  close(): Promise<void>;
}

const APP = fileURLToPath(new URL('../../', import.meta.url));
const HUB_MAIN = join(APP, 'out/hub/main.js');
const CONTROL = join(APP, 'static/control.html');
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

export async function startDemoServer(options: DemoServerOptions): Promise<DemoServer> {
  const log = options.log ?? ((line: string) => console.log(line));
  mkdirSync(options.dataDir, { recursive: true });
  const linkUp = new Map<string, boolean>(DEVICES.map((device) => [device, true]));
  const live = new Map<string, Set<Socket>>();
  let hub: ChildProcess | undefined;
  let hubPort = options.hubPort ?? 4310;

  const startHub = async (): Promise<void> => {
    if (hub) return;
    if (!existsSync(HUB_MAIN)) throw new Error(`No hub build at ${HUB_MAIN}. Run: npm exec nx -- run sync-demo:build`);
    const child = fork(HUB_MAIN, [], {
      env: { ...process.env, HUB_DB: join(options.dataDir, 'hub.db'), HUB_PORT: String(hubPort) },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    hub = child;
    child.on('exit', () => {
      if (hub === child) hub = undefined;
    });
    hubPort = await new Promise<number>((resolve, reject) => {
      child.once('message', (message: { type?: string; port?: number }) => (message.type === 'ready' ? resolve(message.port ?? hubPort) : undefined));
      child.once('exit', (code) => reject(new Error(`the hub exited before it was ready (code ${code})`)));
    });
    log(`hub up on 127.0.0.1:${hubPort}`);
  };

  const stopHub = async (): Promise<void> => {
    const child = hub;
    if (!child) return;
    hub = undefined;
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.kill('SIGKILL'); // an outage, not a shutdown
    });
    log('hub down');
  };

  const setLink = (device: string, up: boolean): void => {
    linkUp.set(device, up);
    if (!up) for (const socket of live.get(device) ?? []) socket.destroy();
    log(`link ${device} ${up ? 'up' : 'down'}`);
  };

  const proxy = (device: string, rest: string, req: IncomingMessage, res: ServerResponse): void => {
    if (linkUp.get(device) === false) return void req.socket.destroy();
    const sockets = live.get(device) ?? new Set<Socket>();
    live.set(device, sockets);
    sockets.add(req.socket);
    req.socket.once('close', () => sockets.delete(req.socket));
    const upstream = httpRequest(
      { host: '127.0.0.1', port: hubPort, path: rest, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${hubPort}` } },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' }).end('the hub cannot be reached');
      else res.destroy();
    });
    // A device that goes away (or is cut) must not leave its SSE stream open on the hub.
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  };

  const hubTasks = async (): Promise<unknown[] | undefined> => {
    if (!hub) return undefined;
    try {
      const answer = await fetch(`http://127.0.0.1:${hubPort}/tasks`, { signal: AbortSignal.timeout(2_000) });
      return answer.ok ? ((await answer.json()) as unknown[]) : undefined;
    } catch {
      return undefined;
    }
  };

  const json = (res: ServerResponse, body: unknown, status = 200): void =>
    void res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));

  const serveFile = (res: ServerResponse, file: string): void => {
    try {
      const body = readFileSync(file);
      // Network-first everywhere: a rebuilt client is never hidden behind a cache.
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' }).end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://demo');
    const path = url.pathname;
    const net = /^\/net\/([a-z0-9-]+)\/hub(\/.*)$/.exec(path);
    if (net) return proxy(net[1] as string, `${net[2]}${url.search}`, req, res);

    if (path === '/api/state' && req.method === 'GET') {
      return void hubTasks().then((tasks) => json(res, { hub: { running: hub !== undefined, tasks }, links: Object.fromEntries(linkUp) }));
    }
    const link = /^\/api\/link\/([a-z0-9-]+)\/(up|down)$/.exec(path);
    if (link && req.method === 'POST') {
      setLink(link[1] as string, link[2] === 'up');
      return json(res, { links: Object.fromEntries(linkUp) });
    }
    const hubSwitch = /^\/api\/hub\/(start|stop)$/.exec(path);
    if (hubSwitch && req.method === 'POST') {
      const action = hubSwitch[1] === 'start' ? startHub() : stopHub();
      return void action.then(() => json(res, { running: hub !== undefined })).catch((error: Error) => json(res, { error: error.message }, 500));
    }
    if (path === '/control' || path === '/control.html') return serveFile(res, CONTROL);
    if (options.clientDir) {
      const file = normalize(join(options.clientDir, path === '/' ? 'index.html' : path));
      if (file.startsWith(normalize(options.clientDir))) return serveFile(res, file);
    }
    res.writeHead(404).end('not found');
  });

  await startHub();
  const port = await new Promise<number>((resolve) => {
    server.listen(options.port ?? 4300, options.host ?? '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });
  const url = `http://localhost:${port}`;
  log(`demo server on ${url} — control page ${url}/control`);

  return {
    url,
    port,
    hubRunning: () => hub !== undefined,
    startHub,
    stopHub,
    setLink,
    links: () => Object.fromEntries(linkUp),
    close: async () => {
      for (const sockets of live.values()) for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await stopHub();
    },
  };
}
