/**
 * Why the engine-level transaction exists: a producer's state change and its event record are written in one
 * transaction, so a crash leaves both or neither.
 *
 * 🔴 These spawn **real child processes** and kill them with SIGKILL, like durability.test.ts: a
 * rollback inside one process proves the API, not a crash.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { SqliteEngine } from '../src/sqlite-engine';
import { notKilledOnPurpose } from './fixtures/kill-self';

const HERE = fileURLToPath(new URL('.', import.meta.url));

const schema = `define
  entity project,
    owns project-id @key,
    owns project-name;
  attribute project-id, value string;
  attribute project-name, value string;`;

const ids = async (engine: SqliteEngine): Promise<string[]> => {
  const { rows } = await engine.query('match $s isa project, has project-id $i; select $i;');
  return rows
    .map((row) => {
      const value = row['i'] as { asString?: () => string } | string;
      return typeof value === 'string' ? value : (value.asString?.() ?? String(value));
    })
    .sort();
};

const prepared = async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'typedblite-crash-')), 'store.db');
  const engine = new SqliteEngine(path);
  await engine.define(schema);
  await engine.close();
  return path;
};

const runCrasher = (path: string, mode: string) =>
  spawnSync(
    process.execPath,
    ['--import', 'tsx', join(HERE, 'fixtures', 'transaction-crasher.ts'), path, mode],
    { encoding: 'utf8' },
  );

describe('a crash cannot separate a producer\'s state change from its event record', () => {
  it.each(['kill-between', 'kill-before-commit'])(
    '🔴 %s: killed mid-transaction, neither row exists after reopen, and the store is writable',
    async (mode) => {
      const path = await prepared();

      const child = runCrasher(path, mode);

      expect(notKilledOnPurpose(child), 'the child must actually have been killed').toBeUndefined();
      const reopened = new SqliteEngine(path);
      expect(await ids(reopened)).toEqual([]);
      await reopened.execute(
        'insert $s isa project, has project-id "after-crash", has project-name "x";',
      );
      expect(await ids(reopened)).toEqual(['after-crash']);
    },
    30_000,
  );

  it('the control: the same sequence, allowed to commit, leaves both rows', async () => {
    const path = await prepared();

    const child = runCrasher(path, 'commit');

    expect(child.status).toBe(0);
    expect(await ids(new SqliteEngine(path))).toEqual(['event-1', 'state-1']);
  }, 30_000);
});
