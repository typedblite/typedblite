/**
 * What a cell shows beneath it, as data: the notebook's own vocabulary, which `controller.ts` turns into VS Code's
 * output items. Pure, so every rule about what is shown is tested without an editor.
 */
export type OutputBlock =
  /** The rows of an answer. `total` is how many there were; `rows` is the page that is shown. */
  | { readonly kind: 'table'; readonly columns: readonly string[]; readonly rows: readonly (readonly string[])[]; readonly total: number }
  /** The documents of a `fetch`, as JSON. */
  | { readonly kind: 'json'; readonly documents: readonly unknown[] }
  /** The execution facts of a run (ADR-004): what it wrote, in the engine's own words. */
  | { readonly kind: 'facts'; readonly lines: readonly string[] }
  /** A statement that ran and answered nothing to show. */
  | { readonly kind: 'text'; readonly text: string }
  /** Which statement of a cell the outputs below belong to, when the cell has more than one. */
  | { readonly kind: 'heading'; readonly text: string }
  /** The engine, or the host, refused. `title` says who and why; `message` is the engine's own. */
  | { readonly kind: 'refusal'; readonly title: string; readonly message: string; readonly line?: number; readonly column?: number };

/** ASCII punctuation Markdown can give meaning to: a value is data, so every one is made literal. */
const MARKDOWN_SPECIAL = /[\\`*_{}[\]<>()#+\-.!|$~&]/g;

const cell = (value: string): string => value.replace(/\r\n|\r|\n/g, ' ').replace(MARKDOWN_SPECIAL, '\\$&');

/**
 * A table as Markdown, which the notebook's built-in renderer draws. A value is escaped so that nothing in an
 * answer, a `|`, a `$`, a `<script>`, can change the table or become markup.
 */
export function markdownTable(columns: readonly string[], rows: readonly (readonly string[])[]): string {
  const header = `| ${columns.map(cell).join(' | ')} |`;
  const rule = `| ${columns.map(() => '---').join(' | ')} |`;
  return [header, rule, ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`)].join('\n');
}

/** The same table for anything that shows text: columns padded, so it reads in a terminal-like output. */
export function plainTable(columns: readonly string[], rows: readonly (readonly string[])[]): string {
  const width = columns.map((name, i) => Math.max(name.length, ...rows.map((row) => (row[i] ?? '').length)));
  const line = (values: readonly string[]) => values.map((value, i) => value.padEnd(width[i]!)).join('  ').trimEnd();
  return [line(columns), line(width.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

/** "3 more rows are not shown" under a table that was cut: the count, never a silent cut (feature invariant 6). */
export const notShown = (block: Extract<OutputBlock, { kind: 'table' }>): string | undefined =>
  block.total > block.rows.length ? `${block.total - block.rows.length} more ${block.total - block.rows.length === 1 ? 'row is' : 'rows are'} not shown (${block.total} in all).` : undefined;
