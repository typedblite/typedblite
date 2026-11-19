#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { defineApp } from '@devx-micro/app-main';

import { createHostTool } from './host-tool.js';

/**
 * `typedblite-host`: the TypeQLite engine host, over the transports that need no server.
 *
 * | argv | mode |
 * | --- | --- |
 * | `--repl` | an interactive prompt over the operations |
 * | `--sidecar` | newline-delimited JSON on stdio: how the editor talks to the host |
 * | an operation name | one operation, one envelope on stdout, an exit code |
 * | an unrecognised flag first | refused by name, exit 2 |
 *
 * 🔴 There is no HTTP mode yet (Phase 03), so a bare `typedblite-host` prints its help and starts nothing.
 */
export const app = defineApp({ name: 'typedblite-host', createTool: createHostTool });
export const { runCli, runRepl, runSidecar } = app;

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
