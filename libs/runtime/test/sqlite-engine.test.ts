import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { SqliteEngine } from '../src/sqlite-engine';

/**
 * The adapter every repository in the workspace reaches the interpreter through.
 *
 * 🔴 It was measured only from *other* projects' suites — two downstream stores'
 * infrastructure both construct one — so nothing in its own package proved its surface. That is
 * the same attribution gap that made the contract suites look untested.
 */
describe('SqliteEngine', () => {
  // A real schema from the workspace, as the sibling suites use — a hand-written one would be a
  // second dialect to keep in step with the parser.
  const SCHEMAS = fileURLToPath(new URL('../../../test-fixtures/schemas/', import.meta.url));
  const schema = readFileSync(join(SCHEMAS, 'skills.schema.typeqlite'), 'utf8');

  it('starts with no schema, and reports one after define', async () => {
    const engine = new SqliteEngine();

    expect(engine.hasSchema).toBe(false);

    await engine.define(schema);

    expect(engine.hasSchema).toBe(true);
  });

  it('defaults to an in-memory database, so constructing one writes nothing', () => {
    expect(() => new SqliteEngine()).not.toThrow();
  });

  it('writes and reads back through the interpreter', async () => {
    const engine = new SqliteEngine();
    await engine.define(schema);

    await engine.execute(
      'insert $s isa skill, has skill-id "s-1", has skill-name "One", has skill-description "d";',
    );
    const { rows } = await engine.query('match $s isa skill, has skill-id $i; select $i;');

    expect(rows).toHaveLength(1);
  });

  /**
   * 🔴 **The report is returned, not swallowed** (ADR-004). This adapter is the only thing between
   * the interpreter and every repository in the workspace, so dropping the report here would make
   * the diagnostics unreachable from the layer meant to decide what to do with them.
   */
  it('returns the engine report from execute rather than discarding it', async () => {
    const engine = new SqliteEngine();
    await engine.define(schema);

    const report = await engine.execute(
      'insert $s isa skill, has skill-id "s-2", has skill-name "Two", has skill-description "d";',
    );

    expect(report).toBeDefined();
  });

  /**
   * 🔴 **Exposing the change log does not widen the port.** `TypeDBLiteDatabase`'s five methods stay
   * five — a TypeDB server over the network has no change log and must not be asked for one. This
   * is a capability of *this adapter*, reachable by whoever composed it: the composition root holds
   * the engine and can replicate, a consumer holding only the port cannot.
   */
  it('exposes its change log to whoever holds the engine', async () => {
    const engine = new SqliteEngine();
    await engine.define(schema);

    expect(engine.changeLog).toBeDefined();
  });

  it('persists as a no-op, so a caller can persist unconditionally after a write', async () => {
    const engine = new SqliteEngine();
    await engine.define(schema);

    await expect(engine.persist()).resolves.toBeUndefined();
  });
});
