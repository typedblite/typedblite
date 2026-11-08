import { describe, expect, it } from 'vitest';
import { validate } from './parse.js';
import { TypeQLiteValidationCode } from '../src/typeqlite-validation-codes.js';
import {
  ADMITTED,
  type AnnotationCategory,
  type AnnotationSubject,
} from '../src/typeqlite-annotations.js';

/**
 * Every row of the admissibility table, both ways — what a subject admits is accepted, and what
 * it does not is refused naming where the annotation belongs. The table is TypeDB 3's, as
 * `define.feature` states it (`can set annotation @X to Y` / `cannot set annotation @X to Y`);
 * this spec is what makes a row removed by accident a red test rather than a silent acceptance.
 *
 * 🔴 The statements below put the annotation on ONE subject each. `entity player sub person @X`
 * annotates the `sub`, not the type — the AST keeps three lists per definition for exactly that,
 * and a merged list would make this spec unable to say which row it was testing.
 */
const SAMPLE: Readonly<Record<AnnotationCategory, string>> = {
  key: '@key',
  unique: '@unique',
  card: '@card(1..1)',
  independent: '@independent',
  abstract: '@abstract',
  distinct: '@distinct',
  cascade: '@cascade',
  regex: '@regex("val")',
  range: '@range("1".."2")',
  values: '@values("1", "2")',
  doc: '@doc("docs here")',
  meta: '@meta("key", "value")',
};

const STATEMENT: Readonly<
  Record<AnnotationSubject, (annotation: string) => string>
> = {
  'entity type': (a) => `define entity player ${a};`,
  'relation type': (a) => `define relation parentship ${a}, relates parent;`,
  'attribute type': (a) => `define attribute description ${a}, value string;`,
  type: (a) => `define player ${a};`,
  sub: (a) => `define entity person; entity player sub person ${a};`,
  'value type': (a) => `define attribute description value string ${a};`,
  owns: (a) =>
    `define attribute name value string; entity player owns name ${a};`,
  relates: (a) => `define relation parentship @abstract, relates parent ${a};`,
  plays: (a) =>
    `define relation employment relates employee; entity player plays employment:employee ${a};`,
};

const notAdmitted = async (text: string) =>
  (await validate(text)).filter(
    (d) => d.code === TypeQLiteValidationCode.annotationNotAdmitted,
  );

const errors = async (text: string) =>
  (await validate(text)).filter((d) => d.severity === 1);

describe('the admissibility table, row by row', () => {
  const subjects = Object.keys(STATEMENT) as AnnotationSubject[];
  const categories = Object.keys(SAMPLE) as AnnotationCategory[];
  const rows = subjects.flatMap((subject) =>
    categories.map(
      (category) =>
        [subject, category, ADMITTED[subject].has(category)] as const,
    ),
  );

  it.each(rows)('%s: %s admitted = %s', async (subject, category, admitted) => {
    const text = STATEMENT[subject](SAMPLE[category]);
    const refusals = await notAdmitted(text);
    if (admitted) {
      expect(refusals).toEqual([]);
      expect(await errors(text)).toEqual([]);
    } else {
      expect(refusals).toHaveLength(1);
      expect(refusals[0].message).toContain(`@${category}`);
      expect(refusals[0].message).toContain(subject);
    }
  });

  it('names where a misplaced annotation belongs', async () => {
    const [refusal] = await notAdmitted('define entity player @card(1..1);');
    expect(refusal.message).toMatch(/applies to `owns`, `relates`, `plays`/);
  });

  it('has no home for @distinct until lists exist, and says so', async () => {
    const [refusal] = await notAdmitted(
      'define attribute name value string; entity player owns name @distinct;',
    );
    expect(refusal.message).toMatch(/Nothing in this grammar admits it yet/);
  });
});

describe('an annotation category is set once per subject', () => {
  it.each([
    [
      'owns',
      'define attribute name value string; entity player owns name @card(1..1) @card(0..5);',
    ],
    [
      'owns',
      'define attribute name value string; entity player owns name @regex("one") @regex("another");',
    ],
    [
      'relates',
      'define relation parentship relates parent @card(1..1) @card(0..5);',
    ],
    [
      'plays',
      'define relation employment relates employee; entity player plays employment:employee @card(1..1) @card(0..5);',
    ],
    [
      'value type',
      'define attribute description value string @values("1", "2") @values("3", "4");',
    ],
  ])(
    'refuses two of one category on %s with "Try redefine instead"',
    async (_subject, text) => {
      const found = (await errors(text)).filter(
        (d) => d.code === TypeQLiteValidationCode.annotationRepeated,
      );
      expect(found).toHaveLength(1);
      expect(found[0].message).toContain('Try redefine instead');
    },
  );

  it('@meta is a map: two keys are two entries, one key twice is the repeat — metadata.feature L616', async () => {
    expect(
      await errors(
        'define entity person @meta("key1", "val1") @meta("key2", "val2");',
      ),
    ).toEqual([]);
    const found = (
      await errors(
        'define entity person @meta("key1", "val1") @meta("key1", "val2");',
      )
    ).filter((d) => d.code === TypeQLiteValidationCode.annotationRepeated);
    expect(found).toHaveLength(1);
  });

  it('accepts the same annotation repeated verbatim, as TypeDB does', async () => {
    expect(
      await errors(
        'define relation parentship @abstract @abstract @abstract, relates parent;',
      ),
    ).toEqual([]);
    expect(
      await errors(
        'define attribute name value string; entity player owns name @card(1..1) @card(1..1);',
      ),
    ).toEqual([]);
  });
});

