import { describe, expect, it } from 'vitest';
import { NOTEBOOK_CELL_SCHEME, sameSchema, schemaOwnerOf, WORKSPACE_OWNER } from '../src/typeqlite-schema-owner.js';
import { workspace } from './workspace.js';

/**
 * A notebook is a schema of its own (ADR-012 N4). Its cells share one schema, as the files of a workspace do (ADR-008
 * D3), and no other: not another notebook's, and not the workspace's. The cells are documents in the one index the
 * language server keeps, so what these cases prove is that a definition is visible only inside its own schema.
 */
// 🔴 A cell's real URI ends in the notebook's own `.tql.md`, and the server knows its language from the `languageId` the
// client syncs (the server spec covers that). This harness has no synced documents, so it falls back to the file
// extension, and the test notebooks are named `.tql`. Ownership is by the URI without its fragment either way.
const cell = (notebook: string, n: number) => `vscode-notebook-cell:/work/${notebook}.tql#cell${n}`;
const UNRESOLVED = /Could not resolve reference/;
const unresolved = (messages: string[]) => messages.filter((m) => UNRESOLVED.test(m));

describe('whose schema a document is part of', () => {
  it('a cell is its notebook\'s, whatever its fragment', () => {
    expect(schemaOwnerOf(cell('a', 1))).toBe(schemaOwnerOf(cell('a', 7)));
    expect(schemaOwnerOf(cell('a', 1))).not.toBe(schemaOwnerOf(cell('b', 1)));
    expect(sameSchema(cell('a', 1), cell('a', 2))).toBe(true);
    expect(sameSchema(cell('a', 1), cell('b', 1))).toBe(false);
  });

  it('anything else is the workspace\'s', () => {
    expect(schemaOwnerOf('file:///workspace/schema.typeqlite')).toBe(WORKSPACE_OWNER);
    expect(schemaOwnerOf('untitled:Untitled-1')).toBe(WORKSPACE_OWNER);
    expect(sameSchema('file:///a.tql', 'file:///b/c.tql')).toBe(true);
    expect(sameSchema('file:///a.tql', cell('a', 1))).toBe(false);
  });

  it('is by the notebook\'s own URI, so an `.md` notebook is told from a `.tql.md` one', () => {
    expect(schemaOwnerOf('vscode-notebook-cell:/work/guide.md#c1')).not.toBe(schemaOwnerOf('vscode-notebook-cell:/work/guide.tql.md#c1'));
    expect(NOTEBOOK_CELL_SCHEME).toBe('vscode-notebook-cell');
  });
});

describe('cells of one notebook resolve each other', () => {
  it('`owns`, `sub` and `plays` name what another cell defines', async () => {
    const ws = await workspace({
      [cell('a', 1)]: 'define attribute name, value string; entity person, owns name;',
      [cell('a', 2)]: 'define entity student sub person, owns name;',
      [cell('a', 3)]: 'define relation employment, relates employee;',
      [cell('a', 4)]: 'define entity worker, plays employment:employee;',
    });
    for (let n = 1; n <= 4; n += 1) expect(ws.messages(cell('a', n))).toEqual([]);
  });

  it('a role added by a re-open in another cell is a role of that relation', async () => {
    const ws = await workspace({
      [cell('a', 1)]: 'define relation employment, relates employee;',
      [cell('a', 2)]: 'define employment relates manager;',
      [cell('a', 3)]: 'define entity person, plays employment:manager;',
    });
    expect(ws.messages(cell('a', 3))).toEqual([]);
  });

  it('a label no cell defines is still refused', async () => {
    const ws = await workspace({
      [cell('a', 1)]: 'define entity person;',
      [cell('a', 2)]: 'define entity worker, owns missing;',
    });
    expect(unresolved(ws.messages(cell('a', 2)))).toHaveLength(1);
  });

  it('a query label resolves into another cell\'s schema, and an unknown one is a warning', async () => {
    const ws = await workspace({
      [cell('a', 1)]: 'define attribute name, value string; entity person, owns name;',
      [cell('a', 2)]: 'match $p isa person, has name $n; select $n;',
      [cell('a', 3)]: 'match $p isa persn; select $p;',
    });
    expect(ws.messages(cell('a', 2))).toEqual([]);
    expect(ws.messages(cell('a', 3))).toEqual([expect.stringContaining("'persn'")]);
  });
});

// 🔴 The point of N4. Without it, two notebooks in one workspace share a schema, and so do a notebook and a file.
describe('a notebook\'s schema is its own', () => {
  it('another notebook does not see it', async () => {
    const ws = await workspace({
      [cell('a', 1)]: 'define attribute name, value string;',
      [cell('b', 1)]: 'define entity person, owns name;',
    });
    expect(unresolved(ws.messages(cell('b', 1)))).toHaveLength(1);
  });

  it('a workspace file does not see a cell, and a cell does not see a file', async () => {
    const ws = await workspace({
      'schema.typeqlite': 'define attribute name, value string;',
      [cell('a', 1)]: 'define attribute age, value integer;',
      'people.typeqlite': 'define entity person, owns name, owns age;',
      [cell('a', 2)]: 'define entity worker, owns name, owns age;',
    });
    expect(unresolved(ws.messages('people.typeqlite'))).toHaveLength(1); // `age` is a cell's
    expect(unresolved(ws.messages(cell('a', 2)))).toHaveLength(1); // `name` is a file's
  });

  it('two notebooks may define one label, and each resolves its own', async () => {
    const ws = await workspace({
      [cell('a', 1)]: 'define entity person;',
      [cell('a', 2)]: 'define entity student sub person;',
      [cell('b', 1)]: 'define entity person, owns nothing;',
      [cell('b', 2)]: 'define entity teacher sub person;',
    });
    expect(ws.messages(cell('a', 2))).toEqual([]);
    expect(ws.messages(cell('b', 2))).toEqual([]);
  });

  it('a notebook with no schema flags no query label, though the workspace has one (ADR-008 D6)', async () => {
    const ws = await workspace({
      'schema.typeqlite': 'define entity person;',
      [cell('a', 1)]: 'match $x isa anything; select $x;',
    });
    expect(ws.messages(cell('a', 1))).toEqual([]);
  });

  it('a workspace file with no schema of its own flags no query label, though a notebook has one', async () => {
    const ws = await workspace({
      [cell('a', 1)]: 'define entity person;',
      'query.tql': 'match $x isa anything; select $x;',
    });
    expect(ws.messages('query.tql')).toEqual([]);
  });

  it('a re-open in another notebook does not add a role', async () => {
    const ws = await workspace({
      [cell('a', 1)]: 'define relation employment, relates employee;',
      [cell('b', 1)]: 'define employment relates manager;',
      [cell('a', 2)]: 'define entity person, plays employment:manager;',
    });
    expect(unresolved(ws.messages(cell('a', 2)))).toHaveLength(1);
  });
});

