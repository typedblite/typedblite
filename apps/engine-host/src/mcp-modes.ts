import type { Readable, Writable } from 'node:stream';

import type { AppExtraMode } from '@devx-micro/app-main';

import { createHostTool } from './host-tool.js';
import { McpConfigError, assertLoopbackHost, parsePort, runMcpStdio, startMcpHttp } from './mcp.js';
import type { McpTier } from './mcp-policy.js';

/**
 * What the MCP modes touch of the process, so a spec can drive them: where they write, how they say they failed,
 * what ends a long-running one, and the streams stdio MCP speaks on.
 */
export interface ModeEnvironment {
  readonly stderr: (text: string) => void;
  readonly setExitCode: (code: number) => void;
  /** Resolves when the process is asked to stop. */
  readonly stop: () => Promise<void>;
  readonly stdin: Readable;
  readonly stdout: Writable;
}

const processEnvironment = (): ModeEnvironment => ({
  stderr: (text) => void process.stderr.write(text),
  setExitCode: (code) => {
    process.exitCode = code;
  },
  stop: () =>
    new Promise<void>((resolve) => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
    }),
  stdin: process.stdin,
  stdout: process.stdout,
});

const valueOf = (argv: readonly string[], flag: string): string | undefined => {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
};
const tierOf = (argv: readonly string[]): McpTier => (argv.includes('--mcp-write') ? 'write' : 'read');

export const MCP_HTTP_PORT = 3471;

/**
 * MCP. `--mcp` is stdio, `--mcp-http` is Streamable HTTP on loopback, and both serve the read tier unless
 * `--mcp-write` is given too. `--mcp-write` alone is refused: it is a tier, not a mode.
 *
 * A refusal of how the host was started is said on stderr with exit code 2, before anything is opened or listening.
 */
export function mcpModes(environment: ModeEnvironment = processEnvironment()): AppExtraMode<undefined>[] {
  const usage = (message: string): undefined => {
    environment.stderr(`typedblite-host: ${message}\n`);
    environment.setExitCode(2);
    return undefined;
  };

  return [
    {
      flag: '--mcp',
      run: async (_options, argv) => {
        const tool = await createHostTool();
        try {
          await runMcpStdio({ runtime: tool.runtime, tier: tierOf(argv) }, environment.stdin, environment.stdout);
        } finally {
          await tool.close();
        }
      },
    },
    {
      flag: '--mcp-http',
      run: async (_options, argv) => {
        try {
          const host = valueOf(argv, '--host') ?? '127.0.0.1';
          assertLoopbackHost(host);
          const port = parsePort(valueOf(argv, '--port'), MCP_HTTP_PORT);
          const tool = await createHostTool();
          const handle = await startMcpHttp({ runtime: tool.runtime, tier: tierOf(argv), host, port });
          environment.stderr(`typedblite-host: MCP (${tierOf(argv)} tier) on ${handle.url}\n`);
          await environment.stop();
          await handle.close();
          await tool.close();
        } catch (error) {
          if (error instanceof McpConfigError) return usage(error.message);
          throw error;
        }
      },
    },
    { flag: '--mcp-write', run: async () => usage('--mcp-write is a tier, not a mode: use it with --mcp or --mcp-http.') },
  ];
}
