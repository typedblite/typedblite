import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Readable, Writable } from 'node:stream';

import type { CqrsToolRuntime, ToolEnvelope, ToolOperationDescriptor } from '@devx-micro/app-runtime';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { isLoopbackRequest } from './http.js';
import { checkCall, toolsFor, type McpTier } from './mcp-policy.js';
import { createHostOperations } from './operations.js';

/** The hosts `--host` may name. Authentication does not exist yet, so nothing else is served. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/** Thrown at start, before anything listens, for a `--host` or `--port` the host will not serve. */
export class McpConfigError extends Error {}

export function assertLoopbackHost(host: string): void {
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new McpConfigError(`--mcp-http serves loopback only (127.0.0.1, localhost, ::1); '${host}' is refused until authentication exists.`);
  }
}

export function parsePort(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || port > 65535) throw new McpConfigError(`--port must be a whole number from 0 to 65535, got '${raw}'.`);
  return port;
}

/** What a tool call answers: the operation's data, as JSON text. A fault is an error result with its code. */
function toolResult(envelope: ToolEnvelope): CallToolResult {
  if (envelope.status === 'success') return { content: [{ type: 'text', text: JSON.stringify(envelope.data ?? {}) }] };
  const body = envelope.error ?? { code: 'INCOMPLETE', message: 'The operation did not finish.' };
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: body.code, message: body.message, details: body.details }) }] };
}

const refusedResult = (message: string): CallToolResult => ({ isError: true, content: [{ type: 'text', text: message }] });

/**
 * An MCP server over the host's operations: tools only, in one tier.
 *
 * Each tool is an operation, named as it is on every other transport and described by the input schema its
 * descriptor declares. A call is dispatched through the one runtime, so it does what the same operation does on the
 * CLI or over HTTP (feature invariant 5). The server adds only the tier.
 */
export function createMcpServer(options: { runtime: CqrsToolRuntime; tier: McpTier; operations?: readonly ToolOperationDescriptor<any>[] }): Server {
  const { runtime, tier } = options;
  const tools = toolsFor(tier, options.operations ?? createHostOperations());
  const offered = new Map(tools.map((tool) => [tool.name, tool]));
  const allOperations = new Set((options.operations ?? createHostOperations()).map((operation) => operation.name));

  const server = new Server({ name: 'typedblite-host', version: '0.0.1' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tier === 'read' && tool.name === 'session.run' ? `${tool.summary} In this tier only reads run.` : tool.summary,
      inputSchema: tool.inputSchema as { type: 'object'; properties?: Record<string, unknown>; required?: string[] },
      annotations: { readOnlyHint: tier === 'read' || tool.kind === 'query' },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async ({ params }): Promise<CallToolResult> => {
    const name = params.name;
    if (!offered.has(name)) {
      return refusedResult(
        allOperations.has(name)
          ? `'${name}' is not available in the read tier. Start the host with --mcp-write to allow it.`
          : `There is no tool '${name}'.`,
      );
    }
    const input = (params.arguments ?? {}) as Record<string, unknown>;
    const check = await checkCall(tier, runtime, name, input);
    if (!check.allowed) return refusedResult(check.message);
    return toolResult(await runtime.dispatch(name, input));
  });

  return server;
}

/**
 * Serves MCP over stdio until the input ends. stdout carries the protocol, so nothing else may write to it: the
 * host's logger writes errors to stderr only.
 */
export async function runMcpStdio(
  options: { runtime: CqrsToolRuntime; tier: McpTier },
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): Promise<void> {
  const server = createMcpServer(options);
  const transport = new StdioServerTransport(input, output);
  const ended = new Promise<void>((resolve) => {
    transport.onclose = resolve;
    // The SDK's stdio transport does not notice the input ending; the process would wait for ever.
    input.once('end', () => void transport.close());
  });
  await server.connect(transport);
  await ended;
}

export interface McpHttpHandle {
  /** Where it is serving, with the port actually bound (so `--port 0` can be asked for). */
  readonly url: string;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 1024 * 1024;

class BodyTooLarge extends Error {}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    bytes += buffer.byteLength;
    if (bytes > MAX_BODY_BYTES) throw new BodyTooLarge();
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? (JSON.parse(text) as unknown) : undefined;
}

function refuse(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

/**
 * Serves MCP over Streamable HTTP, on loopback only, at `/mcp`.
 *
 * Stateless: each request gets its own server and transport, while the runtime, and so the sessions, is shared.
 * 🔴 It refuses a non-loopback `host` before it listens, and a request whose peer, `Host` or `Origin` is not
 * loopback (the same check as the HTTP transport).
 */
export async function startMcpHttp(options: { runtime: CqrsToolRuntime; tier: McpTier; host: string; port: number }): Promise<McpHttpHandle> {
  assertLoopbackHost(options.host);

  const http: HttpServer = createServer((request, response) => void handle(request, response, options));
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(options.port, options.host, resolve);
  });
  const { port } = http.address() as AddressInfo;
  const display = options.host.includes(':') ? `[${options.host}]` : options.host;
  return {
    url: `http://${display}:${port}/mcp`,
    close: () =>
      new Promise<void>((resolve) => {
        http.close(() => resolve());
        http.closeAllConnections();
      }),
  };
}

async function handle(request: IncomingMessage, response: ServerResponse, options: { runtime: CqrsToolRuntime; tier: McpTier }): Promise<void> {
  if (!isLoopbackRequest(request)) return refuse(response, 403, 'Forbidden: the host answers loopback requests only.');
  if (new URL(request.url ?? '/', 'http://localhost').pathname !== '/mcp') return refuse(response, 404, 'Not found.');
  if (request.method !== 'POST') {
    response.setHeader('allow', 'POST');
    return refuse(response, 405, 'Stateless server: POST only.');
  }
  let body: unknown;
  try {
    body = await readBody(request);
  } catch (error) {
    return error instanceof BodyTooLarge ? refuse(response, 413, 'The request is too large.') : refuse(response, 400, 'Parse error.');
  }
  const server = createMcpServer(options);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  response.on('close', () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(request, response, body);
  } catch (error) {
    process.stderr.write(`typedblite-host: an MCP request failed: ${String(error)}\n`);
    if (!response.headersSent) refuse(response, 500, 'Internal error.');
  }
}
