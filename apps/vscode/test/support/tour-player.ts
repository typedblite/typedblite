import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// @ts-expect-error -- a plain ES module with no declarations: the one parser every player of the tour shares.
import { parseTour, withoutSqliteWarning } from '../../../../tools/tour-doc.mjs';

/**
 * Plays the five-minute tour as a reader would, top to bottom, in ONE timeline (`docs/guides/five-minute-tour.tql.md`).
 *
 * The notebook's cells are run by a `Kernel` (the notebook's own engine code in the unit test, a real VS Code in the e2e),
 * and its shell steps by a real shell with the real command line, against the same files. So a cell sees what the command
 * line and the program wrote, and the program sees what a cell wrote: the tour's whole claim. Every answer the document prints
 * is compared with what ran, and the report says each place it is not what a reader would get.
 */

/** A piece of what a cell shows, already as plain text: the engine's facts apart, so an answer can be shown without them. */
export interface Piece {
  readonly kind: 'facts' | 'other';
  readonly text: string;
}

export interface Kernel {
  /** Run the n-th cell of the tour (counting only cells, from 0) and say what it shows. */
  run(source: string, index: number): Promise<Piece[]>;
  /** The reader chose a file as the notebook's store (the notebook then starts again on it). */
  useStore(location: string, mode: 'auto' | 'manual'): Promise<void>;
}

export interface Report {
  /** Every place the tour says something that did not happen. Empty means the tour is true. */
  readonly failures: string[];
  /** What each printed block would have to say to be true: the line of its opening fence, and the text. */
  readonly corrections: { line: number; body: string }[];
  readonly cells: number;
  readonly commands: number;
  readonly files: number;
}

type Step = { kind: string; line: number; [key: string]: unknown };

const trimEnds = (text: string): string => text.split('\n').map((line) => line.trimEnd()).join('\n').trim();

/** What a cell shows as text: its pieces a blank line apart, the facts left out for an `answer`. */
export const render = (pieces: readonly Piece[], answer: boolean): string =>
  pieces.filter((piece) => !answer || piece.kind !== 'facts').map((piece) => piece.text).join('\n\n');

/**
 * `typedblite` is the real command line from the workspace build, on PATH; `npm install @typedblite/runtime` is the
 * workspace's packages linked into `node_modules`. (`npm run tour` does the same from the packed tarballs, which is what
 * proves the packages install: here the point is the journey, with the notebook in it.)
 */
function shellFor(work: string, repo: string) {
  const project = join(work, 'readlist');
  const bin = join(work, 'bin');
  mkdirSync(project, { recursive: true });
  mkdirSync(bin, { recursive: true });
  const shim = join(bin, 'typedblite');
  writeFileSync(shim, `#!/usr/bin/env bash\nexec node ${JSON.stringify(join(repo, 'apps/cli/out/main.js'))} "$@"\n`);
  chmodSync(shim, 0o755);
  const link = (): void => {
    const scope = join(project, 'node_modules/@typedblite');
    mkdirSync(scope, { recursive: true });
    for (const [name, dir] of [['runtime', 'libs/runtime'], ['language', 'libs/language'], ['content-revision', 'libs/content-revision'], ['session', 'libs/session']] as const) {
      if (!existsSync(join(scope, name))) symlinkSync(join(repo, dir), join(scope, name), 'dir');
    }
  };
  // A reader's terminal, not the editor's: VS Code's extension host sets `FORCE_COLOR`, `ELECTRON_RUN_AS_NODE` and its own
  // `VSCODE_*` and `NODE_OPTIONS`, which would change what the commands print (Node warns when `FORCE_COLOR` and `NO_COLOR` meet).
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^(FORCE_COLOR|NO_COLOR|ELECTRON_RUN_AS_NODE|NODE_OPTIONS|VSCODE_.*|ELECTRON_.*)$/.test(name)),
  );
  const env = { ...inherited, PATH: `${bin}:${process.env['PATH']}`, NO_COLOR: '1', npm_config_update_notifier: 'false' };
  const swap = (command: string): string =>
    command.replace(/\bnpx typedblite\b/g, 'typedblite').replace(/^npm install @typedblite\/runtime$/m, () => (link(), 'true'));
  return { project, env, swap };
}