describe('annotation arguments', () => {
  it('a decimal literal fits a decimal attribute, and nothing else — Phase 06 review, round 4', async () => {
    expect(
      await errors(
        'define attribute price value decimal @values(1.5dec, 2.5dec) @range(0.0dec..9.9dec);',
      ),
    ).toEqual([]);
    expect(
      (await errors('define attribute price value double @values(1.5dec);'))[0]
        .message,
    ).toMatch(/a decimal .*'double'/);
  });

  it('refuses a repeated @values argument', async () => {
    const found = await errors(
      'define attribute n value double @values(124.4, 124.0, 124.4);',
    );
    expect(found).toHaveLength(1);
    expect(found[0].code).toBe(TypeQLiteValidationCode.annotationArguments);
    expect(found[0].message).toContain('124.4');
  });

  it.each([
    ['@regex("A")', 'integer', /constrains a string/],
    [
      '@range("A".."B")',
      'integer',
      /a string \("A"\) where the value type is 'integer'/,
    ],
    ['@range(1..2)', 'string', /an integer \(1\)/],
    ['@values(0.1)', 'integer', /a double/],
    ['@values(true)', 'string', /a boolean/],
    // ⚠️ Not `@values(2024-06-04)` on `datetime`: a date fits a datetime (midnight), which the
    // spec's own Backgrounds rely on (reduce.feature L420) and define.feature never refuses.
    ['@values(2024-06-04)', 'integer', /a date/],
    ['@values(2024-06-04T00:00:00+0010)', 'datetime', /a datetime-tz/],
    ['@values("year")', 'duration', /a string/],
    ['@values(123)', 'duration', /an integer/],
  ])('refuses %s on value type %s', async (annotation, valueType, message) => {
    const found = await errors(
      `define attribute description value ${valueType} ${annotation};`,
    );
    expect(found).toHaveLength(1);
    expect(found[0].code).toBe(TypeQLiteValidationCode.annotationArguments);
    expect(found[0].message).toMatch(message);
  });

  it.each([
    ['@regex("A")', 'string'],
    ['@range(1..2)', 'integer'],
    ['@range(1..2)', 'double'],
    ['@values(1, 2)', 'decimal'],
    ['@values(112.2, 134.3)', 'double'],
    ['@values(false, true)', 'boolean'],
    ['@values(2024-09-13, 2024-09-15)', 'date'],
    ['@values(2024-09-13T15:07:03, 2024-10-13T15:07:04)', 'datetime'],
    ['@values(2024-09-13T15:07:03+0100)', 'datetime-tz'],
    ['@values("P1Y2M3DT4M6.789S", "P1Y2M3DT4H5.789S")', 'duration'],
    ['@range("P1Y2M3DT4H5M6.788S".."P1Y2M3DT4H5M6.789S")', 'duration'],
  ])('accepts %s on value type %s', async (annotation, valueType) => {
    expect(
      await errors(
        `define attribute description value ${valueType} ${annotation};`,
      ),
    ).toEqual([]);
  });

  it('leaves an `owns` argument to the interpreter, which knows the attribute', async () => {
    // The AST cannot see that `name` is a string; refusing here would be a guess.
    expect(
      await errors(
        'define attribute name value string; entity player owns name @values(1, 2);',
      ),
    ).toEqual([]);
  });
});

describe('a value type is a value type, and only an attribute has one', () => {
  it.each(['bool', 'rgba'])('refuses `value %s` as unknown', async (name) => {
    const found = await errors(`define attribute colour value ${name};`);
    expect(found).toHaveLength(1);
    expect(found[0].code).toBe(TypeQLiteValidationCode.unknownValueType);
    expect(found[0].message).toContain('string, integer');
  });

  it('refuses `value` on an entity — define.feature L392', async () => {
    const found = await errors('define entity cream value double;');
    expect(found).toHaveLength(1);
    expect(found[0].code).toBe(TypeQLiteValidationCode.valueTypeOnThing);
  });

  it('parses `value` on a re-open and leaves the kind to the interpreter', async () => {
    expect(await errors('define name value integer;')).toEqual([]);
  });
});
