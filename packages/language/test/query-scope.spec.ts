import { describe, expect, it } from 'vitest';
import { validate } from './parse.js';

/**
 * 🔴 Why query-level names are NOT cross-references.
 *
 * Repositories parse a query as a standalone string — `this.db.query(\`match $s isa skill ...\`)`.
 * There is no schema document in scope, so a cross-reference from `isa skill` to the `EntityDef`
 * would be unresolvable in the ordinary case and every real query would carry a spurious error.
 *
 * The schema check belongs to the interpreter, against the schema it has actually loaded — layer
 * three of ADR-018 Decision 7. Making it a resolution rule would be a validator that is wrong
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
