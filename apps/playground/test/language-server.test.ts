import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { createConnection, StreamMessageReader, StreamMessageWriter } from 'vscode-languageserver/node';
import { createMessageConnection, StreamMessageReader as ClientReader, StreamMessageWriter as ClientWriter, type MessageConnection } from 'vscode-jsonrpc/node';
import { serve } from '../src/language-server';

/**
 * The playground's language server over the real protocol: a client and `serve()` joined by a pair of
 * streams, the way the page joins them with a worker's message port. What Monaco's LSP client can show
 * is exactly what this answers.
 */
const URI = 'file:///playground.tql';
const SCHEMA = 'define\n  attribute name, value string;\n  entity person, owns name @key;\n  relation knows, relates friend;\n';

let client: MessageConnection;
let capabilities: Record<string, any>;
const published = new Map<string, any[]>();

beforeAll(async () => {
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  serve(createConnection(new StreamMessageReader(toServer), new StreamMessageWriter(toClient)));
  client = createMessageConnection(new ClientReader(toClient), new ClientWriter(toServer));
  client.onNotification('textDocument/publishDiagnostics', (params: { uri: string; diagnostics: any[] }) => published.set(params.uri, params.diagnostics));
  client.onRequest(() => null); // Langium asks the client for configuration; "nothing" is an answer.
  client.listen();
  const init = await client.sendRequest<{ capabilities: Record<string, any> }>('initialize', { processId: null, rootUri: null, workspaceFolders: null, capabilities: {} });
  capabilities = init.capabilities;
  await client.sendNotification('initialized', {});
});
afterAll(() => client.dispose());

let version = 0;
const open = async (text: string) => {
  published.delete(URI);
  version += 1;
  if (version === 1) await client.sendNotification('textDocument/didOpen', { textDocument: { uri: URI, languageId: 'typeqlite', version, text } });
  else await client.sendNotification('textDocument/didChange', { textDocument: { uri: URI, version }, contentChanges: [{ text }] });
  const started = Date.now();
  while (!published.has(URI) && Date.now() - started < 10_000) await new Promise((done) => setTimeout(done, 20));
  return published.get(URI) ?? [];
};
const at = (text: string, needle: string, offset = 0) => {
  const index = text.indexOf(needle) + offset;
  const before = text.slice(0, index).split('\n');
  return { line: before.length - 1, character: before.at(-1)!.length };
};

/** Apply LSP text edits, last first, so an earlier edit does not move a later one. */
const applyEdits = (text: string, edits: { range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string }[]) => {
  const lines = text.split('\n');
  const offsetOf = ({ line, character }: { line: number; character: number }) => lines.slice(0, line).reduce((n, l) => n + l.length + 1, 0) + character;
  return [...edits].sort((a, b) => offsetOf(b.range.start) - offsetOf(a.range.start)).reduce((out, e) => out.slice(0, offsetOf(e.range.start)) + e.newText + out.slice(offsetOf(e.range.end)), text);
};

describe('what the server offers the editor', () => {
  it.each([
    'completionProvider', 'hoverProvider', 'definitionProvider', 'referencesProvider', 'renameProvider',
    'codeActionProvider', 'documentSymbolProvider', 'documentFormattingProvider', 'foldingRangeProvider', 'semanticTokensProvider',
  ])('advertises %s', (capability) => {
    expect(capabilities[capability]).toBeTruthy();
  });

  it('describes its semantic tokens, so the editor can color them', () => {
    const legend = capabilities['semanticTokensProvider'].legend;
    expect(legend.tokenTypes).toEqual(expect.arrayContaining(['type', 'property', 'variable']));
    expect(capabilities['semanticTokensProvider'].full).toBeTruthy();
  });
});

describe('what it answers', () => {
  it('reports an error in the program, with its range', async () => {
    const diagnostics = await open(`${SCHEMA}\nmatch $p isa ;`);
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics[0].range.start.line).toBeGreaterThanOrEqual(0);
    expect(diagnostics[0].severity).toBe(1);
  });

  it('reports nothing for a valid program', async () => {
    const text = `${SCHEMA}\nmatch $p isa person, has name $n; select $n;`;
    expect(await open(text)).toEqual([]);
  });

  it('completes the types the program defines after `isa`', async () => {
    const text = `${SCHEMA}\nmatch $p isa `;
    await open(text);
    const list = await client.sendRequest<any>('textDocument/completion', { textDocument: { uri: URI }, position: at(text, 'match $p isa ', 'match $p isa '.length) });
    const labels = (Array.isArray(list) ? list : list.items).map((item: { label: string }) => item.label);
    expect(labels).toEqual(expect.arrayContaining(['person', 'knows']));
  });

  it('shows what a name is on hover, from its definition', async () => {
    const text = `${SCHEMA}\nmatch $p isa person;`;
    await open(text);
    const hover = await client.sendRequest<any>('textDocument/hover', { textDocument: { uri: URI }, position: at(text, 'isa person', 'isa '.length + 1) });
    expect(JSON.stringify(hover)).toContain('person');
  });

  it('goes to a definition, and finds references', async () => {
    const text = `${SCHEMA}\nmatch $p isa person;`;
    await open(text);
    const where = at(text, 'isa person', 'isa '.length + 1);
    const definition = await client.sendRequest<any>('textDocument/definition', { textDocument: { uri: URI }, position: where });
    // A definition is a location or a link to one, depending on what the client said it can take.
    expect([definition].flat().some((d: any) => (d.targetRange ?? d.range).start.line === 2)).toBe(true);
    const references = await client.sendRequest<any[]>('textDocument/references', { textDocument: { uri: URI }, position: where, context: { includeDeclaration: true } });
    expect(references.length).toBeGreaterThanOrEqual(2);
  });

  it('formats the program', async () => {
    const text = 'define   attribute   name ,  value   string ;';
    await open(text);
    const edits = await client.sendRequest<any[]>('textDocument/formatting', { textDocument: { uri: URI }, options: { tabSize: 2, insertSpaces: true } });
    expect(edits.length).toBeGreaterThan(0);
    expect(applyEdits(text, edits)).toContain('attribute name, value string;');
  });

  it('answers semantic tokens for the names it resolved', async () => {
    const text = `${SCHEMA}\nmatch $p isa person, has name $n;`;
    await open(text);
    const tokens = await client.sendRequest<{ data: number[] }>('textDocument/semanticTokens/full', { textDocument: { uri: URI } });
    expect(tokens.data.length).toBeGreaterThan(0);
    expect(tokens.data.length % 5).toBe(0);
  });

  it('renames a type everywhere it is used', async () => {
    const text = `${SCHEMA}\nmatch $p isa person;`;
    await open(text);
    const edit = await client.sendRequest<{ changes?: Record<string, { newText: string }[]>; documentChanges?: any[] }>('textDocument/rename', { textDocument: { uri: URI }, position: at(text, 'isa person', 'isa '.length + 1), newName: 'human' });
    const edits = edit.changes?.[URI] ?? edit.documentChanges?.flatMap((c) => c.edits) ?? [];
    expect(edits.length).toBeGreaterThanOrEqual(2);
    expect(edits.every((e: { newText: string }) => e.newText === 'human')).toBe(true);
  });
});
