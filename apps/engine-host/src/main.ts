#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { defineApp } from '@devx-micro/app-main';

import { createHostHttp } from './http.js';
import { createHostTool } from './host-tool.js';
import { mcpModes } from './mcp-modes.js';

/**
 * `typedblite-host`: the TypeQLite engine host, over the transports that need no server.
 *
 * | argv | mode |
 * | --- | --- |
 * | `--repl` | an interactive prompt over the operations |
 * | `--sidecar` | newline-delimited JSON on stdio: how the editor talks to the host |
 * | `--mcp`, `--mcp-http` | an MCP server over stdio, or over HTTP on loopback; reads only unless `--mcp-write` |
 * | an operation name | one operation, one envelope on stdout, an exit code |
 * | none | HTTP on `127.0.0.1`, port `TYPEDBLITE_HOST_PORT` (default 3470) |
 * | an unrecognized flag first | refused by name, exit 2 |
 *
 * 🔴 A bare `typedblite-host` starts a server, so an unrecognized flag must never fall through to it: `defineApp`
 * refuses one by name. The server answers loopback only.
 */
export const app = defineApp({
  name: 'typedblite-host',
  createTool: createHostTool,
  extraModes: mcpModes(),
  http: { createApp: createHostHttp, portEnv: 'TYPEDBLITE_HOST_PORT', defaultPort: 3470, helpPath: '/api/typedblite-host/help' },
});
export const { runCli, runRepl, runSidecar, runApi } = app;

/** Whether this module is the script Node was asked to run, by real path, so a `bin` link still counts. */
function isEntryPoint(script: string | undefined): boolean {
  if (!script) return false;
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

/* v8 ignore start -- @preserve -- entry point only; the module is imported by tests, and the process is run by test/process.test.ts. */
if (isEntryPoint(process.argv[1])) {
  app.main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
/* v8 ignore stop */
