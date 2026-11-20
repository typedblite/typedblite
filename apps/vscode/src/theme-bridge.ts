import * as vscode from 'vscode';
import { readThemeFiles } from './markdown/theme-loader.js';
import { THEME_FILES_COMMAND, type ThemeFilesResult } from './markdown/theme-source.js';

/**
 * The TypeQLite Theme Bridge: a UI extension (`extensionKind: ["ui"]`) whose only job is to read a
 * color theme's files where VS Code keeps them (ADR-010 D7).
 *
 * In a remote window the TypeQLite extension runs in the remote extension host, and the themes are
 * UI extensions in the local one, out of its sight. Commands cross between the hosts, so it asks for
 * the files through `typeqlite.themeFiles` and this answers with the same code it would have run
 * itself. It reads no settings and knows nothing of TypeQLite.
 */
export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      THEME_FILES_COMMAND,
      (themeName: unknown): Promise<ThemeFilesResult> | ThemeFilesResult =>
        typeof themeName === 'string' ? readThemeFiles(themeName) : { missing: 'No theme name was given' },
    ),
  );
}
