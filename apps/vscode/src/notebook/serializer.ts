import * as vscode from 'vscode';

import { CODE_CELL_LANGUAGE, MARKUP_CELL_LANGUAGE } from './constants.js';
import { newCodeCell, newMarkupCell, parseNotebook, serializeNotebook, type Cell, type CodeCell, type MarkupCell } from '@typedblite/notebook';

/**
 * Reads and writes a notebook file (ADR-012 N2): VS Code's notebook model over the pure format in `format.ts`.
 *
 * The bytes a cell does not show (its fence lines, the blank lines around it, the line endings) travel in the cell's
 * `metadata`, so a notebook opened and saved without a change is written back byte for byte. **Outputs are never
 * written**: the serializer has no field for them, and the type is registered with `transientOutputs`, so running a
 * cell does not mark the notebook changed (feature invariant 4).
 */
export class TypeQLiteNotebookSerializer implements vscode.NotebookSerializer {
  deserializeNotebook(content: Uint8Array): vscode.NotebookData {
    // `ignoreBOM`: keep a byte order mark in the text instead of dropping it, so saving does not remove it.
    const source = new TextDecoder('utf-8', { ignoreBOM: true }).decode(content);
    const notebook = parseNotebook(source);
    const data = new vscode.NotebookData(notebook.cells.map(cellData));
    data.metadata = { head: notebook.head, eol: notebook.eol };
    return data;
  }

  serializeNotebook(data: vscode.NotebookData): Uint8Array {
    const meta = data.metadata ?? {};
    const eol = typeof meta['eol'] === 'string' ? meta['eol'] : '\n';
    const cells = spaced(data.cells.map((cell) => cellOf(cell, eol)), data.cells.map((cell) => !hasMetadata(cell)), eol);
    return new TextEncoder().encode(serializeNotebook({ head: typeof meta['head'] === 'string' ? meta['head'] : '', eol, cells }));
  }
}

/** Whether the cell came from a file: a cell added in the editor has none of the fields that say how it was written. */
const hasMetadata = (cell: vscode.NotebookCellData): boolean => cell.metadata !== undefined && Object.keys(cell.metadata).length > 0;

/**
 * Spacing for the cells the editor added, which have defaults for a cell in the middle of a notebook. A new cell is
 * set off from the one before it by a blank line, even when that one was the last in the file and ended without one,
 * and a new last cell ends the file with one line ending and no blank line.
 */
function spaced(cells: Cell[], fresh: readonly boolean[], eol: string): Cell[] {
  const out = [...cells];
  fresh.forEach((isNew, i) => {
    const previous = out[i - 1];
    if (isNew && previous?.kind === 'code' && previous.gap === '') out[i - 1] = { ...previous, gap: eol };
    if (isNew && previous?.kind === 'markup' && previous.post.length <= eol.length) out[i - 1] = { ...previous, post: eol + eol };
  });
  const last = out[out.length - 1];
  if (last && fresh[out.length - 1]) out[out.length - 1] = last.kind === 'code' ? { ...last, gap: '' } : { ...last, post: eol };
  return out;
}

function cellData(cell: Cell): vscode.NotebookCellData {
  if (cell.kind === 'markup') {
    const data = new vscode.NotebookCellData(vscode.NotebookCellKind.Markup, cell.value, MARKUP_CELL_LANGUAGE);
    data.metadata = { post: cell.post };
    return data;
  }
  const data = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, cell.value, CODE_CELL_LANGUAGE);
  data.metadata = { open: cell.open, close: cell.close, tail: cell.tail, gap: cell.gap };
  return data;
}

const strings = <K extends string>(from: Record<string, unknown> | undefined, keys: readonly K[]): Partial<Record<K, string>> => {
  const out: Partial<Record<K, string>> = {};
  for (const key of keys) if (typeof from?.[key] === 'string') out[key] = from[key] as string;
  return out;
};

/**
 * A cell as the file has it. A cell added in the editor has no metadata, and gets the spelling the guides use. A cell
 * whose kind was changed keeps only the fields of its new kind, so a code cell turned into Markdown does not carry
 * its fence lines with it.
 */
function cellOf(cell: vscode.NotebookCellData, eol: string): Cell {
  if (cell.kind === vscode.NotebookCellKind.Markup) {
    return { ...newMarkupCell(cell.value, eol), ...strings(cell.metadata, ['post'] as const) } satisfies MarkupCell;
  }
  return { ...newCodeCell(cell.value, eol), ...strings(cell.metadata, ['open', 'close', 'tail', 'gap'] as const) } satisfies CodeCell;
}
