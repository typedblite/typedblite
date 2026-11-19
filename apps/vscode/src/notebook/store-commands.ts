import * as vscode from 'vscode';

import { NOTEBOOK_TYPE, NOTEBOOK_TYPE_MARKDOWN } from './constants.js';
import { exportMarkdown, exportScript, type ExportCell } from './export.js';
import { describeStore, type NotebookSessions, type StoreChoice, type StoreMode } from './notebook-sessions.js';

export const OPEN_STORE_COMMAND = 'typedblite.notebook.openStore';
export const COMMIT_COMMAND = 'typedblite.notebook.commit';
export const ROLLBACK_COMMAND = 'typedblite.notebook.rollback';
export const EXPORT_SCRIPT_COMMAND = 'typedblite.notebook.exportScript';
export const EXPORT_MARKDOWN_COMMAND = 'typedblite.notebook.exportMarkdown';

/** The context key that shows Commit and Rollback on the toolbar: only a notebook that holds its changes has any. */
export const HOLDS_CHANGES_CONTEXT = 'typedblite.notebook.holdsChanges';

/** What a toolbar or the palette hands a command: the editor's notebook, or nothing. */
type Context = { notebookEditor?: { notebookUri: vscode.Uri } } | undefined;

/** The store to use, given without a dialog: for a script, a test, or another extension. A file is only ever opened on a choice. */
export type StoreRequest = { kind: 'memory' } | { kind: 'file'; location: string; mode: StoreMode };

const NOTEBOOK_TYPES: readonly string[] = [NOTEBOOK_TYPE, NOTEBOOK_TYPE_MARKDOWN];
const STORE_FILTERS = { 'TypeDBLite stores': ['db', 'sqlite', 'sqlite3'], 'All files': ['*'] };

function notebookOf(context: Context): vscode.NotebookDocument | undefined {
  const uri = context?.notebookEditor?.notebookUri ?? vscode.window.activeNotebookEditor?.notebook.uri;
  const found = uri && vscode.workspace.notebookDocuments.find((notebook) => notebook.uri.toString() === uri.toString());
  return found && NOTEBOOK_TYPES.includes(found.notebookType) ? found : undefined;
}

const cellsOf = (notebook: vscode.NotebookDocument): ExportCell[] =>
  notebook.getCells().map((cell) => ({ kind: cell.kind === vscode.NotebookCellKind.Code ? 'code' : 'markup', value: cell.document.getText() }));

/**
 * The notebook's store, and what leaves it (ADR-012 N5, feature goals 5 and 6).
 *
 * 🔴 **A notebook runs in memory until the user chooses a file, and the choice is the user's alone** (feature invariant 3).
 * The choice is made through a dialog (or an explicit argument, for a script), says in the status bar which file and when
 * its writes become permanent, is never written into the notebook, and is never remembered: a notebook shared with someone
 * runs in their memory, not on a path from your machine. Saving a notebook never touches a store.
 */
