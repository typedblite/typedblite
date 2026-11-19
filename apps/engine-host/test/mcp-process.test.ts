import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { request } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';

/** The built host's MCP modes, as a process and over a real transport. `nx run engine-host:test` builds first. */
const MAIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'out', 'main.js');
const host = (...args: string[]) => spawnSync(process.execPath, [MAIN, ...args], { encoding: 'utf8', timeout: 20_000 });

const clients: Client[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const child of children.splice(0)) child.kill('SIGTERM');
});

describe('--mcp: stdio', () => {
  async function connect(...flags: string[]): Promise<Client> {
    const client = new Client({ name: 'spec', version: '0' });
    // stdout is the protocol: a stray line there would fail this connection, which is the check that nothing writes to it.
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [MAIN, '--mcp', ...flags], stderr: 'pipe' }));
    clients.push(client);
    return client;
  }

  it('serves the read tier by default', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(['schema.get', 'session.get', 'session.list', 'session.run', 'statement.classify', 'statement.split']);

    const answer = (await client.callTool({ name: 'statement.classify', arguments: { statement: 'insert $a isa a;' } })) as { content: { text: string }[] };
    expect(JSON.parse(answer.content[0]!.text)).toEqual({ kind: 'write' });

    const refused = (await client.callTool({ name: 'session.run', arguments: { location: ':memory:', statement: 'insert $a isa a;' } })) as { isError: boolean };
    expect(refused.isError).toBe(true);
  });

  it('serves every operation with --mcp-write, in either order', async () => {
    // Every operation but session.debug, which is never a tool (ADR-014 B2).
    expect((await (await connect('--mcp-write')).listTools()).tools).toHaveLength(13);
  });

  it('ends when its input ends', async () => {
    const child = spawn(process.execPath, [MAIN, '--mcp'], { stdio: ['pipe', 'ignore', 'ignore'] });
    child.stdin!.end();
    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
    expect(code).toBe(0);
  });
});

describe('--mcp-write on its own', () => {
  it('is refused, exit 2: it is a tier and not a mode', () => {
    const result = host('--mcp-write');
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--mcp-write');
  });
});

describe('--mcp-http', () => {
  /** Starts it on an ephemeral port and reads the URL it announces on stderr. */
  async function start(...flags: string[]): Promise<{ url: URL; child: ChildProcess }> {
    const child = spawn(process.execPath, [MAIN, '--mcp-http', '--port', '0', ...flags], { stdio: ['ignore', 'ignore', 'pipe'] });
    children.push(child);
    const url = await new Promise<string>((resolve, reject) => {
      let text = '';
      child.stderr!.on('data', (chunk: Buffer) => {
        text += chunk.toString();
        const found = text.match(/on (http:\/\/\S+)/);
        if (found) resolve(found[1]!);
      });
      child.once('exit', () => reject(new Error(`exited before serving: ${text}`)));
    });
    return { url: new URL(url), child };
  }

  /** A raw request, for the headers and methods `fetch` and the SDK client will not send. */
  const raw = (url: URL, options: { method?: string; path?: string; headers?: Record<string, string>; body?: string }): Promise<number> =>
    new Promise((resolve, reject) => {
      const req = request(
        { host: url.hostname, port: url.port, path: options.path ?? '/mcp', method: options.method ?? 'POST', headers: options.headers },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end(options.body);
    });

  it('serves MCP on loopback, to a real client, reads only by default', async () => {
    const { url } = await start();
    expect(url.hostname).toBe('127.0.0.1');
    const client = new Client({ name: 'spec', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(url));
    clients.push(client);
    expect((await client.listTools()).tools).toHaveLength(6);
  });

  it('serves the write tier when asked, and keeps a session across requests', async () => {
    const { url } = await start('--mcp-write');
    const client = new Client({ name: 'spec', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(url));
    clients.push(client);
    const text = async (name: string, args: Record<string, unknown>) =>
      JSON.parse(((await client.callTool({ name, arguments: args })) as { content: { text: string }[] }).content[0]!.text);
    expect(await text('session.open', { schema: 'define entity a;' })).toMatchObject({ id: 's1' });
    expect(await text('session.list', {})).toMatchObject([{ id: 's1', hasSchema: true }]);
  });

  it('refuses a host that is not loopback, naming it, before it listens', () => {
    for (const bad of ['0.0.0.0', '192.168.1.20', 'example.com', '::']) {
      const result = host('--mcp-http', '--host', bad, '--port', '0');
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(`'${bad}'`);
      expect(result.signal).toBeNull();
    }
  });

  it('refuses a port that is not a port', () => {
    for (const bad of ['abc', '70000', '-1']) {
      const result = host('--mcp-http', '--port', bad);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(`'${bad}'`);
    }
  });

  it('refuses a request that names another Host or Origin (403), a GET (405), and another path (404)', async () => {
    const { url } = await start();
    const initialize = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const json = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    const hostHeader = `127.0.0.1:${url.port}`;
    expect(await raw(url, { headers: { ...json, host: `evil.example:${url.port}` }, body: initialize })).toBe(403);
    expect(await raw(url, { headers: { ...json, host: hostHeader, origin: 'https://evil.example' }, body: initialize })).toBe(403);
    expect(await raw(url, { headers: { ...json, host: hostHeader, origin: 'null' }, body: initialize })).toBe(403);
    expect(await raw(url, { headers: { ...json, host: hostHeader, origin: `http://localhost:${url.port}` }, body: initialize })).toBe(200);
    expect(await raw(url, { method: 'GET', headers: { host: hostHeader } })).toBe(405);
    expect(await raw(url, { path: '/other', headers: { ...json, host: hostHeader }, body: initialize })).toBe(404);
    expect(await raw(url, { headers: { ...json, host: hostHeader }, body: '{not json' })).toBe(400);
  });

  it('stops when told to', async () => {
    const { child } = await start();
    child.kill('SIGTERM');
    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
    expect(code === 0 || code === null).toBe(true);
  });
});
