import { EmptyFileSystem } from 'langium';
import { describe, expect, it } from 'vitest';
import { createTypeQLiteServices } from '../src/typeqlite-module.js';
import { validateSync } from '../src/typeqlite-validate-sync.js';
import { TypeQLiteValidationCode } from '../src/typeqlite-validation-codes.js';
import type { TypeQLiteFile } from '../src/generated/ast.js';
import { uriOf, workspace } from './workspace.js';

/**
 * Labels that are plain `ID`s (ADR-008 D5): `isa person`, `has name`, a role player, a type pattern's
 * subject. They resolve against the workspace's schema in the editor, and nowhere else.
 */
const SCHEMA = [
  'define',
  'attribute name, value string;',
  'entity person, owns name, plays employment:employee, plays employment:employer;',
  'relation employment, relates employee, relates employer;',
  'relation contract sub employment;',
  '',
].join('\n');

const QUERY = [
  'match',
  '$p isa person, has name $n;',
  '$e isa employment (employee: $p);',
  '$c isa contract (employer: $p);',
  'person owns name;',
  '',
].join('\n');

const files = (query = QUERY) => ({ 'schema.typeqlite': SCHEMA, 'query.tql': query });
const lsp = (ws: Awaited<ReturnType<typeof workspace>>) => ws.services.TypeQLite.lsp;
const labels = (ws: Awaited<ReturnType<typeof workspace>>) => ws.services.TypeQLite.labels.Labels;

/** What the label at a needle resolves to: each target's type and the file it is in. */
async function resolved(ws: Awaited<ReturnType<typeof workspace>>, needle: string, n = 0) {
  const document = ws.documentOf('query.tql');
  const site = labels(ws).siteAt(document, document.textDocument.offsetAt(ws.positionOf('query.tql', needle, n)));
  return site ? labels(ws).resolve(site).map((node) => `${node.$type}:${(node as { name?: string }).name}`) : undefined;
}

describe('a label resolves to what it names', () => {
  it('`isa person` to the entity', async () => {
    expect(await resolved(await workspace(files()), 'person')).toEqual(['EntityDef:person']);
  });

  it('`has name` to the attribute', async () => {
    expect(await resolved(await workspace(files()), 'name')).toEqual(['AttributeDef:name']);
  });

  it('a role player to the role its relation relates', async () => {
    expect(await resolved(await workspace(files()), 'employee')).toEqual(['RelatesTrait:employee']);
  });

  it('a role player to a role its relation inherits', async () => {
    expect(await resolved(await workspace(files()), 'employer')).toEqual(['RelatesTrait:employer']);
  });

  it('a type pattern’s subject to the type', async () => {
    expect(await resolved(await workspace(files()), 'person', 1)).toEqual(['EntityDef:person']);
  });
});

describe('navigation from a label', () => {
  it('go to definition jumps into the schema file', async () => {
    const ws = await workspace(files());
    const links = await lsp(ws).DefinitionProvider!.getDefinition(ws.documentOf('query.tql'), ws.at('query.tql', 'person'));
    expect(links?.map((l) => [l.targetUri, l.targetSelectionRange.start.line])).toEqual([
      [uriOf('schema.typeqlite').toString(), 2],
    ]);
  });

  it('find references lists cross-references and labels together', async () => {
    const ws = await workspace(files());
    const locations = await lsp(ws).ReferencesProvider!.findReferences(ws.documentOf('schema.typeqlite'), {
      ...ws.at('schema.typeqlite', 'name'),
      context: { includeDeclaration: false },
    });
    const where = locations.map((l) => `${l.uri.split('/').pop()}:${l.range.start.line}`).sort();
    // `owns name` in the schema, `has name` and `person owns name` in the query.
    expect(where).toEqual(['query.tql:1', 'query.tql:4', 'schema.typeqlite:2']);
  });

  it('find references from a label finds the declaration and every use', async () => {
    const ws = await workspace(files());
    const locations = await lsp(ws).ReferencesProvider!.findReferences(ws.documentOf('query.tql'), {
      ...ws.at('query.tql', 'person'),
      context: { includeDeclaration: true },
    });
    const where = locations.map((l) => `${l.uri.split('/').pop()}:${l.range.start.line}`).sort();
    expect(where).toEqual(['query.tql:1', 'query.tql:4', 'schema.typeqlite:2']);
  });

  it('hover over a label shows the definition', async () => {
    const ws = await workspace(files());
    const hover = await lsp(ws).HoverProvider!.getHoverContent(ws.documentOf('query.tql'), ws.at('query.tql', 'person'));
    const value = hover && typeof hover.contents === 'object' && 'value' in hover.contents ? hover.contents.value : '';
    expect(value).toContain('entity person, owns name');
  });
});