export function registerNotebookStoreCommands(context: vscode.ExtensionContext, sessions: NotebookSessions): void {
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  const refresh = (): void => {
    const notebook = notebookOf(undefined);
    const choice = notebook ? sessions.storeOf(notebook.uri.toString()) : undefined;
    void vscode.commands.executeCommand('setContext', HOLDS_CHANGES_CONTEXT, choice?.mode === 'manual');
    if (!notebook) return status.hide();
    status.text = `$(database) ${describeStore(choice)}`;
    status.tooltip = choice ? `${choice.location}\nClick to choose another store` : 'This notebook runs in memory. Click to choose a store file.';
    status.command = OPEN_STORE_COMMAND;
    status.show();
  };

  const modeOf = async (): Promise<StoreMode | undefined> => {
    const picked = await vscode.window.showQuickPick(
      [
        { label: 'Hold changes until I commit', description: 'safer: nothing is permanent until you choose Commit', mode: 'manual' as const },
        { label: 'Commit each statement', description: 'every successful statement is permanent at once', mode: 'auto' as const },
      ],
      { title: 'When should a write to this store become permanent?', placeHolder: 'Choose how this notebook\'s writes commit' },
    );
    return picked?.mode;
  };

  const askForStore = async (): Promise<StoreRequest | undefined> => {
    const source = await vscode.window.showQuickPick(
      [
        { label: 'Open an existing store file…', id: 'open' },
        { label: 'Create a new store file…', id: 'create' },
        { label: 'Use an in-memory store', description: 'a fresh, empty store; nothing is kept', id: 'memory' },
      ],
      { title: 'Store for this notebook' },
    );
    if (!source) return undefined;
    if (source.id === 'memory') return { kind: 'memory' };
    const target =
      source.id === 'open'
        ? (await vscode.window.showOpenDialog({ canSelectMany: false, canSelectFiles: true, canSelectFolders: false, filters: STORE_FILTERS, title: 'Open a TypeDBLite store' }))?.[0]
        : await vscode.window.showSaveDialog({ filters: STORE_FILTERS, title: 'Create a TypeDBLite store' });
    if (!target) return undefined;
    const mode = await modeOf();
    return mode ? { kind: 'file', location: target.fsPath, mode } : undefined;
  };

  context.subscriptions.push(
    status,
    sessions.onDidChangeStore(refresh),
    vscode.window.onDidChangeActiveNotebookEditor(refresh),
    vscode.workspace.onDidOpenNotebookDocument(refresh),

    vscode.commands.registerCommand(OPEN_STORE_COMMAND, async (arg?: Context, request?: StoreRequest) => {
      const notebook = notebookOf(arg);
      if (!notebook) return;
      const key = notebook.uri.toString();
      const chosen = request ?? (await askForStore());
      if (!chosen) return;
      // Switching ends the session, and what it held in memory or in an uncommitted transaction goes with it.
      if (!request && sessions.has(key)) {
        const yes = await vscode.window.showWarningMessage(
          'Switching the store ends this notebook\'s current session. What it holds in memory, or in a transaction you have not committed, is lost.',
          { modal: true },
          'Switch',
        );
        if (yes !== 'Switch') return;
      }
      try {
        await sessions.useStore(key, chosen.kind === 'memory' ? undefined : ({ location: chosen.location, mode: chosen.mode } satisfies StoreChoice));
      } catch (error) {
        void vscode.window.showErrorMessage(`The store could not be opened: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),

    ...([[COMMIT_COMMAND, 'commit', 'Committed.'], [ROLLBACK_COMMAND, 'rollback', 'Rolled back.']] as const).map(([command, action, done]) =>
      vscode.commands.registerCommand(command, async (arg?: Context) => {
        const notebook = notebookOf(arg);
        if (!notebook) return;
        const outcome = await sessions[action](notebook.uri.toString());
        if (outcome.kind === 'done') void vscode.window.setStatusBarMessage(`TypeQLite: ${done}`, 4000);
        else if (outcome.kind === 'refused') void vscode.window.showErrorMessage(`The commit was refused, and its changes were rolled back: ${outcome.message}`);
        else if (outcome.kind === 'not-manual') void vscode.window.showInformationMessage('This notebook commits each statement as it runs, so there is nothing to hold.');
        else void vscode.window.setStatusBarMessage('TypeQLite: this notebook has not run a cell yet', 4000);
      }),
    ),

    // The exports are of the notebook as the editor holds it, unsaved edits included. A second argument names the file,
    // so a script need not use the dialog.
    vscode.commands.registerCommand(EXPORT_SCRIPT_COMMAND, (arg?: Context, target?: vscode.Uri) => exportTo(arg, target, '.tql', 'TypeQLite scripts', (notebook) => exportScript(cellsOf(notebook)))),
    vscode.commands.registerCommand(EXPORT_MARKDOWN_COMMAND, (arg?: Context, target?: vscode.Uri) =>
      exportTo(arg, target, '.md', 'Markdown', (notebook) => exportMarkdown(cellsOf(notebook), typeof notebook.metadata?.['eol'] === 'string' ? (notebook.metadata['eol'] as string) : '\n')),
    ),
  );
  refresh();
}

async function exportTo(arg: Context, target: vscode.Uri | undefined, extension: string, filter: string, text: (notebook: vscode.NotebookDocument) => string): Promise<vscode.Uri | undefined> {
  const notebook = notebookOf(arg);
  if (!notebook) return undefined;
  const stem = notebook.uri.path.split('/').pop()!.replace(/\.tql\.md$|\.md$/i, '');
  const uri = target ?? (await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.joinPath(notebook.uri, '..', `${stem}${extension}`), filters: { [filter]: [extension.slice(1)] }, title: 'Export the notebook' }));
  if (!uri) return undefined;
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text(notebook)));
  return uri;
}
