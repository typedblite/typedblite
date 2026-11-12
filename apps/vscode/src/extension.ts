import type * as vscode from 'vscode';
import {
  LanguageClient,
  TransportKind,
  type LanguageClientOptions,
  type ServerOptions,
} from 'vscode-languageclient/node';

let client: LanguageClient | undefined;

/**
 * The client half of the TypeQLite editor: it starts the language server and does nothing else.
 *
 * 🔴 Everything the editor knows comes from the server, and the server is `createTypeQLiteServices`
 * (ADR-008). A command, check or keyword list written here would be a second definition of
 * TypeQLite, and it would drift from the first.
 *
 * The shape is upstream's: `packages/langium-vscode/src/extension.ts` at `v4.3.0` (ADR-008 D8,
 * rows 5–7).
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const serverModule = context.asAbsolutePath('out/language-server/main.cjs');
  // The server is a separate process, so a debugger can only attach to it if ITS argv carries
  // `--inspect`. `DEBUG_BREAK` makes it wait for the debugger; `DEBUG_SOCKET` moves the port.
  const inspect = `--inspect${process.env['DEBUG_BREAK'] ? '-brk' : ''}=${
    process.env['DEBUG_SOCKET'] ?? '6009'
  }`;
  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: { execArgv: ['--nolazy', inspect] },
    },
  };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: 'file', language: 'typeqlite' }],
  };
  client = new LanguageClient('typeqlite', 'TypeQLite', serverOptions, clientOptions);
  // Awaited, as upstream does: activation resolves only once the server has answered `initialize`,
  // so nothing that runs straight after activation can race it.
  await client.start();
}

export function deactivate(): Thenable<void> | undefined {
  return client?.stop();
}
