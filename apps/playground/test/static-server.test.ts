import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { serveDirectory } from '../src/dev/static-server';

let root: string;
let site: Awaited<ReturnType<typeof serveDirectory>>;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'playground-static-'));
  mkdirSync(join(root, 'site', 'sub'), { recursive: true });
  writeFileSync(join(root, 'secret.txt'), 'outside the served directory');
  writeFileSync(join(root, 'site', 'index.html'), '<title>home</title>');
  writeFileSync(join(root, 'site', 'app.js'), 'export {};');
  writeFileSync(join(root, 'site', 'engine.wasm'), Buffer.from([0, 97, 115, 109]));
  writeFileSync(join(root, 'site', 'sub', 'page.svg'), '<svg/>');
  site = await serveDirectory(join(root, 'site'));
});
afterAll(async () => {
  await site.close();
  rmSync(root, { recursive: true, force: true });
});

/** A raw request, so a `..` path reaches the server unresolved: `fetch` would normalise it away. */
const raw = (path: string) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const url = new URL(site.url);
    request({ host: url.hostname, port: url.port, path }, (response) => {
      let body = '';
      response.on('data', (chunk) => (body += chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
    }).on('error', reject).end();
  });

describe('the static server', () => {
  it('serves index.html at the root, and files with their types', async () => {
    const home = await fetch(`${site.url}/`);
    expect(await home.text()).toBe('<title>home</title>');
    expect(home.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect((await fetch(`${site.url}/app.js`)).headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect((await fetch(`${site.url}/engine.wasm`)).headers.get('content-type')).toBe('application/wasm');
    expect((await fetch(`${site.url}/sub/page.svg`)).headers.get('content-type')).toBe('image/svg+xml');
  });

  it('answers 404 for a file that is not there, and does not cache', async () => {
    expect((await fetch(`${site.url}/nope.js`)).status).toBe(404);
    expect((await fetch(`${site.url}/app.js`)).headers.get('cache-control')).toBe('no-cache');
  });

  it.each(['/../secret.txt', '/sub/../../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt'])(
    'refuses %s, and never serves a file outside its directory',
    async (path) => {
      const answer = await raw(path);
      expect([403, 404]).toContain(answer.status);
      expect(answer.body).not.toContain('outside the served directory');
    },
  );

  it('refuses with 403, not merely 404, when the decoded path climbs out', async () => {
    // `%2f` survives URL parsing, so only the server's own check stands between this and the file.
    const answer = await raw('/..%2fsecret.txt');
    expect(answer.status).toBe(403);
    expect(answer.body).toBe('forbidden');
  });

  it('answers 400 for a path that cannot be decoded', async () => {
    expect((await raw('/%E0%A4%A')).status).toBe(400);
  });

  it('binds the loopback address only', () => {
    expect(site.url.startsWith('http://127.0.0.1:')).toBe(true);
  });
});
