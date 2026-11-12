import { describe, expect, it } from 'vitest';
import type { CodeAction } from 'vscode-languageserver';
import { editDistance } from '../src/typeqlite-edits.js';
import { TypeQLiteValidationCode } from '../src/typeqlite-validation-codes.js';
import { uriOf, workspace } from './workspace.js';

/**
 * Rename and quick fixes. Every edit is applied and the workspace rebuilt, so each case proves the
 * result is clean, not only that an edit was proposed.
 */
const FILES = {
  'schema.typeqlite': [
    'define',
    'attribute name, value string;',
    'entity person, owns name, plays employment:employee;',
    'relation employment, relates employee;',
    '',
  ].join('\n'),
  'more.typeqlite': 'define entity student sub person;\n',
  'query.tql': 'match $p isa person, has name $n; $e isa employment (employee: $p);\n',
};

type Workspace = Awaited<ReturnType<typeof workspace>>;
const rename = async (ws: Workspace, name: string, needle: string, newName: string, n = 0) =>
  ws.services.TypeQLite.lsp.RenameProvider!.rename(ws.documentOf(name), { ...ws.at(name, needle, n), newName });

describe('rename a type everywhere the workspace names it', () => {
  it.each([
    ['its declaration', 'schema.typeqlite', 'person', 0],
    ['a cross-reference in another file', 'more.typeqlite', 'person', 0],
    ['a label in a query', 'query.tql', 'person', 0],
  ])('starting from %s', async (_, file, needle, n) => {
    const ws = await workspace(FILES);
    await ws.apply(await rename(ws, file, needle, 'human', n));
    expect(ws.text('schema.typeqlite')).toContain('entity human, owns name');
    expect(ws.text('more.typeqlite')).toBe('define entity student sub human;\n');
    expect(ws.text('query.tql')).toContain('$p isa human,');
    expect(ws.problems()).toEqual({});
  });

  it('renames a role in its `plays` and its role players', async () => {
    const ws = await workspace(FILES);
    await ws.apply(await rename(ws, 'schema.typeqlite', 'employee', 'worker', 1));
    expect(ws.text('schema.typeqlite')).toContain('plays employment:worker;');
    expect(ws.text('schema.typeqlite')).toContain('relates worker;');
    expect(ws.text('query.tql')).toContain('(worker: $p)');
    expect(ws.problems()).toEqual({});
  });

  it('a label can be prepared for rename', async () => {
    const ws = await workspace(FILES);
    const range = await ws.services.TypeQLite.lsp.RenameProvider!.prepareRename(
      ws.documentOf('query.tql'),
      ws.at('query.tql', 'person'),
    );
    expect(range).toMatchObject({ start: { line: 0, character: 13 }, end: { line: 0, character: 19 } });
  });

  it.each([['two words'], ['9lives'], ['match']])('refuses %s as a new label', async (newName) => {
    const ws = await workspace(FILES);
    await expect(rename(ws, 'schema.typeqlite', 'person', newName)).rejects.toThrow(/not a TypeQLite label|reserved/);
  });
});

describe('quick fixes', () => {
  const actions = async (ws: Workspace, name: string, code: string) => {
    const diagnostics = ws.diagnostics(name).filter((d) => d.code === code || (d.data as { code?: string })?.code === code);
    expect(diagnostics.length, `a ${code} diagnostic in ${name}`).toBeGreaterThan(0);
    return (await ws.services.TypeQLite.lsp.CodeActionProvider!.getCodeActions(ws.documentOf(name), {
      textDocument: { uri: uriOf(name).toString() },
      range: diagnostics[0]!.range,
      context: { diagnostics },
    })) as CodeAction[];
  };

  it('removes an annotation the position does not admit', async () => {
    const ws = await workspace({ 'a.typeqlite': 'define entity player @card(1..1);\n' });
    const [fix] = await actions(ws, 'a.typeqlite', TypeQLiteValidationCode.annotationNotAdmitted);
    expect(fix?.title).toBe('Remove @card');
    await ws.apply(fix!.edit);
    expect(ws.text('a.typeqlite')).toBe('define entity player;\n');
    expect(ws.problems()).toEqual({});
  });

  it('offers both ways out of two annotations that disagree, preferring neither', async () => {
    const ws = await workspace({
      'a.typeqlite': 'define attribute name, value string; entity person, owns name @card(0..1) @card(1..2);\n',
    });
    const fixes = await actions(ws, 'a.typeqlite', TypeQLiteValidationCode.annotationRepeated);
    expect(fixes.map((f) => [f.title, f.isPreferred])).toEqual([
      ['Keep @card(0..1)', undefined],
      ['Keep @card(1..2)', undefined],
    ]);
    await ws.apply(fixes[1]!.edit);
    expect(ws.text('a.typeqlite')).toBe('define attribute name, value string; entity person, owns name @card(1..2);\n');
    expect(ws.problems()).toEqual({});
  });

  it('offers the nearest defined label for an unknown one', async () => {
    const ws = await workspace({ ...FILES, 'query.tql': 'match $p isa persn;\n' });
    const fixes = await actions(ws, 'query.tql', TypeQLiteValidationCode.unknownLabel);
    expect(fixes.map((f) => f.title)).toEqual(["Change to 'person'"]);
    await ws.apply(fixes[0]!.edit);
    expect(ws.problems()).toEqual({});
  });

  it('offers the nearest name for a reference that did not resolve', async () => {
    const ws = await workspace({ ...FILES, 'more.typeqlite': 'define entity student, owns nmae;\n' });
    const fixes = await actions(ws, 'more.typeqlite', 'linking-error');
    expect(fixes[0]?.title).toBe("Change to 'name'");
    await ws.apply(fixes[0]!.edit);
    expect(ws.problems()).toEqual({});
  });

  it('offers nothing where the fix is the writer’s to choose', async () => {
    const ws = await workspace({
      'a.typeqlite': 'define attribute name, value string; entity person, owns name, owns name @key;\n',
    });
    expect(await actions(ws, 'a.typeqlite', TypeQLiteValidationCode.duplicateOwns)).toEqual([]);
  });
});

describe('editDistance', () => {
  it.each([
    ['person', 'person', 0],
    ['persn', 'person', 1],
    ['nmae', 'name', 2],
    ['', 'abc', 3],
  ])('%s → %s is %i', (a, b, d) => expect(editDistance(a, b)).toBe(d));
});
