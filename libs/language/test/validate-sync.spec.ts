import { describe, expect, it } from 'vitest';
import { EmptyFileSystem } from 'langium';
import { createTypeQLiteServices } from '../src/typeqlite-module.js';
import { validateSync } from '../src/typeqlite-validate-sync.js';
import { TypeQLiteValidationCode } from '../src/typeqlite-validation-codes.js';
import { isTypeDefinition } from '../src/typeqlite-definitions.js';
import { parse } from './parse.js';

/**
 * `validateSync`: the runtime's way into every registered check, with no document and no `await`
 * (ADR-002 D7). What it reports must be what the language server would report: the same code, the
 * same LSP severity, and the narrowest range Langium can give.
 */
const { TypeQLite } = createTypeQLiteServices(EmptyFileSystem);
const check = (text: string) => validateSync(TypeQLite, parse(text).value);

describe('validateSync', () => {
  it("reports a check's error with its code, LSP severity, source, and the node's range", () => {
    const [diagnostic, ...rest] = check('redefine attribute age value strng;');
    expect(rest).toEqual([]);
    expect(diagnostic).toMatchObject({
      code: TypeQLiteValidationCode.unknownValueType,
      severity: 1,
      source: 'typedblite',
      message: expect.stringMatching(/'strng' is not a value type/),
    });
    // The whole `value strng` change, not the statement before it.
    expect(diagnostic!.range.start).toEqual({ line: 0, character: 23 });
  });

  it('points at the named property when the check names one', () => {
    // An unknown value type in a definition: the range is the value type, not the whole definition.
    const text = 'define attribute age, value strng;';
    const [diagnostic, ...rest] = check(text);
    expect(rest).toEqual([]);
    expect(diagnostic?.code).toBe(TypeQLiteValidationCode.unknownValueType);
    expect(text.slice(diagnostic!.range.start.character, diagnostic!.range.end.character)).toBe('strng');
  });

  it('reports nothing for valid TypeQLite', () => {
    expect(check('define\nattribute name, value string;\nentity person, owns name @key;')).toEqual([]);
  });
});

describe('isTypeDefinition', () => {
  it('is true for an entity, a relation and an attribute, and false for a struct and a function', () => {
    const file = parse(
      'define\nentity person;\nrelation knows, relates who;\nattribute name, value string;\nstruct point: x value integer;\nfun f() -> integer: match let $x = 1; return first $x;',
    ).value;
    const definitions = file.clauses.flatMap((clause) => ('definitions' in clause ? clause.definitions : []));
    expect(definitions.map((d) => [d.$type, isTypeDefinition(d)])).toEqual([
      ['EntityDef', true],
      ['RelationDef', true],
      ['AttributeDef', true],
      ['StructDef', false],
      ['FunctionDefinition', false],
    ]);
  });
});
