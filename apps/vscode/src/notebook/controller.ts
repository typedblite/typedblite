import * as vscode from 'vscode';

import { runCell, type CellResult } from './cell-runner.js';
import { NOTEBOOK_TYPE, NOTEBOOK_TYPE_MARKDOWN } from './constants.js';
import type { HostCaller } from './host-types.js';
import type { NotebookSessions } from './notebook-sessions.js';
import { markdownTable, notShown, plainTable, type OutputBlock } from './outputs.js';

/** The command that ends a notebook's store and opens it again (ADR-012 N3: restart is `session.restart`). */
export const RESTART_COMMAND = 'typedblite.notebook.restart';

/** The setting that says how many rows of an answer a cell shows. */
export const MAX_ROWS_SETTING = 'typedblite.notebook.maxRows';
export const DEFAULT_MAX_ROWS = 1000;

const NOTEBOOK_TYPES = [NOTEBOOK_TYPE, NOTEBOOK_TYPE_MARKDOWN] as const;

/** An output block as VS Code's output items: built-in MIME types only, so no renderer of our own is needed. */
export function toCellOutput(block: OutputBlock): vscode.NotebookCellOutput {
  const { NotebookCellOutput, NotebookCellOutputItem } = vscode;
  switch (block.kind) {
    case 'table': {
      const cut = notShown(block);
      const markdown = markdownTable(block.columns, block.rows) + (cut ? `\n\n_${cut}_` : '');
      const plain = plainTable(block.columns, block.rows) + (cut ? `\n\n${cut}` : '');
      // The richest the output area can draw comes first, the plain table for anything that cannot.
      return new NotebookCellOutput([NotebookCellOutputItem.text(markdown, 'text/markdown'), NotebookCellOutputItem.text(plain)]);
    }
    case 'json':
      return new NotebookCellOutput([NotebookCellOutputItem.json(block.documents.length === 1 ? block.documents[0] : block.documents)]);
    case 'facts':
      return new NotebookCellOutput([NotebookCellOutputItem.stdout(`${block.lines.join('\n')}\n`)]);
    case 'text':
      return new NotebookCellOutput([NotebookCellOutputItem.text(block.text)]);
    case 'heading':
      return new NotebookCellOutput([NotebookCellOutputItem.text(`**${block.text}**`, 'text/markdown'), NotebookCellOutputItem.text(block.text)]);
    case 'refusal': {
      const where = block.line === undefined ? '' : ` (line ${block.line}, column ${block.column})`;
      const error = new Error(`${block.message}${where}`);
      error.name = block.title;
      error.stack = '';
      return new NotebookCellOutput([NotebookCellOutputItem.error(error)]);
    }
  }
}

const maxRows = (): number => {
  const configured = vscode.workspace.getConfiguration().get<number>(MAX_ROWS_SETTING, DEFAULT_MAX_ROWS);
  return Number.isFinite(configured) && configured >= 1 ? Math.floor(configured) : DEFAULT_MAX_ROWS;
};

/**
 * The kernel (ADR-012 N3): a controller for each notebook type, whose cells are run by the engine host.
 *
 * VS Code's own "Run All", "Run Above" and "Run Below" call the same handler with the cells they mean, in order, so
 * none of them needs code here. A cell that is refused ends the run: the cells after it are not started.
 */
export function registerNotebookControllers(context: vscode.ExtensionContext, host: HostCaller, sessions: NotebookSessions): void {
  let order = 0;
  for (const type of NOTEBOOK_TYPES) {
    const controller = vscode.notebooks.createNotebookController(`${type}-controller`, type, 'TypeQLite');
    controller.supportedLanguages = ['typeqlite'];
    controller.supportsExecutionOrder = true;
    controller.description = 'In-memory store';
    controller.executeHandler = async (cells, notebook) => {
      const runner = sessions.runnerFor(notebook.uri.toString());
      for (const cell of cells) {
        const execution = controller.createNotebookCellExecution(cell);
        execution.executionOrder = (order += 1);
        execution.start(Date.now());
        await execution.clearOutput();
        let result: CellResult;
        try {
          result = await runCell(cell.document.getText(), host, runner, { maxRows: maxRows(), cancelled: () => execution.token.isCancellationRequested });
        } catch (error) {
          // `runCell` answers its failures as outputs; this is a bug in it, and the cell says so instead of hanging.
          result = { outputs: [{ kind: 'refusal', title: 'The notebook failed', message: error instanceof Error ? error.message : String(error) }], failed: true };
        }
        await execution.replaceOutput(result.outputs.map(toCellOutput));
        execution.end(!result.failed, Date.now());
        if (result.failed) break;
      }
    };
    // Preferred, so the kernel is chosen for the user the first time they run a cell.
    const prefer = (notebook: vscode.NotebookDocument) => {
      if (notebook.notebookType === type) controller.updateNotebookAffinity(notebook, vscode.NotebookControllerAffinity.Preferred);
    };
    vscode.workspace.notebookDocuments.forEach(prefer);
    context.subscriptions.push(controller, vscode.workspace.onDidOpenNotebookDocument(prefer));
  }

  context.subscriptions.push(
    // A closed notebook releases its store.
    vscode.workspace.onDidCloseNotebookDocument((notebook) => {
      if ((NOTEBOOK_TYPES as readonly string[]).includes(notebook.notebookType)) void sessions.close(notebook.uri.toString());
    }),
    // From the toolbar the argument is the editor's, from the palette there is none: the active notebook.
    vscode.commands.registerCommand(RESTART_COMMAND, async (arg?: { notebookEditor?: { notebookUri: vscode.Uri } }) => {
      const uri = arg?.notebookEditor?.notebookUri ?? vscode.window.activeNotebookEditor?.notebook.uri;
      if (!uri) return;
      const done = await sessions.restart(uri.toString());
      void vscode.window.setStatusBarMessage(done === 'restarted' ? 'TypeQLite: the notebook\'s store was restarted' : 'TypeQLite: this notebook has not run a cell yet', 4000);
    }),
  );
}
