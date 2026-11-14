import { describe, expect, it } from 'vitest';
import { validate } from './parse.js';
import { TypeQLiteValidationCode } from '../src/typeqlite-validation-codes.js';

/**
 * 🔴 Why query-level names are NOT cross-references.
 *
 * Repositories parse a query as a standalone string — `this.db.query(\`match $s isa skill ...\`)`.
 * There is no schema document in scope, so a cross-reference from `isa skill` to the `EntityDef`
 * would be unresolvable in the ordinary case and every real query would carry a spurious error.
 *
 * The schema check belongs to the interpreter, against the schema it has actually loaded — layer
 * three of ADR-002 Decision 7. Making it a resolution rule would be a validator that is wrong
 * whenever it matters.
 */
describe('a query validates standalone, without a schema in scope', () => {
  it('accepts a query naming types no loaded document declares', async () => {
    const diagnostics = await validate(
      'match $s isa skill, has skill-id "start-session", has skill-name $n;\nselect $n;',
    );
    expect(diagnostics.map((d) => d.message)).toEqual([]);
  });

  it('still rejects an unimplemented construct in a schema, which is not scope-dependent', async () => {
    const diagnostics = await validate(
      'define attribute t, value string; entity d, owns t @card(0..);',
    );
    expect(diagnostics).toHaveLength(1);
  });
});

describe('what a disjunction binds', () => {
  // Errors only: the workspace this file's documents share holds a schema, so unknown labels are
  // warned about (ADR-008 D6), which is not what these cases are about.
  const errors = async (text: string) => (await validate(text)).filter((d) => d.severity === 1);

  it('binds a variable that every branch binds, so a comparison after it may read it', async () => {
    const diagnostics = await errors('match { $p isa person, has name $n; } or { $p isa company, has name $n; }; $n == "x";');
    expect(diagnostics.map((d) => d.code)).toEqual([]);
  });

  it('does not bind a variable only some branches bind: TypeDB refuses the comparison', async () => {
    const diagnostics = await errors('match { $p isa person, has name $n; } or { $p isa company; }; $n == "x";');
    expect(diagnostics.map((d) => [d.code, d.message])).toEqual([
      [TypeQLiteValidationCode.unboundValue, "The variable 'n' must be bound to a value before it's used."],
    ]);
  });
});
