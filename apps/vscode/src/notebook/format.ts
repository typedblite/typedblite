import { FENCE_LANGUAGES, fenceLanguage } from '../markdown/protocol.js';

/**
 * The notebook file format (ADR-012 N2): a Markdown file in which each top-level fenced `typeql` block is a code
 * cell, and the text between them is a Markdown cell.
 *
 * This module is pure: text in, a model out, and back. It knows nothing of VS Code or of TypeQLite beyond which fence
 * languages are TypeQLite (the same set the Markdown preview highlights, ADR-010).
 *
 * 🔴 **Parse then serialize is the identity.** Every byte of the file belongs to exactly one field of the model: a
 * cell's text, the fence lines around it, the blank lines between cells, or the line endings. So opening a notebook and
 * saving it without a change writes the same bytes, and an edit to one cell changes only that cell's lines. That is
 * what makes the file diff like prose (feature invariant 4).
 *
 * Which fences are cells follows CommonMark for what it can see at the top level of the document: a fence indented
 * more than three spaces is not one, a closing fence needs the same character and at least as many of it, and an
 * unclosed fence runs to the end of the file. A fence inside another fenced block, inside a block quote, or indented
 * (so, in a list) is Markdown text, not a cell. `test/notebook-format.test.ts` checks the cells against the Markdown
 * engine the preview uses, over every Markdown file in the repository.
 */

/**
 * A run of Markdown. `post` is what follows `value`: its last line ending, and the blank lines before the next fence.
 * Blank lines always belong to the cell before them (or to the head of the file), never to the one after, so a cell
 * inserted between two others takes its own spacing and leaves theirs alone.
 */
export interface MarkupCell {
  readonly kind: 'markup';
  readonly value: string;
  readonly post: string;
}

/**
 * A fenced TypeQLite block. `open` and `close` are the fence lines exactly as written (`close` is empty for an
 * unclosed fence), `tail` is the line ending of the last line of `value`, and `gap` is the blank lines between this
 * cell and the next, which are not a Markdown cell of their own.
 */
export interface CodeCell {
  readonly kind: 'code';
  readonly value: string;
  readonly open: string;
  readonly close: string;
  readonly tail: string;
  readonly gap: string;
}

export type Cell = MarkupCell | CodeCell;

export interface Notebook {
  /** Blank lines before the first cell. A file with no cells is all `head`. */
  readonly head: string;
  /** The line ending new text is written with: the first one found in the file. */
  readonly eol: string;
  readonly cells: readonly Cell[];
}

const OPENING = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const BLANK = /^[ \t]*$/;

/** A line, and the line ending it was cut at (empty on the last line of a file with no final newline). */
interface Line {
  readonly text: string;
  readonly eol: string;
  readonly raw: string;
}

function linesOf(source: string): Line[] {
  const lines: Line[] = [];
  const pattern = /([^\r\n]*)(\r\n|\r|\n)|([^\r\n]+)$/gy;
  let match: RegExpExecArray | null;
  while (pattern.lastIndex < source.length && (match = pattern.exec(source)) !== null) {
    const text = match[1] ?? match[3] ?? '';
    const eol = match[2] ?? '';
    lines.push({ text, eol, raw: text + eol });
  }
  return lines;
}

/** The index of the line that closes a fence opened at `from`, or `lines.length` when it is never closed. */
function closingFence(lines: readonly Line[], from: number, character: string, length: number): number {
  const closing = new RegExp(`^ {0,3}${character === '`' ? '`' : '~'}{${length},}[ \\t]*$`);
  for (let i = from + 1; i < lines.length; i += 1) if (closing.test(lines[i]!.text)) return i;
  return lines.length;
}

/** The first line ending in a file, so new text matches it. */
const eolOf = (source: string): string => /\r\n|\r|\n/.exec(source)?.[0] ?? '\n';

/**
 * Splits a run of Markdown lines into the blank lines that lead it, and a cell: the text from the first to the last
 * non-blank line (`value`, without its last line ending) and what follows it (`post`). A run that is only blank lines
 * has no cell.
 */
function markupCell(lines: readonly Line[]): { lead: string; cell?: MarkupCell } {
  let first = 0;
  while (first < lines.length && BLANK.test(lines[first]!.text)) first += 1;
  const lead = lines.slice(0, first).map((l) => l.raw).join('');
  if (first === lines.length) return { lead };
  let last = lines.length - 1;
  while (BLANK.test(lines[last]!.text)) last -= 1;
  const body = lines.slice(first, last + 1).map((l) => l.raw).join('');
  const end = lines[last]!.eol;
  return { lead, cell: { kind: 'markup', value: body.slice(0, body.length - end.length), post: end + lines.slice(last + 1).map((l) => l.raw).join('') } };
}

