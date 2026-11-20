import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from 'vscode-jsonrpc/node';

/**
 * The BUNDLED server (`out/language-server/main.cjs`), driven over stdio, the way an editor drives
 * it.
 *
 * The language library's specs prove the services. This spec proves that the bundle carries them,
 * and that `startLanguageServer` advertises them. The failure it guards against is the quiet one: a
 * provider that passes every spec and never reaches a client, because a capability was not advertised
 * or a module did not make it into the bundle.
 */
const SERVER = resolve(__dirname, '../out/language-server/main.cjs');

type Diagnostic = {
  severity: number;
  code?: string;
  message: string;
  range: { start: { line: number; character: number } };
};

let server: ChildProcess;
let connection: MessageConnection;
let capabilities: Record<string, any>;
const published = new Map<string, Diagnostic[]>();

const DOCUMENTS = {
  // `@key` on one `owns` and not the other: a validator error, and one the runtime refuses too.
  'file:///workspace/invalid.typeqlite': [
    'define',
    'attribute name, value string;',
    'entity person, owns name, owns name @key;',
    '',
  ].join('\n'),
  'file:///workspace/messy.typeqlite': [
    'define',
    'entity   project ,   owns project-id   @key ;',
    'attribute   project-id ,  value string ;',
    '',
  ].join('\n'),
  // A schema split across two files (ADR-008 D3). `missing-attr` is defined nowhere, so exactly one
  // diagnostic proves `employee-name` resolved into the other file.
  'file:///workspace/split-attributes.typeqlite': 'define attribute employee-name, value string;\n',
  'file:///workspace/split-people.typeqlite':
    'define entity employee, owns employee-name, owns missing-attr;\n',
  'file:///workspace/resolution.typeqlite': [
    'define',
    'attribute project-id, value string;',
    'entity project, owns project-id, owns nope-id;',
    '',
  ].join('\n'),
};

/** Resolves once the server has published diagnostics for every document opened. */
const allPublished = () =>
  new Promise<void>((done) => {
    const check = () =>
      Object.keys(DOCUMENTS).every((uri) => published.has(uri)) ? done() : setTimeout(check, 20);
    check();
  });

beforeAll(async () => {
  server = spawn(process.execPath, [SERVER, '--stdio'], { stdio: 'pipe' });
  connection = createMessageConnection(
    new StreamMessageReader(server.stdout!),
    new StreamMessageWriter(server.stdin!),
  );
  connection.onNotification('textDocument/publishDiagnostics', (params) => {
    published.set(params.uri, params.diagnostics);
  });
  // Langium asks the client for configuration. An answer of "nothing" is a valid one.
  connection.onRequest(() => null);
  connection.listen();

  const result = await connection.sendRequest<{ capabilities: Record<string, any> }>(
    'initialize',
    { processId: process.pid, rootUri: null, workspaceFolders: null, capabilities: {} },
  );
  capabilities = result.capabilities;
  await connection.sendNotification('initialized', {});
  for (const [uri, text] of Object.entries(DOCUMENTS)) {
    await connection.sendNotification('textDocument/didOpen', {
      textDocument: { uri, languageId: 'typeqlite', version: 1, text },
    });
  }
  await allPublished();
});

/** Diagnostics settle: each opened document rebuilds the workspace, and may republish. */
async function settled(uri: string, expected: number, timeout = 10_000): Promise<Diagnostic[]> {
  const started = Date.now();
  while ((published.get(uri)?.length ?? -1) !== expected && Date.now() - started < timeout) {
    await new Promise((done) => setTimeout(done, 20));
  }
  return published.get(uri) ?? [];
}

afterAll(() => {
  connection?.dispose();
  server?.kill();
});

describe('the bundled language server', () => {
  it('advertises formatting and semantic tokens', () => {
    expect(capabilities['documentFormattingProvider']).toBeTruthy();
    expect(capabilities['semanticTokensProvider']?.legend?.tokenTypes).toContain('property');
  });

  it('publishes the validator’s diagnostic, with its code and position', () => {
    const [problem, ...rest] = published.get('file:///workspace/invalid.typeqlite')!;
    expect(rest).toEqual([]);
    expect(problem.severity).toBe(1);
    expect(problem.code).toBe('typedblite.duplicate-owns');
    expect(problem.range.start).toEqual({ line: 2, character: 31 });
  });

  it('publishes nothing for a valid document', () => {
    expect(published.get('file:///workspace/messy.typeqlite')).toEqual([]);
  });

  it('resolves a reference into another open document', async () => {
    const diagnostics = await settled('file:///workspace/split-people.typeqlite', 1);
    expect(diagnostics.map((d) => d.message)).toEqual([
      "Could not resolve reference to AttributeDef named 'missing-attr'.",
    ]);
  });

  it('formats a document', async () => {
    const edits = await connection.sendRequest<unknown[]>('textDocument/formatting', {
      textDocument: { uri: 'file:///workspace/messy.typeqlite' },
      options: { tabSize: 2, insertSpaces: true },
    });
    expect(edits.length).toBeGreaterThan(0);
  });

  it('colors a resolved reference and not an unresolved one', async () => {
    const legend: string[] = capabilities['semanticTokensProvider'].legend.tokenTypes;
    const { data } = await connection.sendRequest<{ data: number[] }>(
      'textDocument/semanticTokens/full',
      { textDocument: { uri: 'file:///workspace/resolution.typeqlite' } },
    );
    // Decode the relative five-tuples into absolute positions.
    const tokens: { line: number; character: number; type: string }[] = [];
    let line = 0;
    let character = 0;
    for (let i = 0; i < data.length; i += 5) {
      line += data[i]!;
      character = data[i] === 0 ? character + data[i + 1]! : data[i + 1]!;
      tokens.push({ line, character, type: legend[data[i + 3]!]! });
    }
    const on = (character: number) => tokens.find((t) => t.line === 2 && t.character === character);
    // `entity project, owns project-id, owns nope-id;`: project-id at 21, nope-id at 38.
    expect(on(21)?.type).toBe('property');
    expect(on(38)).toBeUndefined();
    expect(published.get('file:///workspace/resolution.typeqlite')!.map((d) => d.message)).toEqual([
      "Could not resolve reference to AttributeDef named 'nope-id'.",
    ]);
  });
});
