/**
 * The phase's reason to exist: a write and its log row cannot disagree, and `seq` order is commit
 * order even when several OS processes write at once.
 *
 * 🔴 These spawn **real child processes**. An in-process pair would prove nothing — it is the same
 * mistake as a durability test that "reopens" a database through a handle it never closed, which
 * this workspace has already been caught by once.
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { TypeDBLiteInterpreter } from '../src/interpreter.js';
import { readKeyedSkillsSchema } from './fixtures/keyed-skills-schema.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SCHEMAS = fileURLToPath(new URL('../../../test-fixtures/schemas/', import.meta.url));
const SCHEMA = join(SCHEMAS, 'skills.schema.typeqlite');

const runChild = (fixture: string, args: string[]) =>
  spawnSync(
    process.execPath,
    ['--import', 'tsx', join(HERE, 'fixtures', fixture), ...args],
    { encoding: 'utf8' },
  );

/**
 * 🔴 Genuinely parallel, unlike `spawnSync`.
 *
 * An earlier version of this file used `spawnSync` in a `map`, which runs each child to completion
 * before starting the next — so the "concurrent writers" test contained no concurrency at all and
 * proved only ordering. Contention is the thing being tested; it has to actually happen.
 */
const runChildParallel = (fixture: string, args: string[]) =>
  new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', join(HERE, 'fixtures', fixture), ...args],
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('close', (code) => resolve({ code, stderr }));
  });

const tempDb = (label: string) =>
  join(mkdtempSync(join(tmpdir(), `typedblite-${label}-`)), 'store.db');

describe('a crash cannot separate a write from its log row', () => {
  it('🔴 leaves neither the data nor the log entry when killed mid-transaction', () => {
    const path = tempDb('crash');
    const child = runChild('crash-writer.ts', [path, SCHEMA]);

    assert.equal(child.signal, 'SIGKILL', 'the child must actually have been killed');

    const reopened = new TypeDBLiteInterpreter(path);
    const changes = reopened.changeLog.since(0);

    // The committed write before the crash survives.
    assert.ok(
      changes.some((c) => c.entityId === 'skill/before-crash'),
      'a write that committed before the crash must survive',
    );
    // The uncommitted one leaves nothing — neither half of it.
    assert.equal(
      changes.some((c) => c.entityId === 'skill/crashed'),
      false,
      'an uncommitted log row must not survive',
    );
    const orphans = reopened.query(
      'match $s isa skill, has skill-id $id; select $id;',
    );
    assert.equal(
      orphans.rows.length,
      1,
      'the uncommitted thing must not survive either — data and log roll back together',
    );
    reopened.close();
  });
});

describe('seq order is commit order across processes', () => {
  it('🔴 assigns a contiguous, gap-free, duplicate-free sequence under concurrent writers', async () => {
    const path = tempDb('concurrent');

    // Define the schema once up front so the children race on writes, not on DDL.
    const setup = new TypeDBLiteInterpreter(path);
    setup.define(readKeyedSkillsSchema(SCHEMA));
    setup.close();

    const perWriter = 8;
    const writers = ['alpha', 'beta', 'gamma'];
    // All three start before any finishes — they must genuinely contend for the write lock.
    const children = await Promise.all(
      writers.map((prefix) =>
        runChildParallel('concurrent-writer.ts', [path, SCHEMA, prefix, String(perWriter)]),
      ),
    );
    for (const [index, child] of children.entries()) {
      assert.equal(child.code, 0, `writer ${writers[index]} failed: ${child.stderr}`);
    }

    const reader = new TypeDBLiteInterpreter(path);
    const changes = reader.changeLog.since(0);
    const seqs = changes.map((c) => c.seq);

    assert.equal(
      changes.length,
      writers.length * perWriter,
      'every write from every process must appear exactly once',
    );
    assert.deepEqual(
      seqs,
      [...seqs].sort((a, b) => a - b),
      'since() must return commit order',
    );
    assert.equal(new Set(seqs).size, seqs.length, 'no seq may repeat');
    assert.deepEqual(
      seqs,
      Array.from({ length: seqs.length }, (_, i) => i + 1),
      'seq must be contiguous — a gap would mean a follower could miss a change',
    );

    // Each writer's entities are all present, so no process lost a write to contention.
    for (const prefix of writers) {
      const mine = changes.filter((c) => c.entityId.startsWith(`skill/${prefix}-`));
      assert.equal(mine.length, perWriter, `${prefix} lost writes`);
    }
    reader.close();
  });

  it('a follower reading seq > cursor sees every change exactly once', () => {
    const path = tempDb('cursor');
    const db = new TypeDBLiteInterpreter(path);
    db.define(readKeyedSkillsSchema(SCHEMA));
    for (let i = 0; i < 10; i += 1) {
      db.execute(`insert $s isa skill, has skill-id "s-${i}", has skill-name "n";`);
    }

    // Drain in small batches, exactly as a replication follower would.
    const seen: string[] = [];
    let cursor = 0;
    for (;;) {
      const batch = db.changeLog.since(cursor, 3);
      if (batch.length === 0) break;
      seen.push(...batch.map((c) => c.entityId));
      cursor = batch[batch.length - 1].seq;
    }

    assert.equal(seen.length, 10);
    assert.equal(new Set(seen).size, 10, 'no change may be delivered twice');
    db.close();
  });
});
