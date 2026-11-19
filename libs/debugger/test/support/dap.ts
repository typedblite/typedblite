import { createServer, type AddressInfo, type Server } from 'node:net';

import { DebugClient } from '@vscode/debugadapter-testsupport';

import { TypeQLiteDebugSession } from '../../src/adapter.js';
import type { Files } from '../../src/program.js';
import type { HostCaller } from '../../src/wire.js';

/**
 * A DAP client connected to the adapter over a socket, as `@vscode/debugadapter-testsupport` drives any adapter: the
 * client is the protocol, and nothing of VS Code is involved.
 */
export async function connect(host: HostCaller, files: Files): Promise<{ client: DebugClient; close: () => Promise<void> }> {
  const server: Server = createServer((socket) => {
    const session = new TypeQLiteDebugSession(host, files);
    session.setRunAsServer(true);
    session.start(socket, socket);
  }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  // The runtime and executable are not used: the client connects to the port.
  const client = new DebugClient('node', 'unused', 'typeqlite');
  await client.start((server.address() as AddressInfo).port);
  return {
    client,
    close: async () => {
      await client.stop().catch(() => undefined);
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
