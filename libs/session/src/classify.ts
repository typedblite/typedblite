/**
 * What a statement is, found from its text alone: the one classifier the CLI and the engine host share.
 *
 * 🔴 Classification is **textual, on the leading keyword**, and that is deliberate rather than lazy. The
 * interpreter already parses properly and rejects what it cannot run; duplicating a parse here to decide
 * which of its three methods to call would be a second, worse parser that can disagree with the real one.
 * This only has to answer "which method", and the interpreter has the final say on whether the text is
 * valid at all.
 */

/**
 * - `empty`: nothing but whitespace.
 * - `define`: a schema block, run by the interpreter's `define`.
 * - `read`: a pipeline with no write stage, run by `query`.
 * - `write`: anything else, run by `execute`.
 */
export type StatementKind = 'empty' | 'define' | 'read' | 'write';

/** Classify one statement. It never throws and never touches a store. */
export function classifyStatement(source: string): StatementKind {
  const text = source.trim();
  if (!text) return 'empty';
  if (/^define\b/i.test(text)) return 'define';
  return isRead(text) ? 'read' : 'write';
}

/**
 * A read is a pipeline with no write stage. 🔴 It used to be "a pipeline with `select`", so a bare `match`
 * went to `execute()`, which skips a pipeline with nothing to write and reports success: `(0 rows)` for
 * `match $x isa ganesh;` (`d-20260911-a-match-pipeline-with-no-select`). String literals are blanked first so
 * `has note "please insert this"` is not mistaken for a write.
 */
function isRead(text: string): boolean {
  // Both quote styles — `STRING` admits `'…'` since Phase 06 (review, round 1).
  const withoutStrings = text.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
  return !/\b(insert|delete|put|update)\b/i.test(withoutStrings);
}

/**
 * Split a source into statements a session can run one at a time.
 *
 * A pipeline may span lines and semicolons: `match $s isa project, has project-id "x";` followed by `insert …;`
 * is one pipeline, so splitting on `;` alone would tear every `match … insert` in half. A statement ends at a `;`
 * that is not followed by a stage keyword.
 *
 * @privateRemarks
 * 🔴 The rule is the same ordering the grammar encodes, where `match` is followed by an optional write and an
 * optional projection.
 */
export function splitStatements(source: string): string[] {
  const text = source.replace(/^\s*#[^\n]*$/gm, '');
  return statementBounds(text).map(([from, to]) => text.slice(from, to));
}

/** A statement of a source, as {@link locateStatements} finds it. */
export interface LocatedStatement {
  /** The statement as written, comments inside it kept: what to run. */
  readonly text: string;
  /** Where it starts in the source, both counted from 0, as an LSP position is. */
  readonly line: number;
  readonly character: number;
}

/**
 * The statements {@link splitStatements} finds, where they are: each one's text as written and its position, so a
 * range the engine reports for a statement can be placed in the file it came from.
 *
 * @privateRemarks
 * The same splitting loop, run over the source with each comment line blanked to spaces instead of removed, so every
 * offset is the source's own. A comment line is whitespace to the loop either way, so the statements are the same.
 */
export function locateStatements(source: string): LocatedStatement[] {
  const text = source.replace(/^[ \t]*#[^\n]*$/gm, (comment) => ' '.repeat(comment.length));
  return statementBounds(text).map(([from, to]) => {
    const before = source.slice(0, from);
    const line = before.split('\n').length - 1;
    return { text: source.slice(from, to), line, character: from - (before.lastIndexOf('\n') + 1) };
  });
}

/** Where each statement of a comment-free text starts and ends: `[from, to)`, with no surrounding whitespace. */
function statementBounds(text: string): Array<[number, number]> {
  const bounds: Array<[number, number]> = [];
  const trimmed = (from: number, to: number): [number, number] | undefined => {
    while (from < to && /\s/.test(text[from]!)) from += 1;
    while (to > from && /\s/.test(text[to - 1]!)) to -= 1;
    return from < to ? [from, to] : undefined;
  };
  let start = 0;

  for (let i = 0; i < text.length; i++) {
    if (text[i] !== ';') continue;
    const statement = text.slice(start, i + 1);
    const body = statement.trim();
    if (!body) {
      start = i + 1;
      continue;
    }
    const rest = text.slice(i + 1);

    // A `define` block holds many definitions, each `;`-terminated, so it ends only where a
    // pipeline begins — or at the end of the input.
    if (/^define\b/i.test(body)) {
      if (!/^\s*(match|insert|put|delete|update)\b/i.test(rest)) continue;
    } else if (/^match\b/i.test(body)) {
      // A `match` is `;`-separated patterns followed by a write and/or a projection, so its
      // internal semicolons are NOT terminators. The pipeline ends once its LAST stage has been
      // consumed — the stage order the grammar encodes: `match (write)? (select)? (reduce)?`. A
      // `select` followed by a `reduce` is not the end (Phase 06 review, round 4).
      if (!/\b(insert|put|delete|update|select|reduce|sort|offset|limit|distinct|require|fetch)\b/i.test(body)) continue;
      // A stage that only reshapes the stream — and a `fetch`, which ends it — continues the
      // pipeline it follows: `match …; select $x; sort $x; limit 1;` is one query.
      if (/^\s*(select|reduce|sort|offset|limit|distinct|require|fetch)\b/i.test(rest)) continue;
    }

    bounds.push(trimmed(start, i + 1)!);
    start = i + 1;
  }

  const tail = trimmed(start, text.length);
  if (tail) bounds.push(tail);
  return bounds;
}
