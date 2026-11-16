import { describe, expect, it } from 'vitest';
import { validate } from './parse.js';
import { TypeQLiteValidationCode } from '../src/typeqlite-validation-codes.js';

// The grammar lets `sub` and `value` sit before the traits and among them, so an entity or a relation
// collects them in lists (`superTypes`, `valueTypes`). Written twice, the second used to overwrite the first
// without a word; now it is refused.
const codes = async (text: string) => (await validate(text)).map((d) => d.code);

describe('a type has at most one sub clause and one value clause', () => {
  it.each([
    ['an entity', 'define entity a; entity b; entity c, sub a, sub b;'],
    ['an entity, one before and one among the traits', 'define attribute n, value string; entity a; entity b; entity c, sub a, owns n, sub b;'],
    ['a relation', 'define relation a, relates x; relation b, relates y; relation c, sub a, sub b;'],
  ])('refuses a second sub on %s', async (_, text) => {
    expect(await codes(text)).toContain(TypeQLiteValidationCode.repeatedClause);
  });

  it('refuses a second value clause, as well as a value on a thing type', async () => {
    expect(await codes('define entity a, value integer, value string;')).toContain(TypeQLiteValidationCode.repeatedClause);
  });

  it('accepts one sub, wherever it is written', async () => {
    for (const text of [
      'define entity a; attribute n, value string; entity c, sub a, owns n;',
      'define entity a; attribute n, value string; entity c, owns n, sub a;',
      'define relation a, relates x; relation c, relates y, sub a;',
    ]) {
      expect(await codes(text), text).not.toContain(TypeQLiteValidationCode.repeatedClause);
    }
  });
});
