import { afterEach, beforeEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TypeDBLiteInterpreter } from '../src/interpreter.js';
import { SEP } from '../src/schema-subjects.js';

/**
 * The annotation record — every annotation an applied schema carries, per subject — and the
 * `plays` record. Phase 04 of the conformance feature writes them because `undefine @card from
 * person owns name` and `redefine`'s "nothing was redefined" have to know what is there.
 *
 * 🔴 Recording is not enforcing: `@card` is still reported as parsed and not enforced. And the
 * record is the schema itself — a restatement writes the same row, so nothing here asks "was
 * this already so"; Phase 03's summary records why that question is the one to avoid.
 */
const SCHEMA = [
  'define',
  'attribute ref value integer;',
  'attribute name value string @regex("^.*$");',
  'entity person @abstract, owns ref @key, owns name @card(0..2), plays employment:employee @card(0..1);',
  'entity child sub person @doc("a child");',
  'relation employment relates employee @card(1..), plays income:source;',
  'relation income relates source;',
].join('\n');

const rows = (path: string, sql: string): unknown[] => {
  const raw = new DatabaseSync(path);
  try {
    return raw.prepare(sql).all();
  } finally {
    raw.close();
  }
};

const slashed = (subject: string): string => subject.split(SEP).join('/');

describe('the schema record', () => {
  let directory: string;
  let path: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'typedblite-record-'));
    path = join(directory, 'db.sqlite');
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it('writes every annotation per subject, and every plays', () => {
    const engine = new TypeDBLiteInterpreter(path);
    engine.define(SCHEMA);
    engine.close();
    const annotations = rows(path, 'SELECT subject, category, text FROM schema_annotation ORDER BY subject, category') as Array<{ subject: string; category: string; text: string }>;
    assert.deepEqual(
      annotations.map((r) => [slashed(r.subject), r.category, r.text]),
      [
        ['child/sub', 'doc', '@doc("a child")'],
        ['employment/relates/employee', 'card', '@card(1..)'],
        ['name/value', 'regex', '@regex("^.*$")'],
        ['person', 'abstract', '@abstract'],
        ['person/owns/name', 'card', '@card(0..2)'],
        ['person/owns/ref', 'key', '@key'],
        ['person/plays/employment:employee', 'card', '@card(0..1)'],
      ],
    );
    const plays = rows(path, 'SELECT type, role FROM schema_plays ORDER BY type') as Array<{ type: string; role: string }>;
    assert.deepEqual(plays.map((r) => `${r.type} plays ${r.role}`), ['employment plays income:source', 'person plays employment:employee']);
  });

  it('a restatement writes the same rows, and a different argument replaces the row', () => {
    const engine = new TypeDBLiteInterpreter(path);
    engine.define(SCHEMA);
    engine.define(SCHEMA);
    engine.define('define person owns name @card(0..5);');
    engine.close();
    const card = rows(path, `SELECT text FROM schema_annotation WHERE subject = 'person' || char(31) || 'owns' || char(31) || 'name'`) as Array<{ text: string }>;
    assert.deepEqual(card.map((r) => r.text), ['@card(0..5)']);
  });

  it('@meta is keyed by its key — two keys are two rows', () => {
    const engine = new TypeDBLiteInterpreter(path);
    engine.define('define entity player @meta("k1", "v1") @meta("k2", "v2");');
    engine.close();
    const meta = rows(path, "SELECT category, text FROM schema_annotation WHERE subject = 'player' ORDER BY category") as Array<{ category: string; text: string }>;
    assert.deepEqual(meta.map((r) => r.category), ['meta:k1', 'meta:k2']);
  });

  it('survives a reopen — a fresh process re-defines over the record without refusal', () => {
    const first = new TypeDBLiteInterpreter(path);
    first.define(SCHEMA);
    first.close();
    const second = new TypeDBLiteInterpreter(path);
    try {
      second.define(SCHEMA);
      second.define('define entity worker sub person;');
    } finally {
      second.close();
    }
  });
});
