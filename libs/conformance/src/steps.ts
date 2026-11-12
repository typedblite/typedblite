import { DiagnosticCode, diagnosticOf, TypeDBLiteValue, type GivenRows } from '@typedblite/runtime';
import { orderedIdentify, rowKey, singleRowVariable, uniquelyIdentify } from './identify.js';
import type { SpecStep } from './spec.js';
import { EvaluatedNothing, HarnessError, World, type TransactionKind } from './world.js';
import type { JsonValue } from '@typedblite/runtime';

/**
 * The specification's step vocabulary, bound to TypeDBLite — what a driver's step definitions do.
 *
 * ⚠️ **Step meaning is TypeDB's.** Where a reading was not obvious the reference was the server's
 * own `tests/behaviour/` (typedb/typedb), not what would make TypeDBLite pass. Three readings worth
 * knowing:
 *
 * - `… fails` means the query threw. `… parsing fails` means it threw **at parse** — here, a
 *   diagnostic coded `parseFailed`. A validation refusal on a query TypeDB cannot parse is a fail.
 * - `… fails with a message containing: "X"` requires the thrown message to contain X. TypeDB's
 *   messages are TypeDB's; ours differ, and those scenarios fail until the message is matched. That
 *   is a real gap in drop-in terms — a caller matching on the message would break.
 * - `get answers of typeql write query` — TypeDB answers the written stream's rows, and so does
 *   `execute` (the write-answers phase); before that, no answer set was invented and the step failed.
 *
 * A step with no definition is not "pending": it fails its scenario and is reported by text, so
 * the first run's undefined list is the next phase's checklist.
 */
export interface StepDefinition {
  readonly pattern: RegExp;
  readonly run: (world: World, match: RegExpMatchArray, step: SpecStep) => void;
}

export class UndefinedStep extends Error {
  constructor(public readonly text: string) {
    super(`undefined step: ${text}`);
  }
}

const docString = (step: SpecStep): string => {
  if (step.docString === undefined) throw new HarnessError(`step '${step.text}' needs a doc string`);
  return step.docString;
};

