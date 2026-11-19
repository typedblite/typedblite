import * as vscode from 'vscode';
import type MarkdownIt from 'markdown-it';
import {
  LanguageClient,
  TransportKind,
  type LanguageClientOptions,
  type ServerOptions,
} from 'vscode-languageclient/node';
import { fallbackPalette, themePalette } from './markdown/paint.js';
import { PreviewHighlighter, typeqliteFences } from './markdown/preview-highlighter.js';
import { HIGHLIGHT_BLOCKS, type HighlightBlocksParams, type HighlightBlocksResult } from './markdown/protocol.js';
import { loadTheme, THEME_SETTINGS } from './markdown/theme-loader.js';
import { HOST_NODE_SETTING, HOST_REQUEST_COMMAND } from './host/constants.js';
import { HostClient, type HostEnvelope } from './host/host-client.js';
import { NOTEBOOK_TYPE, NOTEBOOK_TYPE_MARKDOWN } from './notebook/constants.js';
import { registerNotebookControllers } from './notebook/controller.js';
import { NotebookSessions } from './notebook/notebook-sessions.js';
import { TypeQLiteNotebookSerializer } from './notebook/serializer.js';

let client: LanguageClient | undefined;
let host: HostClient | undefined;

/** What the extension hands to the features and extensions built on it, beside the Markdown plugin. */
export interface TypeDBLiteApi {
  extendMarkdownIt(md: MarkdownIt): MarkdownIt;
  /** The engine host: operations by name, over a process the extension starts when first asked. */
  readonly host: Pick<HostClient, 'request' | 'call'>;
}

/**
 * The client half of the TypeQLite editor. It starts the language server, and it colours the
 * TypeQLite code blocks in the Markdown preview with what that server says about them (ADR-010).
 *
 * 🔴 Everything the editor knows comes from the server, and the server is `createTypeQLiteServices`
 * (ADR-008). A command, check or keyword list written here would be a second definition of
 * TypeQLite, and it would drift from the first. The preview keeps to that: the server classifies
 * every token, and the client only turns classes into the theme's colours, which the server cannot
 * see.
 *
 * The shape is upstream's: `packages/langium-vscode/src/extension.ts` at `v4.3.0` (ADR-008 D8,
 * rows 5–7).
 */
export async function activate(
  context: vscode.ExtensionContext,
): Promise<TypeDBLiteApi> {
  // 🔴 The engine host is a separate process the extension starts, and never code it imports (feature invariant 6).
  // It is started on the first request, not at activation, so opening a `.tql` file costs nothing. Registered first: it
  // does not wait for the language server.
  const hostClient = new HostClient({
    sidecarPath: context.asAbsolutePath('out/host/sidecar.cjs'),
    configuredNode: () => vscode.workspace.getConfiguration().get<string>(HOST_NODE_SETTING) || undefined,
  });
  host = hostClient;
  // The notebook file format (ADR-012 N2). `transientOutputs`: outputs are never saved, and running a cell does not mark
  // the notebook changed. Registered before the language server starts, so opening a notebook does not wait for it.
  const serializer = new TypeQLiteNotebookSerializer();
  for (const type of [NOTEBOOK_TYPE, NOTEBOOK_TYPE_MARKDOWN]) {
    context.subscriptions.push(vscode.workspace.registerNotebookSerializer(type, serializer, { transientOutputs: true }));
  }
  context.subscriptions.push(
    hostClient,
    vscode.commands.registerCommand(HOST_REQUEST_COMMAND, (operation: string, input?: Record<string, unknown>): Promise<HostEnvelope> => hostClient.request(operation, input)),
    // A different `node` takes effect on the next request: the running host is ended, and its sessions with it.
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(HOST_NODE_SETTING)) void hostClient.stop();
    }),
  );
  // The notebook's kernel: its cells are run by the engine host, one session per open notebook (ADR-012 N3).
  registerNotebookControllers(context, hostClient, new NotebookSessions(hostClient));

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
    // A notebook's code cells are TypeQLite documents too, under their own scheme (ADR-012 N4): the language features
    // (diagnostics, completion, definition, rename) answer in a cell as they do in a file.
    documentSelector: [
      { scheme: 'file', language: 'typeqlite' },
      { scheme: 'vscode-notebook-cell', language: 'typeqlite' },
    ],
  };
  const started = new LanguageClient('typeqlite', 'TypeQLite', serverOptions, clientOptions);
  client = started;
  // Awaited, as upstream does: activation resolves only once the server has answered `initialize`,
  // so nothing that runs straight after activation can race it.
  await started.start();

  // The Markdown preview activates this extension itself, because the manifest contributes
  // `markdown.markdownItPlugins`, and calls `extendMarkdownIt` on what activation returns.
  let refreshing: ReturnType<typeof setTimeout> | undefined;
  const highlighter = new PreviewHighlighter({
    request: (blocks) =>
      started.sendRequest<HighlightBlocksResult>(HIGHLIGHT_BLOCKS, { blocks } satisfies HighlightBlocksParams),
    palette: async () => {
      const theme = await loadTheme(started.outputChannel);
      return theme ? themePalette(theme) : fallbackPalette;
    },
    // Tokens and the palette usually land together: one re-render for both.
    refresh: () => {
      clearTimeout(refreshing);
      refreshing = setTimeout(() => void vscode.commands.executeCommand('markdown.preview.refresh'), 50);
    },
  });
  context.subscriptions.push(
    vscode.window.onDidChangeActiveColorTheme(() => highlighter.themeChanged()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (THEME_SETTINGS.some((setting) => event.affectsConfiguration(setting))) highlighter.themeChanged();
    }),
  );
  return { extendMarkdownIt: (md) => typeqliteFences(md, highlighter), host: hostClient };
}

export async function deactivate(): Promise<void> {
  await host?.stop();
  await client?.stop();
}
