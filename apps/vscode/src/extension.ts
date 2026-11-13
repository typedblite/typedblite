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

let client: LanguageClient | undefined;

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
): Promise<{ extendMarkdownIt(md: MarkdownIt): MarkdownIt }> {
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
  return { extendMarkdownIt: (md) => typeqliteFences(md, highlighter) };
}

export function deactivate(): Thenable<void> | undefined {
  return client?.stop();
}