describe('the services that read the index stay inside the schema', () => {
  const complete = async (ws: Awaited<ReturnType<typeof workspace>>, name: string, text: string) => {
    const document = ws.documentOf(name);
    const list = await ws.services.TypeQLite.lsp.CompletionProvider!.getCompletion(document, {
      textDocument: { uri: document.uri.toString() },
      position: document.textDocument.positionAt(text.indexOf('|')),
    });
    return (list?.items ?? []).map((item) => item.label);
  };

  it('completion in a cell offers its notebook\'s definitions and no others', async () => {
    const text = 'match $p isa |';
    const ws = await workspace({
      'schema.typeqlite': 'define entity from-the-workspace;',
      [cell('a', 1)]: 'define entity from-this-notebook;',
      [cell('b', 1)]: 'define entity from-another-notebook;',
      [cell('a', 2)]: text.replace('|', ''),
    });
    const offered = await complete(ws, cell('a', 2), text);
    expect(offered).toContain('from-this-notebook');
    expect(offered).not.toContain('from-the-workspace');
    expect(offered).not.toContain('from-another-notebook');
  });

  it('completion in a file offers the workspace\'s definitions, and no cell\'s', async () => {
    const text = 'match $p isa |';
    const ws = await workspace({
      'schema.typeqlite': 'define entity from-the-workspace;',
      [cell('a', 1)]: 'define entity from-a-notebook;',
      'typing.tql': text.replace('|', ''),
    });
    const offered = await complete(ws, 'typing.tql', text);
    expect(offered).toContain('from-the-workspace');
    expect(offered).not.toContain('from-a-notebook');
  });

  it('go to definition crosses cells', async () => {
    const ws = await workspace({
      [cell('a', 1)]: 'define attribute name, value string;',
      [cell('a', 2)]: 'define entity person, owns name;',
    });
    const found = await ws.services.TypeQLite.lsp.DefinitionProvider!.getDefinition(ws.documentOf(cell('a', 2)), ws.at(cell('a', 2), 'name'));
    expect(found).toHaveLength(1);
    expect((found![0] as { targetUri: string }).targetUri).toBe(cell('a', 1));
  });

  it('rename changes the notebook\'s uses and leaves another notebook\'s, and the workspace\'s, alone', async () => {
    const ws = await workspace({
      'schema.typeqlite': 'define entity person;',
      [cell('a', 1)]: 'define entity person;',
      [cell('a', 2)]: 'define entity student sub person;',
      [cell('b', 1)]: 'define entity person;',
      [cell('b', 2)]: 'define entity teacher sub person;',
    });
    const edit = await ws.services.TypeQLite.lsp.RenameProvider!.rename(ws.documentOf(cell('a', 1)), { ...ws.at(cell('a', 1), 'person'), newName: 'human' });
    expect(Object.keys(edit?.changes ?? {}).sort()).toEqual([cell('a', 1), cell('a', 2)]);
  });

  it('hover lists the re-opens of its own notebook, and not another\'s', async () => {
    const ws = await workspace({
      [cell('a', 1)]: 'define relation employment, relates employee;',
      [cell('a', 2)]: 'define employment relates manager;',
      [cell('b', 1)]: 'define employment relates director;',
    });
    const hover = await ws.services.TypeQLite.lsp.HoverProvider!.getHoverContent(ws.documentOf(cell('a', 1)), { ...ws.at(cell('a', 1), 'employment') });
    const text = JSON.stringify(hover?.contents);
    expect(text).toContain('Re-opened in');
    // One re-open is named, and it is the first notebook's: `a.tql`, its own two cells' file, not `b.tql`.
    expect(text.match(/\.tql:\d+/g)).toHaveLength(1);
    expect(text).toContain('a.tql:1');
  });

  it('a quick fix suggests a label of its own schema', async () => {
    const ws = await workspace({
      'schema.typeqlite': 'define entity persona;',
      [cell('a', 1)]: 'define entity person;',
      [cell('a', 2)]: 'match $p isa persn; select $p;',
    });
    const document = ws.documentOf(cell('a', 2));
    const actions = await ws.services.TypeQLite.lsp.CodeActionProvider!.getCodeActions(document, {
      textDocument: { uri: document.uri.toString() },
      range: document.diagnostics![0]!.range,
      context: { diagnostics: document.diagnostics! },
    });
    const titles = (actions ?? []).map((action) => (action as { title: string }).title);
    expect(titles).toContain("Change to 'person'");
    expect(titles).not.toContain("Change to 'persona'");
  });
});
