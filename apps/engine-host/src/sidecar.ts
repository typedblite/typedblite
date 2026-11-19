import { defineApp } from '@devx-micro/app-main';

import { createHostTool } from './host-tool.js';

/**
 * The host as the editor runs it: the sidecar transport and nothing else.
 *
 * It is the same `defineApp` as `main.ts`, with the one transport, so the editor's bundle carries no HTTP server and
 * no MCP SDK. The operations are the same declaration (`operations.ts`), reached through the same buses.
 */
defineApp({ name: 'typedblite-host', createTool: createHostTool })
  .runSidecar()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