describe('the unknown-label warning (ADR-008 D6)', () => {
  const unknown = (ws: Awaited<ReturnType<typeof workspace>>, name: string) =>
    ws.diagnostics(name).filter((d) => d.code === TypeQLiteValidationCode.unknownLabel);

  it('warns about a label the workspace’s schema does not define', async () => {
    const ws = await workspace(files('match $p isa persn;'));
    const [warning, ...rest] = unknown(ws, 'query.tql');
    expect(rest).toEqual([]);
    expect(warning?.severity).toBe(2);
    expect(warning?.message).toMatch(/No type 'persn'/);
  });

  it('warns about a role the named relation does not relate', async () => {
    const ws = await workspace(files('match $e isa employment (boss: $p);'));
    expect(unknown(ws, 'query.tql').map((d) => d.message)).toEqual([
      "No relation 'employment' in this workspace relates a role 'boss'.",
    ]);
  });

  it('says nothing in a workspace with no schema: the database may define it', async () => {
    const ws = await workspace({ 'query.tql': 'match $p isa persn;' });
    expect(ws.diagnostics('query.tql')).toEqual([]);
  });

  it('clears when a file defining the label is added', async () => {
    const ws = await workspace(files('match $s isa student;'));
    expect(unknown(ws, 'query.tql')).toHaveLength(1);
    await ws.put('students.typeqlite', 'define entity student sub person;');
    expect(unknown(ws, 'query.tql')).toEqual([]);
  });

  it('never reaches the runtime: `validateSync` does not report it (ADR-008 D2)', () => {
    const { TypeQLite } = createTypeQLiteServices(EmptyFileSystem);
    const parsed = TypeQLite.parser.LangiumParser.parse<TypeQLiteFile>(`${SCHEMA}\nmatch $p isa persn;`);
    const codes = validateSync(TypeQLite, parsed.value).map((d) => d.code);
    expect(codes).not.toContain(TypeQLiteValidationCode.unknownLabel);
  });
});

describe('semantic tokens', () => {
  it('with a schema, color a label only when it resolves', async () => {
    const ws = await workspace(files('match $p isa person; $q isa persn;'));
    const tokens = await ws.tokens('query.tql');
    expect(tokens).toContainEqual({ text: 'person', type: 'type' });
    expect(tokens.find((t) => t.text === 'persn')).toBeUndefined();
  });

  it('color a resolved label by what it names', async () => {
    const ws = await workspace(files());
    const tokens = await ws.tokens('query.tql');
    expect(tokens).toContainEqual({ text: 'name', type: 'property' });
    expect(tokens).toContainEqual({ text: 'employee', type: 'parameter' });
  });

  it('without a schema, color a label by its position, as before', async () => {
    const ws = await workspace({ 'query.tql': 'match $p isa persn, has nme $n;' });
    const tokens = await ws.tokens('query.tql');
    expect(tokens).toContainEqual({ text: 'persn', type: 'type' });
    expect(tokens).toContainEqual({ text: 'nme', type: 'property' });
  });
});
