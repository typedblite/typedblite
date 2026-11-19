import { newCodeCell, newMarkupCell, serializeNotebook, type Cell } from './format.js';

/** What an export needs of a cell: its kind and its text as the editor holds it now, edits and all. */
export interface ExportCell {
  readonly kind: 'markup' | 'code';
  readonly value: string;
}

/**
 * The notebook as a TypeQLite script (`.tql`): the code cells only, in order, one blank line between them. The
 * Markdown is left out, and so are the outputs. Each cell is the text as written, so the script reads as the notebook did.
 */
export function exportScript(cells: readonly ExportCell[]): string {
  const code = cells.filter((cell) => cell.kind === 'code' && cell.value.trim() !== '');
  return code.length === 0 ? '' : `${code.map((cell) => cell.value.replace(/\s+$/, '')).join('\n\n')}\n`;
}

/**
 * The notebook as plain Markdown: the prose as it is, and every code cell as a fenced `typeql` block, the spelling the
 * guides use, whatever fence the notebook file wrote. Outputs are not part of it.
 */
export function exportMarkdown(cells: readonly ExportCell[], eol = '\n'): string {
  const exported: Cell[] = cells.map((cell, i) => {
    const last = i === cells.length - 1;
    const made = cell.kind === 'code' ? newCodeCell(cell.value, eol) : newMarkupCell(cell.value, eol);
    // The last cell ends the file with one line ending, and no blank line after it.
    return last ? (made.kind === 'code' ? { ...made, gap: '' } : { ...made, post: eol }) : made;
  });
  return serializeNotebook({ head: '', eol, cells: exported });
}