export async function playTour(markdown: string, kernel: Kernel, work: string, repo: string): Promise<Report> {
  const { steps, problems } = parseTour(markdown) as { steps: Step[]; problems: string[] };
  const failures = problems.map((problem) => `the tour is not marked up correctly: ${problem}`);
  const corrections: Report['corrections'] = [];
  const shell = shellFor(work, repo);

  /** Each cell of the tour, in order, with the answer the document prints under it, and what it last showed. */
  const cells: { source: string; line: number; printed?: { text: string; answer: boolean; line: number }; showed: Piece[] }[] = [];
  let lastCell: number | undefined;
  let lastRun: { printed: string } | undefined;
  let commands = 0;
  let files = 0;

  /** A block the document prints, held against what happened. `bodyLine` is where its text starts, for a correction. */
  const check = (what: string, line: number, inDocument: string, actual: string, bodyLine: number): void => {
    if (trimEnds(inDocument) === trimEnds(actual)) return;
    failures.push(`${what} (line ${line}) is not what a reader gets.\n--- the tour says\n${inDocument}\n--- it is\n${actual}`);
    corrections.push({ line: bodyLine, body: trimEnds(actual) });
  };

  for (const step of steps) {
    if (step.kind === 'cell') {
      const source = step['source'] as string;
      cells.push({ source, line: step.line, showed: await kernel.run(source, cells.length) });
      lastCell = cells.length - 1;
      lastRun = undefined;
    } else if (step.kind === 'expect') {
      const cell = lastCell === undefined ? undefined : cells[lastCell];
      if (!cell) {
        failures.push(`line ${step.line}: a tour:expect needs a cell before it`);
        continue;
      }
      cell.printed = { text: step['text'] as string, answer: step['answer'] as boolean, line: step.line };
      check(`The answer under the cell at line ${cell.line}`, step.line, cell.printed.text, render(cell.showed, cell.printed.answer), step.line + 1);
    } else if (step.kind === 'store') {
      await kernel.useStore(join(shell.project, step['file'] as string), step['mode'] as 'auto' | 'manual');
      // "Run the cells above again": the notebook starts again on the file, and answers as it did.
      for (const [index, cell] of cells.entries()) {
        cell.showed = await kernel.run(cell.source, index);
        if (cell.printed) check(`The answer under the cell at line ${cell.line}, run again on ${step['file']}`, cell.printed.line, cell.printed.text, render(cell.showed, cell.printed.answer), cell.printed.line + 1);
      }
    } else if (step.kind === 'file') {
      writeFileSync(join(shell.project, step['name'] as string), `${step['body'] as string}\n`);
      files += 1;
    } else if (step.kind === 'run') {
      const result = spawnSync('bash', ['-c', `{\n${shell.swap(step['body'] as string)}\n} 2>&1`], { cwd: shell.project, env: shell.env, encoding: 'utf8', timeout: 180_000 });
      commands += 1;
      const printed = withoutSqliteWarning(result.stdout ?? '') as string;
      if (result.error || result.status !== step['exit']) {
        failures.push(`The command at line ${step.line} exited ${result.status}, and the tour says ${step['exit']}.\n${step['body']}\n--- it printed\n${printed}`);
      }
      lastRun = { printed };
    } else if (step.kind === 'output') {
      if (!lastRun) {
        failures.push(`line ${step.line}: a tour:output needs a command before it`);
        continue;
      }
      check(`The output under the command before line ${step.line}`, step.line, step['body'] as string, lastRun.printed, step.line + 1);
      lastRun = undefined;
    }
  }
  return { failures, corrections, cells: cells.length, commands, files };
}

/** The document with every printed block made true: `TOUR_RECORD=1`, for the author after a deliberate change. */
export function recorded(markdown: string, corrections: Report['corrections']): string {
  const lines = markdown.split('\n');
  // From the bottom up, so a block that grows or shrinks does not move the ones above it.
  for (const { line, body } of [...corrections].sort((a, b) => b.line - a.line)) {
    const start = line - 1;
    let end = start;
    while (end < lines.length && !/^```\s*$/.test(lines[end]!)) end += 1;
    lines.splice(start, end - start, ...(body === '' ? [] : body.split('\n')));
  }
  return lines.join('\n');
}

export const readTour = (repo: string): string => readFileSync(join(repo, 'docs/guides/five-minute-tour.tql.md'), 'utf8');
