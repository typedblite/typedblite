import 'reflect-metadata';
import { request } from 'node:http';
import { PassThrough } from 'node:stream';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describe, expect, it } from 'vitest';

import { mcpModes, type ModeEnvironment } from '../src/mcp-modes.js';

/** The MCP modes driven in this process: the built binary is run as a process in mcp-process.test.ts. */
function environment() {
  let stderr = '';
  let exitCode: number | undefined;
  let stop!: () => void;
  const stopped = new Promise<void>((resolve) => (stop = resolve));
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let out = '';
  stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
  const env: ModeEnvironment = { stderr: (text) => (stderr += text), setExitCode: (code) => (exitCode = code), stop: () => stopped, stdin, stdout };
  return { env, stdin, stop, get stderr() { return stderr; }, get exitCode() { return exitCode; }, get stdout() { return out; } };
}
const mode = (env: ModeEnvironment, flag: string) => mcpModes(env).find((m) => m.flag === flag)!;

const until = async (check: () => boolean, what: string): Promise<void> => {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
};

describe('--mcp-http', () => {
  async function serve(...args: string[]) {
    const e = environment();
    const running = mode(e.env, '--mcp-http').run(undefined, ['--mcp-http', '--port', '0', ...args]);
    await until(() => /on http:\/\/\S+/.test(e.stderr), 'the server to announce itself');
    return { e, running, url: new URL(e.stderr.match(/on (http:\/\/\S+)/)![1]!) };
  }
  const post = (url: URL, body: string): Promise<number> =>
    new Promise((resolve, reject) => {
      const req = request({ host: url.hostname, port: url.port, path: '/mcp', method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' } }, (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end(body);
    });

  it('serves a client on loopback, says which tier, and stops when told to', async () => {
    const { e, running, url } = await serve();
    expect(e.stderr).toContain('(read tier)');
    const client = new Client({ name: 'spec', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(url));
    expect((await client.listTools()).tools).toHaveLength(6);
    await client.close();
    e.stop();
    await running;
    expect(e.exitCode).toBeUndefined();
  });

  it('serves the write tier with --mcp-write', async () => {
    const { e, running, url } = await serve('--mcp-write');
    expect(e.stderr).toContain('(write tier)');
    const client = new Client({ name: 'spec', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(url));
    expect((await client.listTools()).tools).toHaveLength(12);
    await client.close();
    e.stop();
    await running;
  });

  it('refuses a request body that is too large (413) or not JSON (400)', async () => {
    const { e, running, url } = await serve();
    expect(await post(url, 'x'.repeat(1024 * 1024 + 1))).toBe(413);
    expect(await post(url, '{not json')).toBe(400);
    e.stop();
    await running;
  });

  it.each(['0.0.0.0', '192.168.1.20', 'example.com', '::'])('refuses --host %s, naming it, exit 2, and listens on nothing', async (bad) => {
    const e = environment();
    await mode(e.env, '--mcp-http').run(undefined, ['--mcp-http', '--host', bad]);
    expect(e.exitCode).toBe(2);
    expect(e.stderr).toContain(`'${bad}'`);
  });

  it.each(['abc', '70000', '-1'])('refuses --port %s, exit 2', async (bad) => {
    const e = environment();
    await mode(e.env, '--mcp-http').run(undefined, ['--mcp-http', '--port', bad]);
    expect(e.exitCode).toBe(2);
    expect(e.stderr).toContain(`'${bad}'`);
  });

  it('accepts localhost as the host', async () => {
    const { e, running, url } = await serve('--host', 'localhost');
    expect(url.hostname).toBe('localhost');
    e.stop();
    await running;
  });
});

describe('--mcp', () => {
  it('speaks JSON-RPC on the streams it is given, and ends when its input does', async () => {
    const e = environment();
    const running = mode(e.env, '--mcp').run(undefined, ['--mcp']);
    const send = (message: object) => e.stdin.write(`${JSON.stringify(message)}\n`);
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'spec', version: '0' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    await until(() => e.stdout.split('\n').filter(Boolean).length >= 2, 'two responses');
    const responses = e.stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line) as { id: number; result: { tools?: unknown[] } });
    expect(responses.find((r) => r.id === 2)!.result.tools).toHaveLength(6);
    e.stdin.end();
    await running;
  });
});

describe('--mcp-write', () => {
  it('on its own is refused, exit 2', async () => {
    const e = environment();
    await mode(e.env, '--mcp-write').run(undefined, ['--mcp-write']);
    expect(e.exitCode).toBe(2);
    expect(e.stderr).toContain('is a tier, not a mode');
  });
});
