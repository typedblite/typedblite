import { createRequire } from 'node:module';

/** The Electron binary the `electron` package installed. */
export const electronPath = (): string => createRequire(import.meta.url)('electron') as unknown as string;

/**
 * The environment for launching Electron or a downloaded browser from this process.
 *
 * 🔴 Run from a VS Code terminal, `ELECTRON_RUN_AS_NODE` is inherited and starts Electron as plain
 * Node, and `VSCODE_*` points it at the host editor's IPC sockets. Neither belongs to the demo.
 */
export function cleanEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || name === 'ELECTRON_RUN_AS_NODE' || name.startsWith('VSCODE_')) continue;
    env[name] = value;
  }
  return env;
}
