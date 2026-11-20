import { SymbolKind } from 'vscode-languageserver';
import { describe, expect, it } from 'vitest';
import { docCommentOf } from '../src/typeqlite-doc-comments.js';
import { uriOf, workspace } from './workspace.js';

/**
 * Navigation across one workspace's schema (ADR-008 D3): definition, references, the outline,
 * workspace symbols, hover and folding, each asked of the services as an editor asks them.
 */
const FILES = {
  'people.typeqlite': [
    'define',
    '#! Someone the organization knows about.',
    '#! Employees are people too.',
    'entity person @doc("A human being"),',
    '  owns name,',
    '  plays employment:employee;',
    'entity student sub person;',
    '',
  ].join('\n'),
  'shared.typeqlite': [
    'define',
    'attribute name, value string;',
    'relation employment, relates employee, relates employer;',
    '',
  ].join('\n'),
  'reopens.typeqlite': ['define', 'employment relates manager;', ''].join('\n'),
};

const lsp = (ws: Awaited<ReturnType<typeof workspace>>) => ws.services.TypeQLite.lsp;

describe('go to definition', () => {
  it('jumps from `owns name` to the attribute in another file', async () => {
    const ws = await workspace(FILES);
    const links = await lsp(ws).DefinitionProvider!.getDefinition(
      ws.documentOf('people.typeqlite'),
      ws.at('people.typeqlite', 'name'),
    );
    expect(links?.map((link) => link.targetUri)).toEqual([uriOf('shared.typeqlite').toString()]);
    expect(links?.[0]?.targetSelectionRange.start).toEqual({ line: 1, character: 10 });
  });

  it('jumps from a role to the `relates` that declares it', async () => {
    const ws = await workspace(FILES);
    const links = await lsp(ws).DefinitionProvider!.getDefinition(
      ws.documentOf('people.typeqlite'),
      ws.at('people.typeqlite', 'employee'),
    );
    expect(links?.[0]?.targetUri).toBe(uriOf('shared.typeqlite').toString());
    expect(links?.[0]?.targetSelectionRange.start).toEqual({ line: 2, character: 29 });
  });
});

describe('find references', () => {
  it('finds a type’s uses in every file, and its declaration', async () => {
    const ws = await workspace({
      ...FILES,
      'more.typeqlite': 'define entity teacher sub person;',
    });
    const locations = await lsp(ws).ReferencesProvider!.findReferences(
      ws.documentOf('people.typeqlite'),
      { ...ws.at('people.typeqlite', 'person'), context: { includeDeclaration: true } },
    );
    const where = locations.map((l) => `${l.uri.split('/').pop()}:${l.range.start.line}`).sort();
    expect(where).toEqual(['more.typeqlite:0', 'people.typeqlite:3', 'people.typeqlite:6']);
  });
});

describe('the outline', () => {
  it('lists definitions with their kinds, and roles under their relation', async () => {
    const ws = await workspace(FILES);
    const symbols = await lsp(ws).DocumentSymbolProvider!.getSymbols(
      ws.documentOf('shared.typeqlite'),
      { textDocument: { uri: uriOf('shared.typeqlite').toString() } },
    );
    expect(symbols.map((s) => [s.name, s.kind, s.detail])).toEqual([
      ['name', SymbolKind.Property, 'attribute'],
      ['employment', SymbolKind.Interface, 'relation'],
    ]);
    expect(symbols[1]!.children?.map((c) => [c.name, c.kind])).toEqual([
      ['employee', SymbolKind.EnumMember],
      ['employer', SymbolKind.EnumMember],
    ]);
  });

  it('shows a re-open under the label it re-opens, with the role it adds', async () => {
    const ws = await workspace(FILES);
    const symbols = await lsp(ws).DocumentSymbolProvider!.getSymbols(
      ws.documentOf('reopens.typeqlite'),
      { textDocument: { uri: uriOf('reopens.typeqlite').toString() } },
    );
    expect(symbols.map((s) => [s.name, s.detail])).toEqual([['employment', 're-open']]);
    expect(symbols[0]!.children?.map((c) => c.name)).toEqual(['manager']);
  });
});

describe('workspace symbols', () => {
  it('finds definitions from every file', async () => {
    const ws = await workspace(FILES);
    const provider = ws.services.shared.lsp.WorkspaceSymbolProvider!;
    const symbols = await provider.getSymbols({ query: '' });
    const names = symbols.map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(['person', 'student', 'name', 'employment']));
  });
});

describe('hover', () => {
  const hover = async (ws: Awaited<ReturnType<typeof workspace>>, name: string, needle: string, n = 0) => {
    const result = await lsp(ws).HoverProvider!.getHoverContent(ws.documentOf(name), ws.at(name, needle, n));
    return result && typeof result.contents === 'object' && 'value' in result.contents
      ? result.contents.value
      : undefined;
  };

  it('over a reference shows the definition it resolves to, from another file', async () => {
    const ws = await workspace(FILES);
    const value = await hover(ws, 'people.typeqlite', 'name');
    expect(value).toContain('```typeqlite\nattribute name, value string;\n```');
  });

  it('shows the `#!` doc comment and the `@doc` text', async () => {
    const ws = await workspace(FILES);
    const value = await hover(ws, 'people.typeqlite', 'person', 1);
    expect(value).toContain('Someone the organization knows about.\nEmployees are people too.');
    expect(value).toContain('A human being');
  });

  it('over a relation names the files that re-open it', async () => {
    const ws = await workspace(FILES);
    const value = await hover(ws, 'people.typeqlite', 'employment');
    expect(value).toContain('Re-opened in `reopens.typeqlite:2`');
  });

  it('over a role names it with its relation', async () => {
    const ws = await workspace(FILES);
    const value = await hover(ws, 'people.typeqlite', 'employee');
    expect(value).toContain('**role** `employment:employee`');
  });

  it('reads the doc comment by the same rule the runtime stores it with', async () => {
    const ws = await workspace(FILES);
    const person = ws.documentOf('people.typeqlite').parseResult.value.clauses[0]!;
    const [definition] = (person as unknown as { definitions: { $cstNode?: never }[] }).definitions;
    expect(docCommentOf(definition!)).toBe(
      'Someone the organization knows about.\nEmployees are people too.',
    );
  });
});

describe('folding', () => {
  it('folds a definition that spans several lines', async () => {
    const ws = await workspace(FILES);
    const ranges = await lsp(ws).FoldingRangeProvider!.getFoldingRanges(
      ws.documentOf('people.typeqlite'),
      { textDocument: { uri: uriOf('people.typeqlite').toString() } },
    );
    expect(ranges).toEqual(expect.arrayContaining([expect.objectContaining({ startLine: 3 })]));
  });
});
