import * as vscode from 'vscode';

import { markdownTable, notShown, plainTable, type OutputBlock } from '@typedblite/notebook';

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
