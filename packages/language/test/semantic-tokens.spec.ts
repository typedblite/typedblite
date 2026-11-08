import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { semanticTokens } from './parse.js';

const LIBS = join(process.cwd(), '..', '..', '..');
const read = (path: string) => readFileSync(path, 'utf8');

const SCHEMA = [
  'define',
  'attribute skill-id, value string;',
  'entity skill, owns skill-id @key;',
].join('\n');

describe('declarations are classified', () => {
  it('names an entity as a declared type and an attribute as a declared property', async () => {
    const tokens = await semanticTokens(SCHEMA);
    expect(tokens).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'type', text: 'skill' }),
        expect.objectContaining({ type: 'property', text: 'skill-id' }),
      ]),
    );
    // The declaration modifier is set on the definition, so a declaration and a reference to it
    // are distinguishable even though both are the same token type.
    const declared = tokens.filter((t) => t.modifiers !== 0).map((t) => t.text);
    expect(declared).toContain('skill');
    expect(declared).toContain('skill-id');
  });

  it('classifies variables, role players and literals in a query', async () => {
    const tokens = await semanticTokens(
      'match $s isa skill, has skill-id "abc"; select $s;',
    );
    const byText = new Map(tokens.map((t) => [t.text, t.type]));
    expect(byText.get('$s')).toBe('variable');
    expect(byText.get('skill')).toBe('type');
    expect(byText.get('skill-id')).toBe('property');
    expect(byText.get('"abc"')).toBe('string');
  });
});

/**
 * 🔴 The assertion this phase exists for.
 *
 * A TextMate grammar colours `skill-id` and `nope-id` identically — it is a regex, and neither is
 * a keyword. The scope provider knows one resolves and the other does not, and until now that
 * knowledge was thrown away at exactly the point it would be most useful.
 */
describe('resolution is what decides the colour', () => {
  const withReference = (attribute: string) =>
    [
      'define',
      'attribute skill-id, value string;',
      `entity skill, owns ${attribute};`,
    ].join('\n');

  it('emits a token for a reference that resolved', async () => {
    const tokens = await semanticTokens(withReference('skill-id'));
    // Two occurrences: the declaration and the `owns` reference.
    expect(tokens.filter((t) => t.text === 'skill-id')).toHaveLength(2);
  });

  it('emits NO token for a reference that did not resolve', async () => {
    const tokens = await semanticTokens(withReference('nope-id'));
    expect(tokens.filter((t) => t.text === 'nope-id')).toHaveLength(0);
  });

  it('differs between the two, which is what an editor renders differently', async () => {
    const resolved = await semanticTokens(withReference('skill-id'));
    const unresolved = await semanticTokens(withReference('nope-id'));
    // Same structure, same length of source, one fewer token — the difference is resolution and
    // nothing else.
    expect(unresolved).toHaveLength(resolved.length - 1);
  });

  it('does not colour an unresolved role reference either', async () => {
    const tokens = await semanticTokens(
      ['define', 'entity principal, plays nothing:nowhere;'].join('\n'),
    );
    expect(tokens.filter((t) => t.text === 'nothing')).toHaveLength(0);
    expect(tokens.filter((t) => t.text === 'nowhere')).toHaveLength(0);
  });
});

describe('the production schemas are fully classified', () => {
  it.each([
    [
      'iam.schema.typeqlite',
      join(LIBS, 'platform/iam/infrastructure/src/lib/iam.schema.typeqlite'),
      ['principal', 'organization', 'membership'],
    ],
    [
      'skills.schema.typeqlite',
      join(
        LIBS,
        'platform/skills/infrastructure/src/lib/skills.schema.typeqlite',
      ),
      ['skill', 'skill-step', 'step-dependency'],
    ],
  ])('%s declares %s as types', async (_name, path, expected) => {
    const tokens = await semanticTokens(read(path));
    const types = tokens.filter((t) => t.type === 'type').map((t) => t.text);
    for (const name of expected) expect(types).toContain(name);
    // 🔴 Nothing is left unclassified by accident: a comment is hidden, so no token should carry
    // one, and no token should be empty.
    expect(tokens.every((t) => t.text.length > 0)).toBe(true);
    expect(tokens.some((t) => t.text.startsWith('#'))).toBe(false);
  });
});
