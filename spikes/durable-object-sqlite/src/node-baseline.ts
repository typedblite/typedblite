/**
 * SPIKE: the same programs on `node:sqlite`, in memory, as the reference the Durable Object is compared with.
 */
import { readFileSync } from 'node:fs';
import { TypeDBLiteInterpreter } from '@typedblite/runtime';
import { runProgram, type Engine, type RunResult } from '../../../apps/playground/src/run.js';
import { EXAMPLES } from '../../../apps/playground/src/examples.js';

export interface Program {
  readonly name: string;
  readonly source: string;
}

/**
 * The `typeql` code blocks of a notebook, in order, as one program. A notebook runs each cell on its own, so a cell
 * that writes or reads ends with `end;`: joined without it, the next cell would continue its pipeline.
 */
function notebookProgram(path: string): string {
  const text = readFileSync(path, 'utf8');
  return [...text.matchAll(/^```typeql\n([\s\S]*?)^```/gm)]
    .map((m) => m[1]!.trim())
    .map((cell) => (/^(define|redefine|undefine)\b/.test(cell) ? cell : `${cell}\nend;`))
    .join('\n\n');
}

export function programs(root: string): readonly Program[] {
  return [
    ...EXAMPLES.map((e) => ({ name: `playground: ${e.title}`, source: e.source })),
    { name: 'notebook: try-it.tql.md', source: notebookProgram(`${root}/docs/guides/try-it.tql.md`) },
    { name: 'notebook: five-minute-tour.tql.md', source: notebookProgram(`${root}/docs/guides/five-minute-tour.tql.md`) },
  ];
}

export function runOnNode(source: string): RunResult {
  return runProgram(source, () => new TypeDBLiteInterpreter(':memory:') as unknown as Engine);
}
