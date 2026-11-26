// The five-minute tour as data: one parser for the document, shared by everything that plays it (`tools/tour.mjs`, which
// runs the shell and Node steps from the packed tarballs; the notebook journey test; the VS Code e2e), so none of them can
// read the tour differently from another.
//
// The tour is a notebook (a Markdown file whose `typeql` fences are cells, ADR-012) with shell and Node steps between the
// cells. A block is classified by what it is, and what marks it:
//
//   a ```typeql fence                       a notebook CELL: its statements are run by the notebook's kernel
//   <!-- tour:expect [answer] -->  + ```text  what the cell above shows. `answer` leaves out the engine's execution facts
//   <!-- tour:store FILE [mode=auto] -->     (no block) the reader chooses FILE as the notebook's store, and runs the cells above again
//   <!-- tour:file NAME -->    + fence       a file the reader saves
//   <!-- tour:run [exit=N] --> + ```bash     a command the reader runs, expecting exit status N (default 0)
//   <!-- tour:output -->       + ```text     what the previous command printed
//
// Any other fenced block is PROSE: shown, never run. The structure test lists them, so a runnable-looking block cannot hide.

export const CELL_LANGUAGES = new Set(['typeql', 'typeqlite', 'tql']);

const MARKER = /^<!--\s*tour:(file|run|output|expect|store)\s*(.*?)\s*-->\s*$/;
const OPENING = /^(`{3,}|~{3,})(.*)$/;

/**
 * @typedef {{ kind: 'cell', source: string, line: number }
 *   | { kind: 'expect', text: string, answer: boolean, line: number }
 *   | { kind: 'store', file: string, mode: 'auto' | 'manual', line: number }
 *   | { kind: 'file', name: string, body: string, language: string, line: number }
 *   | { kind: 'run', body: string, exit: number, line: number }
 *   | { kind: 'output', body: string, line: number }
 *   | { kind: 'prose', language: string, body: string, line: number }} Step
 */

/** @returns {{ steps: Step[], problems: string[] }} The tour's steps in order, and what is wrong with how it is marked. */
export function parseTour(markdown) {
  const lines = markdown.split(/\r\n|\r|\n/);
  /** @type {Step[]} */
  const steps = [];
  const problems = [];
  /** @type {{ kind: string, arg: string, line: number } | undefined} */
  let pending;

  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i];
    const marker = MARKER.exec(text);
    if (marker) {
      if (pending) problems.push(`line ${pending.line}: tour:${pending.kind} is not followed by a fenced block`);
      pending = { kind: marker[1], arg: marker[2], line: i + 1 };
      if (pending.kind === 'store') {
        const [file, ...rest] = pending.arg.split(/\s+/).filter(Boolean);
        const mode = /mode=(auto|manual)/.exec(rest.join(' '))?.[1] ?? 'auto';
        if (!file) problems.push(`line ${pending.line}: tour:store needs a file name`);
        else steps.push({ kind: 'store', file, mode: /** @type {'auto' | 'manual'} */ (mode), line: pending.line });
        pending = undefined;
      }
      continue;
    }
    const opening = OPENING.exec(text);
    if (!opening) {
      // Only a blank line may sit between a marker and its block: anything else means the marker belongs to nothing.
      if (pending && text.trim() !== '') {
        problems.push(`line ${pending.line}: tour:${pending.kind} is not followed by a fenced block`);
        pending = undefined;
      }
      continue;
    }
    const fence = opening[1];
    const language = opening[2].trim().split(/\s+/)[0]?.toLowerCase() ?? '';
    const closing = new RegExp(`^${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`);
    const body = [];
    let j = i + 1;
    while (j < lines.length && !closing.test(lines[j])) body.push(lines[j++]);
    if (j >= lines.length) {
      problems.push(`line ${i + 1}: the fenced block is not closed`);
      break;
    }
    const joined = body.join('\n');
    const line = i + 1;
    if (pending) {
      const { kind, arg } = pending;
      pending = undefined;
      if (kind === 'file') steps.push({ kind, name: arg, body: joined, language, line });
      else if (kind === 'run') steps.push({ kind, body: joined, exit: Number(/exit=(\d+)/.exec(arg)?.[1] ?? 0), line });
      else if (kind === 'output') steps.push({ kind, body: joined, line });
      else if (kind === 'expect') steps.push({ kind, text: joined, answer: /\banswer\b/.test(arg), line });
    } else if (CELL_LANGUAGES.has(language)) {
      steps.push({ kind: 'cell', source: joined, line });
    } else {
      steps.push({ kind: 'prose', language, body: joined, line });
    }
    i = j;
  }
  if (pending) problems.push(`line ${pending.line}: tour:${pending.kind} is not followed by a fenced block`);
  return { steps, problems };
}

/**
 * What a command printed, without the warning Node 22 adds for `node:sqlite`, which Node 24 does not: the tour prints one
 * set of outputs for both, and says that Node 22 warns. Only that warning is dropped, and its one line of advice.
 */
export function withoutSqliteWarning(printed) {
  return printed.replace(/^\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature.*\r?\n(\(Use `node --trace-warnings.*\r?\n)?/gm, '');
}

/** The headings of the tour, in order, for the structure checks: [{ level, text, line }]. */
export function headingsOf(markdown) {
  const out = [];
  let fence;
  markdown.split(/\r\n|\r|\n/).forEach((text, i) => {
    const f = /^(`{3,}|~{3,})/.exec(text);
    if (f) fence = fence ? (text.startsWith(fence) ? undefined : fence) : f[1];
    const h = !fence && /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(text);
    if (h) out.push({ level: h[1].length, text: h[2], line: i + 1 });
  });
  return out;
}
