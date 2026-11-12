import { beforeEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TypeDBLiteInterpreter } from '../src/interpreter.js';
import { DiagnosticCode, diagnosticOf } from '../src/diagnostics.js';

/**
 * Ordered capabilities — `owns name[]`, `relates parent[]` (define.feature L338, redefine.feature
 * L236, undefine.feature L246). A list is a different definition from its unordered form: `define`
 * keeps the ordering it finds, `redefine` changes it, and `undefine` names it as it is defined.
 */
const SCHEMA = [
  'define',
  'attribute name value string;',
  'attribute tag value string;',
  'entity person owns name, owns tag[];',
  'relation parentship relates parent, relates child[];',
].join('\n');

let engine: TypeDBLiteInterpreter;
beforeEach(() => {
  engine = new TypeDBLiteInterpreter(':memory:');
  engine.define(SCHEMA);
});

const refusal = (statement: string): { code?: string; message: string } | undefined => {
  try {
    engine.define(statement);
  } catch (error) {
    return { code: diagnosticOf(error)?.code, message: (error as Error).message };
  }
  return undefined;
};

describe('define keeps the ordering it finds', () => {
  it('accepts a restatement with the same ordering', () => {
    assert.equal(refusal('define person owns tag[]; parentship relates child[];'), undefined);
  });

  it('refuses the other ordering, naming the one defined — L338, L599', () => {
    assert.match(refusal('define person owns name[];')?.message ?? '', /different 'person owns name' is already defined/);
    assert.match(refusal('define person owns tag;')?.message ?? '', /different 'person owns tag\[\]' is already defined/);
    assert.match(refusal('define parentship relates parent[];')?.message ?? '', /different 'parentship relates parent' is already defined/);
  });

  it('admits @distinct on a list, and only there', () => {
    assert.equal(refusal('define person owns tag[] @distinct;'), undefined);
    assert.equal(refusal('define person owns name @distinct;')?.code !== undefined, true);
  });
});

describe('redefine changes the ordering, and only the ordering', () => {
  it('flips an ownership both ways, and says when nothing changed — redefine.feature L236', () => {
    assert.equal(refusal('redefine person owns name[];'), undefined);
    assert.match(refusal('redefine person owns name[];')?.message ?? '', /Nothing was redefined/);
    assert.match(refusal('define person owns name;')?.message ?? '', /different 'person owns name\[\]'/);
    assert.equal(refusal('redefine person owns name;'), undefined);
    assert.match(refusal('redefine person owns name;')?.message ?? '', /Nothing was redefined/);
  });

  it('refuses an ordering and an annotation in one redefine — L295', () => {
    assert.notEqual(refusal('redefine person owns name[] @card(0..1);'), undefined);
  });

  it('keeps a list\'s @distinct from surviving the change to unordered', () => {
    engine.define('define person owns tag[] @distinct;');
    assert.equal(refusal('redefine person owns tag;')?.code, DiagnosticCode.annotationNotAdmitted);
  });
});

describe('undefine names the capability as it is defined', () => {
  it('refuses the other ordering with TypeDB\'s "while" — undefine.feature L258', () => {
    assert.match(refusal('undefine owns name[] from person;')?.message ?? '', /there is no defined 'person owns name\[\]', while 'person owns name' is/);
    assert.match(refusal('undefine relates child from parentship;')?.message ?? '', /there is no defined 'parentship relates child', while 'parentship relates child\[\]' is/);
  });

  it('removes a list, after which the unordered form can be defined', () => {
    assert.equal(refusal('undefine owns tag[] from person;'), undefined);
    assert.equal(refusal('define person owns tag;'), undefined);
  });
});

describe('the ordering is recorded with the schema', () => {
  // A real file, inspected through a second `DatabaseSync`: a binding limit under WASM (vitest.wasm.config.ts).
  it.skipIf(process.env['TYPEDBLITE_SQLITE'] === 'wasm')('survives reopening a file-backed store, and a rename of the owner', () => {
    const directory = mkdtempSync(join(tmpdir(), 'typedblite-lists-'));
    try {
      const path = join(directory, 'store.db');
      const first = new TypeDBLiteInterpreter(path);
      first.define(SCHEMA);
      first.define('redefine entity person label human;');
      first.close();
      const store = new DatabaseSync(path);
      const subjects = (store.prepare('SELECT subject FROM schema_ordered ORDER BY subject').all() as Array<{ subject: string }>).map((r) => String(r.subject).split('\u001f').join(' '));
      store.close();
      assert.deepEqual(subjects, ['human owns tag', 'parentship relates child']);
      const second = new TypeDBLiteInterpreter(path);
      let message = '';
      try {
        second.define('define human owns tag;');
      } catch (error) {
        message = (error as Error).message;
      }
      second.close();
      assert.match(message, /different 'human owns tag\[\]'/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
