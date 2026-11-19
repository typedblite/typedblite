import { hasCode, type Diagnostic, type HostCaller, type Row, type RunResult } from './host-types.js';
import type { OutputBlock } from './outputs.js';

/** The part of a notebook's session the runner uses: one statement at a time, with the session kept between them. */
export interface StatementRunner {
  run(statement: string): Promise<{ readonly result: RunResult; /** The host's session was gone and a new one opened. */ readonly reopened: boolean }>;
}

export interface CellResult {
  readonly outputs: readonly OutputBlock[];
  /** A statement was refused, or the host could not answer. Later statements did not run. */
  readonly failed: boolean;
}

export interface RunCellOptions {
  /** How many rows of an answer are shown. The rest are counted, not dropped silently. */
  readonly maxRows: number;
  /** Checked between statements: a cell cannot be stopped inside one. */
  readonly cancelled?: () => boolean;
  /** What an engine that cannot answer is called to the reader: the extension's is a process, the browser's a worker. */
  readonly unavailableTitle?: string;
}

const TITLES: Record<string, string> = {
  engine: 'TypeQLite refused this statement',
  'no-schema': 'No schema yet',
  locked: 'The store is locked',
  closed: 'The session is closed',
  transaction: 'Transaction',
};

/**
 * Runs a cell: its source is split by the host into statements, which are run in order against the notebook's one
 * session, each answer shown in turn. It **stops at the first refusal**, and statements that ran before it stay
 * committed (ADR-012 N6), as `typedblite --file` behaves, so a cell can be reproduced by pasting it into the REPL.
 *
 * 🔴 Every statement is split and run by the host and by nothing else (feature invariant 1). This module defines
 * nothing of TypeQLite: it shows what the host answers.
 */
export async function runCell(source: string, host: HostCaller, session: StatementRunner, options: RunCellOptions): Promise<CellResult> {
  let statements: readonly string[];
  try {
    statements = (await host.call<{ statements: string[] }>('statement.split', { source })).statements;
  } catch (error) {
    return { outputs: [unavailable(error, options.unavailableTitle)], failed: true };
  }
  if (statements.length === 0) return { outputs: [{ kind: 'text', text: 'Nothing to run: this cell has no statement.' }], failed: false };

  const outputs: OutputBlock[] = [];
  let from = 0;
  for (const [index, statement] of statements.entries()) {
    if (options.cancelled?.()) {
      outputs.push({ kind: 'text', text: `Stopped before statement ${index + 1} of ${statements.length}.` });
      return { outputs, failed: false };
    }
    if (statements.length > 1) outputs.push({ kind: 'heading', text: `Statement ${index + 1} of ${statements.length}` });

    // Where the statement starts in the cell, for a refusal's location. The host split a copy with comment lines
    // removed, so a statement with a comment inside is not found, and its location is then left out.
    const start = source.indexOf(statement, from);
    if (start >= 0) from = start + statement.length;

    let answered: Awaited<ReturnType<StatementRunner['run']>>;
    try {
      answered = await session.run(statement);
    } catch (error) {
      outputs.push(unavailable(error, options.unavailableTitle));
      return { outputs, failed: true };
    }
    if (answered.reopened) {
      outputs.push({ kind: 'text', text: 'The engine host had stopped, so this notebook\'s session was opened again. What was held in memory, or in a transaction not yet committed, is gone.' });
    }
    const { result } = answered;

    if (result.kind === 'refused') {
      outputs.push(refusal(result, source, start));
      if (index > 0) outputs.push({ kind: 'text', text: `Stopped at statement ${index + 1} of ${statements.length}. The ${index === 1 ? 'statement' : `${index} statements`} before it stay${index === 1 ? 's' : ''} committed.` });
      return { outputs, failed: true };
    }
    outputs.push(...answer(result, options.maxRows));
  }
  return { outputs, failed: false };
}

/**
 * What one statement's result shows, outside a cell: its rows or documents and its facts, or its refusal (with no
 * location, since there is no cell to place it in). The debugger's console uses it.
 */
export function outputsOf(result: RunResult, maxRows: number): OutputBlock[] {
  return result.kind === 'refused' ? [refusal(result, '', -1)] : answer(result, maxRows);
}

/** The shown form of a statement that ran: its rows or documents, or a line saying it ran, then its execution facts. */
function answer(result: Exclude<RunResult, { kind: 'refused' }>, maxRows: number): OutputBlock[] {
  const blocks: OutputBlock[] = [];
  if (result.documents && result.documents.length > 0) blocks.push({ kind: 'json', documents: result.documents });
  else if (result.rows.length > 0) blocks.push(table(result.rows, maxRows));
  else if (result.kind === 'rows') blocks.push({ kind: 'text', text: '(no rows)' });
  else blocks.push({ kind: 'text', text: result.statement === 'define' ? 'Schema applied.' : 'OK.' });

  const facts = result.diagnostics.filter((d) => (d.severity ?? 3) >= 2).map((d) => (d.severity === 2 ? `warning: ${d.message}` : d.message));
  if (facts.length > 0) blocks.push({ kind: 'facts', lines: facts });
  return blocks;
}

function table(rows: readonly Row[], maxRows: number): OutputBlock {
  // The columns are the variables of the answer, in the order they first appear.
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const shown = rows.slice(0, Math.max(0, maxRows));
  return { kind: 'table', columns, rows: shown.map((row) => columns.map((column) => row[column] ?? '')), total: rows.length };
}

function refusal(result: Extract<RunResult, { kind: 'refused' }>, source: string, start: number): OutputBlock {
  const located = location(result.diagnostics, source, start);
  return { kind: 'refusal', title: TITLES[result.reason] ?? 'Refused', message: result.message, ...located };
}

/**
 * The 1-based line and column in the cell of the refusal's first diagnostic, whose range the host gives relative to the
 * statement. Nothing when the engine gave no range, or the statement is not found in the cell.
 */
function location(diagnostics: readonly Diagnostic[], source: string, start: number): { line?: number; column?: number } {
  const range = diagnostics.find((d) => d.severity === undefined || d.severity === 1)?.range;
  if (!range || start < 0) return {};
  const before = source.slice(0, start).split(/\r\n|\r|\n/);
  const startLine = before.length - 1;
  const startColumn = before[before.length - 1]!.length;
  return {
    line: startLine + range.start.line + 1,
    column: (range.start.line === 0 ? startColumn : 0) + range.start.character + 1,
  };
}

/** The host could not answer at all: no `node`, or the process died. Nothing was run. */
function unavailable(error: unknown, title = 'The engine host is not available'): OutputBlock {
  const message = error instanceof Error ? error.message : String(error);
  return { kind: 'refusal', title: hasCode(error, 'SESSION_NOT_FOUND') ? 'No session' : title, message };
}
