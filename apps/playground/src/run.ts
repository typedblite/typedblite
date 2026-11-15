import { EmptyFileSystem } from 'langium';
import {
  createTypeQLiteServices,
  isDefineClause,
  isDeleteStage,
  isInsertStage,
  isPipeline,
  isPutStage,
  isRedefineClause,
  isUndefineClause,
  isUpdateStage,
  type TypeQLiteFile,
} from '@typedblite/language';
import { diagnosticOf } from '@typedblite/runtime';

/**
 * Run a TypeQLite program, statement by statement, against a fresh engine, and describe what happened
 * as plain data a page can draw.
 *
 * The playground runs this in a Web Worker on WASM SQLite. The tests run the same function on
 * `node:sqlite`, which is the point of a function over an `Engine` rather than over a binding.
 */

/** LSP 3.18 made a diagnostic's message a string or markup. The engine writes strings; markup is read too. */
type Message = string | { readonly value: string };
const textOf = (message: Message): string => (typeof message === 'string' ? message : message.value);

/** The part of `TypeDBLiteInterpreter` the playground uses. The interpreter satisfies it as it is. */
export interface Engine {
  readonly hasSchema: boolean;
  define(text: string): { readonly diagnostics: readonly { readonly message: Message }[] };
  execute(text: string): Answer;
  query(text: string): Answer;
  close(): void;
}

interface Answer {
  readonly rows: ReadonlyArray<Record<string, { toString(): string }>>;
  readonly documents?: ReadonlyArray<unknown>;
  readonly diagnostics: readonly { readonly message: Message }[];
}

export type StepKind = 'define' | 'write' | 'read';

export interface ProgramError {
  readonly message: string;
  /** 1-based line in the editor's text, when the error can be placed. */
  readonly line?: number;
}

export interface Step {
  readonly kind: StepKind;
  /** 1-based line where the statement starts. */
  readonly line: number;
  readonly text: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
  /** Rows the answer had beyond `MAX_ROWS`, not drawn. */
  readonly omitted: number;
  /** One pretty-printed JSON document per answer, for a `fetch`. */
  readonly documents: readonly string[];
  /** Facts the engine reported: what was written, why an answer was empty. */
  readonly notes: readonly string[];
  readonly error?: ProgramError;
}

export interface RunResult {
  readonly steps: readonly Step[];
  /** The program as a whole could not be read, so nothing ran. */
  readonly error?: ProgramError;
}

/** A page that draws a million rows is a page that stops. The rest are counted, not drawn. */
export const MAX_ROWS = 1_000;

type Clause = { readonly kind: StepKind; readonly text: string; readonly line: number };

let services: ReturnType<typeof createTypeQLiteServices> | undefined;

const lineAt = (source: string, offset: number): number => {
  let line = 1;
  for (let i = 0; i < offset; i += 1) if (source.charCodeAt(i) === 10) line += 1;
  return line;
};

/**
 * Split a program into its statements, with the language library's own parser.
 *
 * 🔴 The parser, not a regular expression. A `define` block holds many `;`-terminated definitions and a
 * `match` pipeline holds `;`-separated patterns, so a statement does not end at the first `;`. The CLI
 * splits by heuristic (`splitStatements`) because it must keep working on text a user is still typing;
 * the playground has the whole program, so it asks the grammar. A program with a syntax error anywhere
 * runs nothing, rather than applying half a schema.
 */
export function parseProgram(source: string): { readonly clauses: readonly Clause[] } | { readonly error: ProgramError } {
  services ??= createTypeQLiteServices(EmptyFileSystem);
  const parsed = services.TypeQLite.parser.LangiumParser.parse<TypeQLiteFile>(source);
  const lexical = parsed.lexerErrors[0];
  const syntactic = parsed.parserErrors[0];
  if (lexical || syntactic) {
    // 🔴 Neither error carries a usable line of its own where it matters. A lexer error's `line` is -1,
    // so its line comes from its offset. A parser error at the END of the input (a statement missing
    // its `;`) has a token with no position at all, so it is placed where the last real token ended.
    // `previousToken` is on the exceptions Chevrotain raises for a missing or unexpected token, and is
    // not declared on its base type.
    const before = (syntactic as { previousToken?: { endLine?: number } } | undefined)?.previousToken?.endLine;
    const at = syntactic?.token.startLine;
    const line = lexical ? lineAt(source, lexical.offset) : at !== undefined && at > 0 ? at : before;
    return { error: { message: (lexical ?? syntactic)!.message, ...(typeof line === 'number' && line > 0 ? { line } : {}) } };
  }
  const clauses: Clause[] = [];
  for (const clause of parsed.value.clauses) {
    const node = clause.$cstNode;
    if (!node) continue;
    const kind: StepKind =
      isDefineClause(clause) || isUndefineClause(clause) || isRedefineClause(clause)
        ? 'define'
        : isPipeline(clause) && clause.stages.some((s) => isInsertStage(s) || isPutStage(s) || isDeleteStage(s) || isUpdateStage(s))
          ? 'write'
          : 'read';
    clauses.push({ kind, text: node.text, line: lineAt(source, node.offset) });
  }
  return { clauses };
}

function render(kind: StepKind, clause: Clause, answer: Answer | undefined, notes: readonly string[]): Step {
  const rows = answer?.rows ?? [];
  const columns: string[] = [];
  for (const row of rows) for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key);
  const shown = rows.slice(0, MAX_ROWS).map((row) => columns.map((column) => row[column]?.toString() ?? ''));
  return {
    kind,
    line: clause.line,
    text: clause.text,
    columns,
    rows: shown,
    omitted: Math.max(0, rows.length - MAX_ROWS),
    documents: (answer?.documents ?? []).map((document) => JSON.stringify(document, null, 2)),
    notes,
  };
}

function runClause(db: Engine, clause: Clause): Step {
  const failed = (message: string, line?: number): Step => ({
    ...render(clause.kind, clause, undefined, []),
    error: { message, ...(line === undefined ? {} : { line }) },
  });
  // Mirrors the CLI: without a schema the engine would say `no such table: thing`, which is an
  // internal leaking through as if it were a TypeQLite error.
  if (clause.kind !== 'define' && !db.hasSchema) {
    return failed('No schema has been applied yet. Run a `define` first.', clause.line);
  }
  try {
    const answer: Answer =
      clause.kind === 'define'
        ? { rows: [], diagnostics: db.define(clause.text).diagnostics }
        : clause.kind === 'write'
          ? db.execute(clause.text)
          : db.query(clause.text);
    return render(clause.kind, clause, answer, answer.diagnostics.map((d) => textOf(d.message)));
  } catch (error) {
    // The diagnostic's range is inside this statement; the editor wants a line in the whole program.
    const start = diagnosticOf(error)?.range.start;
    const line = start === undefined ? clause.line : clause.line + start.line;
    return failed(error instanceof Error ? error.message : String(error), line);
  }
}

/**
 * Run `source` against the engine `open` returns, closing it afterwards. Stops at the first statement
 * that fails, and reports it with the line it is on.
 */
export function runProgram(source: string, open: () => Engine): RunResult {
  const program = parseProgram(source);
  if ('error' in program) return { steps: [], error: program.error };
  const db = open();
  try {
    const steps: Step[] = [];
    for (const clause of program.clauses) {
      const step = runClause(db, clause);
      steps.push(step);
      if (step.error) break;
    }
    return { steps };
  } finally {
    db.close();
  }
}
