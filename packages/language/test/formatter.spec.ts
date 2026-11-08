import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { astShape, format, parse } from './parse.js';
const PACKAGE = process.cwd();
const LIBS = join(PACKAGE, '..', '..', '..');
const EXAMPLES = join(PACKAGE, 'examples');
const read = (path: string) => readFileSync(path, 'utf8');

const CORPUS: Array<[string, string]> = [
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
  ['real-queries.typeqlite', join(EXAMPLES, 'real-queries.typeqlite')],
  [
    'projection-target.typeqlite',
    join(EXAMPLES, 'projection-target.typeqlite'),
  ],
];

describe('the formatter normalises', () => {
  /**
   * 🔴 This is the test that means something.
   *
   * Idempotence and AST preservation are necessary and not sufficient — a formatter that deleted
   * every newline would satisfy both, and so would one that did nothing at all. Only expected
   * output proves it produces the house style, so the expectation below is written by hand from
   * the production schemas, not captured from a run.
   */
  it('reflows a mangled schema into house style', async () => {
    const mangled = [
      'define',
      'entity   principal ,   owns principal-id   @key ,owns principal-type ;',
      'attribute   principal-id ,  value string ;',
      'attribute principal-type,value string;',
    ].join('\n');

    expect(await format(mangled)).toBe(
      [
        'define',
        '',
        'entity principal,',
        '    owns principal-id @key,',
        '    owns principal-type;',
        '',
        'attribute principal-id, value string;',
        'attribute principal-type, value string;',
      ].join('\n'),
    );
  });

  it('keeps a single-pattern stage inline and breaks a multi-pattern one', async () => {
    const mangled = [
      'match   $s isa skill , has skill-id "x" ;select   $s ;',
      'match $a isa skill, has skill-id "a"; $b isa skill-step, has step-id "b"; insert (owner: $a, step: $b) isa skill-composition;',
    ].join('\n');

    expect(await format(mangled)).toBe(
      [
        'match $s isa skill, has skill-id "x";',
        'select $s;',
        'match',
        '    $a isa skill, has skill-id "a";',
        '    $b isa skill-step, has step-id "b";',
        'insert (owner: $a, step: $b) isa skill-composition;',
      ].join('\n'),
    );
  });

  it('never spaces a role reference', async () => {
    const formatted = await format(
      'define\nentity principal, plays membership : member ;',
    );
    expect(formatted).toContain('plays membership:member;');
  });
});

describe('the formatter is safe', () => {
  it.each(CORPUS)('%s — formatting is idempotent', async (_name, path) => {
    const once = await format(read(path));
    expect(await format(once)).toBe(once);
  });

  it.each(CORPUS)('%s — formatting preserves the AST', async (_name, path) => {
    const source = read(path);
    expect(await astShape(await format(source))).toBe(await astShape(source));
  });

  it.each(CORPUS)(
    '%s — formatted output still parses cleanly',
    async (_name, path) => {
      const result = parse(await format(read(path)));
      expect(result.lexerErrors).toHaveLength(0);
      expect(result.parserErrors).toHaveLength(0);
    },
  );
});

/**
 * Generated input, per the phase checklist. Worked examples only cover shapes someone thought of;
 * these cover combinations nobody wrote down.
 */
describe('the formatter holds over generated schemas', () => {
  const build = (seed: number): string => {
    const rnd = (n: number) =>
      (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
    // 🔴 At least one space, always. A zero-width gap produced `ownsattr-0`, which is a lexing
    // failure in the *fixture*, not a formatter defect — the generator must emit valid TypeQLite and
    // vary only its whitespace.
    const gap = () => ' '.repeat(1 + rnd(3)) + (rnd(3) === 0 ? '\n' : '');
    const attributes = Array.from(
      { length: 1 + rnd(4) },
      (_, i) => `attr-${i}`,
    );
    const lines = [
      'define',
      ...attributes.map(
        (a) => `attribute${gap()}${a}${gap()},${gap()}value string;`,
      ),
    ];
    for (let e = 0; e < 1 + rnd(3); e++) {
      const owned = attributes.slice(0, 1 + rnd(attributes.length));
      const traits = owned.map(
        (a, i) => `owns${gap()}${a}${i === 0 ? ' @key' : ''}`,
      );
      lines.push(
        `entity${gap()}ent-${e}${gap()},${gap()}${traits.join(`${gap()},${gap()}`)};`,
      );
    }
    return lines.join('\n');
  };

  const seeds = Array.from({ length: 25 }, (_, i) => i + 1);

  it.each(seeds)(
    'seed %i — idempotent, AST-preserving, and still parses',
    async (seed) => {
      const source = build(seed);
      expect(parse(source).parserErrors).toHaveLength(0);

      const once = await format(source);
      expect(await format(once)).toBe(once);
      expect(await astShape(once)).toBe(await astShape(source));
      expect(parse(once).parserErrors).toHaveLength(0);
    },
  );
});
