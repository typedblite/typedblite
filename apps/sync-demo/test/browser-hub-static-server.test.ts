/**
 * `src/browser-hub/static-server.ts`: what serves the in-browser hub's build to a browser and to the browser tests.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { startStaticServer, type StaticServer } from '../src/browser-hub/static-server.js';

let root: string;
let plain: StaticServer;
let mounted: StaticServer;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'typedblite-static-'));
  mkdirSync(join(root, 'inside/deep'), { recursive: true });
  writeFileSync(join(root, 'index.html'), '<h1>home</h1>');
  writeFileSync(join(root, 'inside/index.html'), '<h1>inside</h1>');
  writeFileSync(join(root, 'inside/deep/file name.txt'), 'spaced');
  for (const [name, body] of Object.entries({ 'a.js': 'js', 'a.css': 'css', 'a.wasm': 'wasm', 'a.map': '{}', 'a.json': '{}', 'a.svg': '<svg/>', 'a.bin': 'bin' })) writeFileSync(join(root, name), body);
  // A neighbor of the folder, which a `..` must not reach.
  writeFileSync(join(root, '..', `${basename(root)}-secret.txt`), 'TOP-SECRET-CONTENT');
  plain = await startStaticServer(root);
  mounted = await startStaticServer(root, { prefix: '/sync-demo' });
});
afterAll(async () => {
  await plain.close();
  await mounted.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(`${root}-secret.txt`, { force: true });
});

const at = (server: StaticServer, path: string, init?: RequestInit): Promise<Response> => fetch(new URL(path, server.url).href.replace(/\/sync-demo\/(?=\/)/, '/sync-demo'), { redirect: 'manual', ...init });

describe('serving files', () => {
  it('listens on loopback only, on a free port', () => {
    expect(plain.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(plain.server.address()).toMatchObject({ address: '127.0.0.1' });
  });

  it('serves a file, a folder’s index.html, and the root', async () => {
    expect(await (await at(plain, '/index.html')).text()).toBe('<h1>home</h1>');
    expect(await (await at(plain, '/')).text()).toBe('<h1>home</h1>');
    expect(await (await at(plain, '/inside')).text()).toBe('<h1>inside</h1>');
    expect(await (await at(plain, '/inside/')).text()).toBe('<h1>inside</h1>');
  });

  it('decodes the path', async () => {
    expect(await (await at(plain, '/inside/deep/file%20name.txt')).text()).toBe('spaced');
  });

  it.each([
    ['/index.html', 'text/html; charset=utf-8'],
    ['/a.js', 'text/javascript; charset=utf-8'],
    ['/a.css', 'text/css; charset=utf-8'],
    ['/a.wasm', 'application/wasm'],
    ['/a.map', 'application/json; charset=utf-8'],
    ['/a.json', 'application/json; charset=utf-8'],
    ['/a.svg', 'image/svg+xml'],
    ['/a.bin', 'application/octet-stream'],
  ])('types %s as %s', async (path, type) => {
    expect((await at(plain, path)).headers.get('content-type')).toBe(type);
  });

  it('never lets the browser cache, so a rebuild is seen on reload', async () => {
    expect((await at(plain, '/a.js')).headers.get('cache-control')).toBe('no-store');
  });

  it('sends no cross-origin isolation headers: the page must work without them', async () => {
    const headers = (await at(plain, '/index.html')).headers;
    expect(headers.get('cross-origin-opener-policy')).toBeNull();
    expect(headers.get('cross-origin-embedder-policy')).toBeNull();
  });

  it('answers HEAD with the headers and no body', async () => {
    const response = await at(plain, '/a.js', { method: 'HEAD' });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('javascript');
    expect(await response.text()).toBe('');
  });
});

describe('refusing', () => {
  it('answers 404 for what is not there', async () => {
    expect((await at(plain, '/missing.js')).status).toBe(404);
    expect((await at(plain, '/inside/deep')).status).toBe(404); // a folder with no index.html
  });

  it.each(['POST', 'PUT', 'DELETE'])('answers %s with 405 and says what is allowed', async (method) => {
    const response = await at(plain, '/index.html', { method });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD');
  });

  it('answers 400 for a path that is not valid percent-encoding', async () => {
    expect((await at(plain, '/%E0%A4%A')).status).toBe(400);
  });

  it('does not serve a file outside its folder, however the path is spelled', async () => {
    const secret = `/../${basename(root)}-secret.txt`;
    // `fetch` normalizes `..` away, so send it raw.
    const raw = (path: string): Promise<{ status: number; body: string }> =>
      new Promise((resolve, reject) => {
        const req = httpRequest({ host: '127.0.0.1', port: new URL(plain.url).port, path, method: 'GET' }, (res) => {
          let body = '';
          res.on('data', (chunk: Buffer) => (body += chunk.toString()));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on('error', reject);
        req.end();
      });
    for (const path of [secret, `/%2e%2e/${basename(root)}-secret.txt`, '/..%2f' + basename(root) + '-secret.txt']) {
      const { status, body } = await raw(path);
      expect(body).not.toContain('TOP-SECRET-CONTENT');
      expect([403, 404]).toContain(status);
    }
  });
});

describe('a prefix', () => {
  it('serves the folder under it, as the website does', async () => {
    expect(mounted.url).toMatch(/\/sync-demo\/$/);
    expect(await (await at(mounted, '/sync-demo/index.html')).text()).toBe('<h1>home</h1>');
    expect(await (await at(mounted, '/sync-demo/')).text()).toBe('<h1>home</h1>');
    expect(await (await at(mounted, '/sync-demo/inside/deep/file%20name.txt')).text()).toBe('spaced');
  });

  it('redirects the bare prefix to its trailing slash, so relative URLs resolve under it', async () => {
    const response = await at(mounted, '/sync-demo');
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe('/sync-demo/');
  });

  it('serves nothing outside the prefix, so a page that asks for "/hub.js" instead of "hub.js" fails', async () => {
    expect((await at(mounted, '/index.html')).status).toBe(404);
    expect((await at(mounted, '/a.js')).status).toBe(404);
    expect((await at(mounted, '/sync-demo-other/a.js')).status).toBe(404);
  });
});

describe('closing', () => {
  it('stops listening, even with a connection open', async () => {
    const extra = await startStaticServer(root);
    await fetch(new URL('/a.js', extra.url));
    await extra.close();
    await expect(fetch(new URL('/a.js', extra.url))).rejects.toThrow();
  });

  it('refuses a port that is taken', async () => {
    await expect(startStaticServer(root, { port: Number(new URL(plain.url).port) })).rejects.toThrow(/EADDRINUSE/);
  });
});
