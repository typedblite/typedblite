import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { semanticTokens } from './parse.js';

const SCHEMAS = join(process.cwd(), '..', '..', 'test-fixtures', 'schemas');
const read = (path: string) => readFileSync(path, 'utf8');

const SCHEMA = [
  'define',
  'attribute project-id, value string;',
  'entity project, owns project-id @key;',
].join('\n');

describe('declarations are classified', () => {
  it('names an entity as a declared type and an attribute as a declared property', async () => {
    const tokens = await semanticTokens(SCHEMA);
    expect(tokens).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'type', text: 'project' }),
        expect.objectContaining({ type: 'property', text: 'project-id' }),
      ]),
    );
    // The declaration modifier is set on the definition, so a declaration and a reference to it
    // are distinguishable even though both are the same token type.
    const declared = tokens.filter((t) => t.modifiers !== 0).map((t) => t.text);
    expect(declared).toContain('project');
    expect(declared).toContain('project-id');
  });

  it('classifies variables, role players and literals in a query', async () => {
    const tokens = await semanticTokens(
      'match $s isa project, has project-id "abc"; select $s;',
    );
    const byText = new Map(tokens.map((t) => [t.text, t.type]));
    expect(byText.get('$s')).toBe('variable');
    expect(byText.get('project')).toBe('type');
    expect(byText.get('project-id')).toBe('property');
    expect(byText.get('"abc"')).toBe('string');
  });
});

/**
 * 🔴 The assertion this phase exists for.
 *
 * A TextMate grammar colours `project-id` and `nope-id` identically — it is a regex, and neither is
 * a keyword. The scope provider knows one resolves and the other does not, and until now that
 * knowledge was thrown away at exactly the point it would be most useful.
 */
describe('resolution is what decides the colour', () => {
  const withReference = (attribute: string) =>
    [
      'define',
      'attribute project-id, value string;',
      `entity project, owns ${attribute};`,
    ].join('\n');

  it('emits a token for a reference that resolved', async () => {
    const tokens = await semanticTokens(withReference('project-id'));
    // Two occurrences: the declaration and the `owns` reference.
    expect(tokens.filter((t) => t.text === 'project-id')).toHaveLength(2);
  });

  it('emits NO token for a reference that did not resolve', async () => {
    const tokens = await semanticTokens(withReference('nope-id'));
    expect(tokens.filter((t) => t.text === 'nope-id')).toHaveLength(0);
  });

  it('differs between the two, which is what an editor renders differently', async () => {
    const resolved = await semanticTokens(withReference('project-id'));
    const unresolved = await semanticTokens(withReference('nope-id'));
    // Same structure, same length of source, one fewer token — the difference is resolution and
    // nothing else.
    expect(unresolved).toHaveLength(resolved.length - 1);
  });

  it('does not colour an unresolved role reference either', async () => {
    const tokens = await semanticTokens(
      ['define', 'entity person, plays nothing:nowhere;'].join('\n'),
    );
    expect(tokens.filter((t) => t.text === 'nothing')).toHaveLength(0);
    expect(tokens.filter((t) => t.text === 'nowhere')).toHaveLength(0);
  });
});

describe('the production schemas are fully classified', () => {
  it.each([
    [
      'people.schema.typeqlite',
      join(SCHEMAS, 'people.schema.typeqlite'),
      ['person', 'team', 'membership'],
    ],
    [
      'tracker.schema.typeqlite',
      join(SCHEMAS, 'tracker.schema.typeqlite'),
      ['project', 'task', 'task-dependency'],
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

/**
 * 🔴 A notebook asks for the tokens of every cell at once, and each cell is a document. Langium's provider
 * keeps the document it is working on in a field, so overlapping requests used to write one another's
 * tokens into their responses.
 */
describe('requests that overlap', () => {
  it('each answer is the tokens of its own document', async () => {
    const { parseHelper } = await import('langium/test');
    const { SemanticTokensDecoder } = await import('langium/lsp');
    const { EmptyFileSystem } = await import('langium');
    const { createTypeQLiteServices } = await import('../src/typeqlite-module.js');
    const { TypeQLite } = createTypeQLiteServices(EmptyFileSystem);
    const helper = parseHelper(TypeQLite);
    const provider = TypeQLite.lsp.SemanticTokenProvider!;
    const texts = [
      'define\n  entity book, owns title;\n  attribute title, value string;',
      'match $b isa book, has title "Dune"; select $b;',
      'match $b isa book; select $b;',
    ];
    const documents = await Promise.all(texts.map((text) => helper(text, { validation: true })));
    const decode = (document: (typeof documents)[number], tokens: Awaited<ReturnType<typeof provider.semanticHighlight>>) =>
      SemanticTokensDecoder.decode(tokens, provider.tokenTypes, document).map((t) => t.text);
    const together = await Promise.all(
      documents.map((document) => provider.semanticHighlight(document, { textDocument: { uri: document.textDocument.uri } })),
    );
    for (const [index, document] of documents.entries()) {
      const alone = await provider.semanticHighlight(document, { textDocument: { uri: document.textDocument.uri } });
      expect(decode(document, together[index]!)).toEqual(decode(document, alone));
    }
  });
});