export function parseNotebook(source: string): Notebook {
  const lines = linesOf(source);
  const eol = eolOf(source);
  const cells: Cell[] = [];
  let head = '';
  let pending: Line[] = [];

  /** Ends the run of Markdown collected so far. Its leading blank lines go to the cell before it. */
  const flush = (): void => {
    if (pending.length === 0) return;
    const { lead, cell } = markupCell(pending);
    pending = [];
    const previous = cells[cells.length - 1];
    if (previous?.kind === 'code') cells[cells.length - 1] = { ...previous, gap: previous.gap + lead };
    else head += lead;
    if (cell) cells.push(cell);
  };

  let i = 0;
  while (i < lines.length) {
    const opening = OPENING.exec(lines[i]!.text);
    const fence = opening && !(opening[2]![0] === '`' && opening[3]!.includes('`')) ? opening : null;
    if (!fence) {
      pending.push(lines[i]!);
      i += 1;
      continue;
    }
    const close = closingFence(lines, i, fence[2]![0]!, fence[2]!.length);
    const info = fence[3]!.trim();
    // A cell is a top-level fence with a TypeQLite language. An indented fence is not one (it is in a list, or a
    // quote's lazy continuation), and neither is any other language's: its lines are Markdown, and it is skipped whole,
    // so a `typeql` fence shown inside a `markdown` fence stays text.
    if (fence[1]!.length === 0 && info !== '' && FENCE_LANGUAGES.has(fenceLanguage(info))) {
      flush();
      const body = lines.slice(i + 1, close);
      const last = body[body.length - 1];
      const joined = body.map((l) => l.raw).join('');
      cells.push({
        kind: 'code',
        value: last ? joined.slice(0, joined.length - last.eol.length) : '',
        open: lines[i]!.raw,
        close: close < lines.length ? lines[close]!.raw : '',
        tail: last?.eol ?? '',
        gap: '',
      });
      i = close + 1;
      continue;
    }
    for (let j = i; j <= Math.min(close, lines.length - 1); j += 1) pending.push(lines[j]!);
    i = close + 1;
  }
  flush();
  return { head, eol, cells };
}

/** The fence characters of an opening line: `   ```typeql x` → the character, its count, and the rest. */
function fenceParts(open: string): { indent: string; character: string; length: number; rest: string } | undefined {
  const match = /^( {0,3})(`{3,}|~{3,})([^\r\n]*)/.exec(open);
  return match ? { indent: match[1]!, character: match[2]![0]!, length: match[2]!.length, rest: match[3]! } : undefined;
}

const endOf = (line: string): string => /(\r\n|\r|\n)$/.exec(line)?.[1] ?? '';

/**
 * The fence lines for a code cell's value. A value that holds a line which would close the fence (three backticks on
 * their own) would end the cell early the next time the file is read, so the fence is made one longer than any run
 * of fence characters at the start of a line of the value. Left as written when it already is long enough.
 */
function fencesFor(cell: CodeCell, eol: string, last: boolean): { open: string; close: string } {
  const parts = fenceParts(cell.open) ?? { indent: '', character: '`', length: 3, rest: 'typeql' };
  const character = parts.character === '`' ? '`' : '~';
  let longest = 0;
  for (const line of cell.value.split(/\r\n|\r|\n/)) {
    const run = new RegExp(`^ {0,3}(${character}{3,})[ \\t]*$`).exec(line);
    if (run) longest = Math.max(longest, run[1]!.length);
  }
  const length = Math.max(parts.length, longest + 1);
  const grown = length !== parts.length;
  const open = grown ? `${parts.indent}${character.repeat(length)}${parts.rest}${endOf(cell.open) || eol}` : cell.open;
  // A fence with no closing line runs to the end of the file, so it can only stay open at the end of it. Another
  // cell after it needs the fence closed, or that cell would be written inside it.
  if (cell.close === '') return { open, close: last ? '' : `${character.repeat(length)}${eol}` };
  return { open, close: grown ? `${character.repeat(length)}${endOf(cell.close)}` : cell.close };
}

export function serializeNotebook(notebook: Notebook): string {
  let out = notebook.head;
  const startLine = (): void => {
    // A cell starts a line, and the text before it may have lost its line ending (an edit at the end of the file).
    if (out !== '' && !/[\r\n]$/.test(out)) out += notebook.eol;
  };
  notebook.cells.forEach((cell, index) => {
    startLine();
    if (cell.kind === 'markup') {
      out += cell.value + cell.post;
      return;
    }
    const { open, close } = fencesFor(cell, notebook.eol, index === notebook.cells.length - 1);
    out += open + cell.value + cell.tail + close + cell.gap;
  });
  return out;
}

/** A new Markdown cell, written the way the file is: blank line after it, so the next cell starts a paragraph. */
export const newMarkupCell = (value: string, eol: string): MarkupCell => ({ kind: 'markup', value, post: eol + eol });

/** A new TypeQLite cell: a `typeql` fence, the spelling the guides use, and a blank line after it. */
export const newCodeCell = (value: string, eol: string): CodeCell => ({ kind: 'code', value, open: `\`\`\`typeql${eol}`, close: `\`\`\`${eol}`, tail: eol, gap: eol });
