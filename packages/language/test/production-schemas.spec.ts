import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, validate } from './parse.js';
import { isDefineClause } from '../src/generated/ast.js';

/**
 * The schemas and queries this language exists to serve.
 *
 * 🔴 Phase 00 proved these by hand-run script, which is how it shipped a grammar that could not
 * parse `delete $i;` — nobody had to run anything to merge. They are tests now.
 */
// `__dirname` does not exist under ESM. Jest runs with cwd at the package root — both via the
// Nx `test` target's `cwd` option and when invoked here directly.
const PACKAGE = process.cwd();
const LIBS = join(PACKAGE, '..', '..', '..');
const EXAMPLES = join(PACKAGE, 'examples');

const read = (path: string) => readFileSync(path, 'utf8');

describe('production TypeQLite parses', () => {
  it.each([
    [
      'iam.schema.typeqlite',
      join(LIBS, 'platform/iam/infrastructure/src/lib/iam.schema.typeqlite'),
    ],
    [
      'skills.schema.typeqlite',
      join(
        LIBS,
        'platform/skills/infrastructure/src/lib/skills.schema.typeqlite',
      ),
    ],
  ])('%s parses', (_name, path) => {
    const result = parse(read(path));
    expect(result.lexerErrors).toHaveLength(0);
    expect(result.parserErrors).toHaveLength(0);
    const defs = result.value.clauses
      .filter(isDefineClause)
      .flatMap((clause) => clause.definitions);
    // Not a count: a pinned number went stale each time a schema legitimately grew. This catches the scan matching nothing.
    expect(defs.length).toBeGreaterThan(0);
  });

  it.each([
    ['real-queries.typeqlite', 13],
    ['projection-target.typeqlite', 5],
  ])('%s parses as %i pipelines', (file, pipelines) => {
    const result = parse(read(join(EXAMPLES, file)));
    expect(result.lexerErrors).toHaveLength(0);
    expect(result.parserErrors).toHaveLength(0);
    expect(result.value.clauses).toHaveLength(pipelines);
  });

  // The specific defect Phase 00's verification found: a whole file used this and the grammar
  // rejected it. Kept as its own case so a regression names itself.
  it('accepts `delete $i;` — deleting the thing, not detaching an attribute', () => {
    const result = parse(
      'match $i isa invocation, has workflow-id "wf-1";\ndelete $i;',
    );
    expect(result.parserErrors).toHaveLength(0);
  });

  it('still accepts `delete $old of $p;` — detaching an attribute', () => {
    const result = parse(
      'match $p isa principal, has principal-type $old;\ndelete $old of $p;',
    );
    expect(result.parserErrors).toHaveLength(0);
  });

  // Stronger than parsing: the schemas this repository owns must also validate cleanly, or the
  // not-implemented checks (ADR-018 D7) have been written too aggressively.
  it.each([
    [
      'iam.schema.typeqlite',
      join(LIBS, 'platform/iam/infrastructure/src/lib/iam.schema.typeqlite'),
    ],
    [
      'skills.schema.typeqlite',
      join(
        LIBS,
        'platform/skills/infrastructure/src/lib/skills.schema.typeqlite',
      ),
    ],
  ])('%s validates with no diagnostics', async (_name, path) => {
    const diagnostics = await validate(read(path));
    expect(diagnostics.map((d) => d.message)).toEqual([]);
  });
});