const table = (step: SpecStep): ReadonlyArray<ReadonlyArray<string>> => {
  if (step.table === undefined) throw new HarnessError(`step '${step.text}' needs a table`);
  return step.table;
};

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Line and character of the first token in a query — past leading whitespace and `#` comments. */
const firstTokenPosition = (text: string): { line: number; character: number } => {
  const lines = text.split('\n');
  for (let line = 0; line < lines.length; line += 1) {
    const stripped = lines[line].replace(/#.*$/, '');
    const character = stripped.search(/\S/);
    if (character >= 0) return { line, character };
  }
  return { line: 0, character: 0 };
};

/**
 * A parse failure AT the first token means the parser does not know the statement — `redefine`,
 * `fun`, `fetch` — which is not the parse failure a scenario specifies. TypeDB's is inside a
 * statement it recognises; eleven `redefine` scenarios "passed" their `parsing fails` steps on
 * a grammar with no `redefine` before this check existed.
 */
const failedAtFirstToken = (thrown: unknown, text: string): boolean => {
  const start = diagnosticOf(thrown)?.range?.start;
  if (!start) return false;
  const first = firstTokenPosition(text);
  return start.line === first.line && start.character === first.character;
};

/** Run a query expecting it to throw; `containing` narrows what the message must say. */
const expectFailure = (
  attempt: () => void,
  mode: 'any' | 'parse' | 'containing',
  containing?: string,
  text?: string,
): void => {
  let thrown: unknown;
  try {
    attempt();
  } catch (error) {
    thrown = error;
  }
  if (thrown === undefined) throw new Error('expected the query to fail, and it succeeded');
  // 🔴 The engine running nothing is not it failing. Round 2 found the "evaluated nothing" guard
  // had turned `read query; fails` on a select-less match into a pass — the hollow pass, one step
  // over. It is refused here before any reading of the failure.
  if (thrown instanceof EvaluatedNothing) throw thrown;
  const parseFailure = diagnosticOf(thrown)?.code === DiagnosticCode.parseFailed;
  if (mode === 'parse' && !parseFailure) {
    throw new Error(`expected a parse failure, got: ${message(thrown)}`);
  }
  if (mode === 'parse' && text !== undefined && failedAtFirstToken(thrown, text)) {
    throw new Error(
      `the parser does not know this statement at all, which is not the parse failure the scenario specifies: ${message(thrown)}`,
    );
  }
  // 🔴 `fails` is not `parsing fails`. The spec keeps them apart, so a query that failed because
  // TypeDBLite could not parse it did not fail the way the scenario specifies — it failed before
  // reaching the behaviour under test. The first report card had three "passes" of this shape.
  if (mode !== 'parse' && parseFailure) {
    throw new Error(`the query failed to parse, which is not the failure the scenario specifies: ${message(thrown)}`);
  }
  // 🔴 And the engine refusing a stage it does not implement is the same species: the statement
  // parsed and TypeDB would have evaluated it. Phase 04 added `undefine` and `redefine` to the
  // grammar before the interpreter had them, and without this every `undefine …; fails` would
  // have passed on "not implemented" — 157 hollow passes.
  if (diagnosticOf(thrown)?.code === DiagnosticCode.notImplemented) {
    throw new Error(`the engine does not implement this statement, which is not the failure the scenario specifies: ${message(thrown)}`);
  }
  if (mode === 'containing' && !message(thrown).includes(containing ?? '')) {
    throw new Error(`expected a failure containing "${containing}", got: ${message(thrown)}`);
  }
};

const kindOf = (word: string): TransactionKind => word as TransactionKind;

const queryRunner = (world: World, kind: 'schema' | 'write' | 'read') => (text: string) => {
  if (kind === 'schema') world.schemaQuery(text);
  else if (kind === 'write') world.writeQuery(text);
  else world.readQuery(text);
};

export const STEPS: ReadonlyArray<StepDefinition> = [
  // ── connection and transaction — the protocol layer the harness stands in for ────────────────
  { pattern: /^typedb starts$/, run: () => undefined },
  { pattern: /^connection opens with default authentication$/, run: () => undefined },
  { pattern: /^connection is open: (true|false)$/, run: () => undefined },
  {
    pattern: /^connection has (\d+) databases?$/,
    run: (world, m) => {
      const expected = Number(m[1]);
      if (world.databaseCount() !== expected) {
        throw new Error(`expected ${expected} database(s), have ${world.databaseCount()}`);
      }
    },
  },
  { pattern: /^connection create database: ([\w-]+)$/, run: (world, m) => world.createDatabase(m[1]) },
  { pattern: /^connection reset database: ([\w-]+)$/, run: (world, m) => world.resetDatabase(m[1]) },
  {
    pattern: /^connection open (schema|write|read) transaction for database: ([\w-]+)$/,
    run: (world, m) => world.openTransaction(kindOf(m[1]), m[2]),
  },
  {
    pattern: /^transaction is open: (true|false)$/,
    run: (world, m) => {
      if (world.transactionIsOpen() !== (m[1] === 'true')) {
        throw new Error(`transaction open is ${world.transactionIsOpen()}`);
      }
    },
  },
  { pattern: /^transaction commits$/, run: (world) => world.commit() },
  {
    // Commit-time validation does not exist here; see `World`. Reported as a fail, never faked.
    pattern: /^transaction commits; fails(?: with a message containing: "(.*)")?$/,
    run: (world, m) => expectFailure(() => world.commit(), m[1] === undefined ? 'any' : 'containing', m[1]),
  },
  { pattern: /^transaction closes$/, run: (world) => world.closeTransaction() },
  { pattern: /^set time-zone: (\S+)$/, run: (world, m) => void (world.timeZone = m[1]) },

  // ── queries ────────────────────────────────────────────────────────────────────────────────────
  {
    pattern: /^typeql (schema|write|read) query$/,
    run: (world, m, step) => queryRunner(world, m[1] as 'schema' | 'write' | 'read')(docString(step)),
  },
  {
    pattern: /^typeql (schema|write|read) query; fails$/,
    run: (world, m, step) =>
      expectFailure(() => queryRunner(world, m[1] as 'schema' | 'write' | 'read')(docString(step)), 'any'),
  },
  {
    pattern: /^typeql (schema|write|read) query; parsing fails$/,
    run: (world, m, step) => {
      const text = docString(step);
      expectFailure(() => queryRunner(world, m[1] as 'schema' | 'write' | 'read')(text), 'parse', undefined, text);
    },
  },
  {
    pattern: /^typeql (schema|write|read) query; fails with a message containing: "(.*)"$/,
    run: (world, m, step) =>
      expectFailure(
        () => queryRunner(world, m[1] as 'schema' | 'write' | 'read')(docString(step)),
        'containing',
        m[2],
      ),
  },
  {
    pattern: /^get answers of typeql read query$/,
    run: (world, _m, step) => {
      const query = docString(step);
      const { rows, documents } = world.readAnswers(query);
      world.answers = { rows, documents, query, has: (iid, attribute) => world.attributesOf(iid, attribute), valueTypeOf: (attribute) => world.attributeValueType(attribute) };
    },
  },
  {
    // A write answers its stream as a read does — the rows its last stage left, or a document each
    // when it ends in `fetch`. The write must still have run: `writeQuery` refuses one that did not.
    pattern: /^get answers of typeql write query$/,
    run: (world, _m, step) => {
      const query = docString(step);
      const { rows, documents } = world.writeQuery(query);
      world.answers = { rows, documents, query, has: (iid, attribute) => world.attributesOf(iid, attribute), valueTypeOf: (attribute) => world.attributeValueType(attribute) };
    },
  },

  // ── given rows (given.feature) ──────────────────────────────────────────────────────────────
  {
    pattern: /^set query given rows$/,
    run: (world, _m, step) => void (world.givenRows = givenRows(table(step))),
  },
  {
    pattern: /^get answers of typeql (read|write) query with given rows$/,
    run: (world, m, step) => {
      const query = docString(step);
      const given = givenOf(world);
      const { rows, documents } = m[1] === 'read' ? world.readAnswers(query, given) : world.writeQuery(query, given);
      world.answers = { rows, documents, query, has: (iid, attribute) => world.attributesOf(iid, attribute), valueTypeOf: (attribute) => world.attributeValueType(attribute) };
    },
  },
  {
    pattern: /^typeql (read|write) query with given rows; fails with a message containing: "(.*)"$/,
    run: (world, m, step) => {
      const query = docString(step);
      const given = givenOf(world);
      expectFailure(() => void (m[1] === 'read' ? world.readAnswers(query, given) : world.writeQuery(query, given)), 'containing', m[2]);
    },
  },

  // ── answers ────────────────────────────────────────────────────────────────────────────────────
  {
    pattern: /^answer size is: (\d+)$/,
    run: (world, m) => {
      // A `fetch` answers documents, one per answer; anything else answers rows.
      const answers = answersOf(world);
      const rows = answers.documents?.length ?? answers.rows.length;
      if (rows !== Number(m[1])) throw new Error(`expected ${m[1]} answer(s), got ${rows}`);
    },
  },
  {
    pattern: /^uniquely identify answer concepts$/,
    run: (world, _m, step) => uniquelyIdentify(table(step), answersOf(world)),
  },
  {
    pattern: /^order of answer concepts is$/,
    run: (world, _m, step) => orderedIdentify(table(step), answersOf(world)),
  },
  {
    pattern: /^result is a single row with variable '([\w-]+)': (.+)$/,
    run: (world, m) => singleRowVariable(m[1], m[2], answersOf(world)),
  },
  {
    pattern: /^answers do not contain variable: ([\w-]+)$/,
    run: (world, m) => {
      if (answersOf(world).rows.some((row) => m[1] in row)) {
        throw new Error(`an answer contains variable '${m[1]}'`);
      }
    },
  },
  {
    pattern: /^verify answer set is equivalent for query$/,
    run: (world, _m, step) => {
      const first = new Set(answersOf(world).rows.map(rowKey));
      const second = new Set(world.readQuery(docString(step)).map(rowKey));
      if (first.size !== second.size || [...first].some((key) => !second.has(key))) {
        throw new Error(`answer sets differ: ${first.size} vs ${second.size} row(s)`);
      }
    },
  },
  {
    // `fetch` answers documents, compared with TypeDB's own equality — `jsonEqual`.
    pattern: /^answer (contains|does not contain) document:$/,
    run: (world, m, step) => {
      const { documents } = answersOf(world);
      // 🔴 "does not contain" is vacuously true of a read that answered rows — a false pass. A
      // document assertion needs documents.
      if (documents === undefined) throw new HarnessError('the query answered rows, not documents; a document assertion cannot be evaluated');
      const expected = JSON.parse(docString(step)) as JsonValue;
      const found = documents.some((document) => jsonEqual(document, expected));
      if (m[1] === 'contains' && !found) {
        throw new Error(`no answer is the document ${JSON.stringify(expected)}; answered: ${JSON.stringify(documents)}`);
      }
      if (m[1] === 'does not contain' && found) throw new Error(`an answer is the document ${JSON.stringify(expected)}`);
    },
  },
];

/**
 * TypeDB's own document equality — `jsons_equal_up_to_reorder` in `typedb/typedb`
 * `tests/behaviour/steps/util.rs`, read 2026-11-11 rather than guessed (ADR-005 D2):
 *
 * - a number is an f64, equal within an ABSOLUTE `1e-10` (`equals_approximate`) — so `$k - 100`
 *   answering `23.456789099999995` is the spec's `23.4567891`, as it is on TypeDB's own f64;
 * - a list is a multiset: same length, each item matched to an unused item, greedily as TypeDB does;
 * - an object's keys are unordered;
 * - strings, booleans and null are exact.
 */
const jsonEqual = (a: JsonValue, b: JsonValue): boolean => {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-10;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    const used = new Set<number>();
    return a.every((item) => {
      const index = b.findIndex((candidate, i) => !used.has(i) && jsonEqual(item, candidate));
      if (index < 0) return false;
      used.add(index);
      return true;
    });
  }
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => key in b && jsonEqual(a[key], b[key]));
};

