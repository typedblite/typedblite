import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { splitStatements, TypeDBLiteSession } from '../src/session.js';

describe('splitting TypeQLite into statements', () => {
  // 🔴 The case that makes this non-trivial. A `match … insert …` pipeline contains TWO semicolons
  // and is ONE statement — splitting on `;` would tear every write in the codebase in half.
  it('keeps a match/insert pipeline together', () => {
    const source = [
      'match',
      '  $s isa project, has project-id "website-relaunch";',
      '  $st isa task, has task-id "s-1";',
      'insert (owner: $s, task: $st) isa project-task;',
    ].join('\n');
    assert.equal(splitStatements(source).length, 1);
  });

  it('keeps match/delete together', () => {
    assert.equal(
      splitStatements(
        'match $i isa iteration, has iteration-id "wf-1";\ndelete $i;',
      ).length,
      1,
    );
  });

  it('modifier stages and a fetch continue the pipeline they follow', () => {
    assert.deepEqual(splitStatements('match $p isa person, has age $a; select $a; sort $a desc; offset 1; limit 2;\nmatch $q isa person; select $q;'), [
      'match $p isa person, has age $a; select $a; sort $a desc; offset 1; limit 2;',
      'match $q isa person; select $q;',
    ]);
    assert.equal(splitStatements('match $p isa person; sort $p; fetch { "p": $p.name };').length, 1);
  });

  it('a reduce ends a pipeline, after a select or on its own — Phase 06 review, round 4', () => {
    assert.deepEqual(splitStatements('match $p isa person, has age $a; select $a; reduce $s = sum($a);\nmatch $q isa person; select $q;'), [
      'match $p isa person, has age $a; select $a; reduce $s = sum($a);',
      'match $q isa person; select $q;',
    ]);
    assert.deepEqual(splitStatements('match $p isa person; reduce $c = count($p);\ninsert $x isa person;'), [
      'match $p isa person; reduce $c = count($p);',
      'insert $x isa person;',
    ]);
  });

  it('separates two independent inserts', () => {
    assert.equal(
      splitStatements('insert $a isa project;\ninsert $b isa project;').length,
      2,
    );
  });

  it('drops comment lines', () => {
    assert.deepEqual(splitStatements('# a note\ninsert $a isa project;'), [
      'insert $a isa project;',
    ]);
  });
});

describe('a TypeQLite session', () => {
  const schema =
    'define attribute project-id, value string; attribute project-name, value string; entity project, owns project-id @key, owns project-name;';

  it('applies a schema, writes, and reads back', async () => {
    const session = new TypeDBLiteSession();
    assert.deepEqual(await session.run(schema), {
      kind: 'ok',
      statement: 'define',
    });
    assert.equal(session.hasSchema, true);
    assert.deepEqual(
      await session.run(
        'insert $s isa project, has project-id "website-relaunch", has project-name "Website relaunch";',
      ),
      { kind: 'ok', statement: 'write' },
    );
    const read = await session.run(
      'match $s isa project, has project-id "website-relaunch", has project-name $n;\nselect $n;',
    );
    assert.deepEqual(read, { kind: 'rows', rows: [{ n: 'Website relaunch' }] });
    await session.close();
  });

  it('a write keyword inside a single-quoted string does not make a read a write', async () => {
    const session = new TypeDBLiteSession();
    await session.run(schema);
    await session.run("insert $s isa project, has project-id 'k', has project-name 'please insert this';");
    const read = await session.run("match $s isa project, has project-name 'please insert this', has project-id $id; select $id;");
    assert.deepEqual(read, { kind: 'rows', rows: [{ id: 'k' }] });
    await session.close();
  });

  // 🔴 Errors are RETURNED, not thrown. A shell that dies on a typo is unusable, and one reason
  // this exists is to make TypeQLite's errors legible rather than fatal.
  it('returns an error rather than throwing, so a shell survives a typo', async () => {
    const session = new TypeDBLiteSession();
    await session.run(schema);
    const outcome = await session.run('insert $s isa nonexistent-type;');
    assert.equal(outcome.kind, 'error');
    assert.match((outcome as { message: string }).message, /nonexistent-type/);
    // The session is still usable afterwards — that is the whole point.
    assert.deepEqual(
      await session.run('insert $s isa project, has project-id "after-the-error";'),
      { kind: 'ok', statement: 'write' },
    );
    await session.close();
  });

  it('reports no schema before one is applied', async () => {
    const session = new TypeDBLiteSession();
    assert.equal(session.hasSchema, false);
    await session.close();
  });
});

describe('a file-backed database', () => {
  // 🔴 Found by trying it: the data persisted but `hasSchema` and the interpreter's type list were
  // per-PROCESS state, so a fresh process against an existing database believed no schema had been
  // applied and refused every statement. `--database` was persisting data nothing could query.
  // The applied vocabulary is now stored in the database itself and reloaded on open.
  it('is still usable in a new session, with its schema intact', async () => {
    const path = join(
      tmpdir(),
      `typeqlite-${Math.random().toString(36).slice(2)}.db`,
    );
    const first = new TypeDBLiteSession(path);
    await first.run(
      'define attribute project-id, value string; entity project, owns project-id @key;',
    );
    await first.run('insert $s isa project, has project-id "survives";');
    await first.close();

    const second = new TypeDBLiteSession(path);
    assert.equal(second.hasSchema, true, 'the reopened database knows its schema');
    assert.deepEqual(
      await second.run('match $s isa project, has project-id $id;\nselect $id;'),
      { kind: 'rows', rows: [{ id: 'survives' }] },
    );
    await second.close();
    rmSync(path, { force: true });
  });
});