const givenOf = (world: World): GivenRows => {
  if (world.givenRows === undefined) throw new HarnessError('no given rows — run `set query given rows` first');
  return world.givenRows;
};

/**
 * A given-rows table: the header names each variable (`n: string` — the type is the query's to
 * declare), a cell is `value:<type>:<text>` or `none` (absent). 🔴 A cell naming a TypeDB iid
 * (`iid:entity:0:1`) is TypeDB's own storage numbering; nothing here can resolve one, and inventing
 * a mapping would be guessing — the step fails instead.
 */
const givenRows = (rows: ReadonlyArray<ReadonlyArray<string>>): GivenRows => {
  const [header, ...body] = rows;
  const names = header.map((column) => column.split(':')[0].trim());
  return body.map((row) =>
    Object.fromEntries(
      row.map((cell, index) => {
        const text = cell.trim();
        if (text === 'none') return [names[index], null];
        const value = /^value:([\w-]+):(.*)$/.exec(text);
        if (value === null) throw new HarnessError(`a given cell '${text}' names no value this harness can pass — a TypeDB iid cannot be resolved here`);
        const [, type, raw] = value;
        return [names[index], TypeDBLiteValue.value(type, type === 'decimal' ? raw.replace(/dec$/, '') : raw)];
      }),
    ),
  );
};

const answersOf = (world: World) => {
  if (world.answers === undefined) throw new HarnessError('no answers — run `get answers of …` first');
  return world.answers;
};

export const findStep = (text: string): { definition: StepDefinition; match: RegExpMatchArray } => {
  for (const definition of STEPS) {
    const match = text.match(definition.pattern);
    if (match) return { definition, match };
  }
  throw new UndefinedStep(text);
};
