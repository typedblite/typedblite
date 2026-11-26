import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';

import { createMessageConnection, StreamMessageReader, StreamMessageWriter, type MessageConnection } from 'vscode-jsonrpc/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The BUNDLED language server, given real notebooks over stdio the way VS Code sends them (ADR-012 N4): cells with
 * `vscode-notebook-cell:` URIs that end in the notebook's own `.tql.md`, whose language the server knows from the
 * `languageId` the client syncs. The language library's specs prove a notebook's schema is its own; this proves the
 * bundle advertises notebooks, builds the cells, and keeps the schemas apart.
 */
const SERVER = resolve(__dirname, '../out/language-server/main.cjs');

type Diagnostic = { severity: number; message: string };
let server: ChildProcess;
let connection: MessageConnection;
let capabilities: Record<string, any>;
const published = new Map<string, Diagnostic[]>();

const cell = (notebook: string, n: number) => `vscode-notebook-cell:/work/${notebook}.tql.md#cell${n}`;
const notebookUri = (notebook: string) => `file:///work/${notebook}.tql.md`;

async function openNotebook(notebook: string, type: string, cells: string[]): Promise<void> {
  await connection.sendNotification('notebookDocument/didOpen', {
    notebookDocument: {
      uri: notebookUri(notebook),
      notebookType: type,
      version: 1,
      cells: cells.map((_, i) => ({ kind: 2, document: cell(notebook, i) })),
    },
    cellTextDocuments: cells.map((text, i) => ({ uri: cell(notebook, i), languageId: 'typeqlite', version: 1, text })),
  });
}

const until = async (check: () => boolean, what: string): Promise<void> => {
  for (let i = 0; i < 500; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
};
const diagnosticsOf = async (uri: string): Promise<string[]> => {
  await until(() => published.has(uri), `diagnostics for ${uri}`);
  // The first publication can precede the rest of the workspace being built: let the server go quiet.
  await new Promise((r) => setTimeout(r, 300));
  return (published.get(uri) ?? []).map((d) => d.message);
};

beforeAll(async () => {
  server = spawn(process.execPath, [SERVER, '--stdio'], { stdio: 'pipe' });
  connection = createMessageConnection(new StreamMessageReader(server.stdout!), new StreamMessageWriter(server.stdin!));
  connection.onNotification('textDocument/publishDiagnostics', (p: { uri: string; diagnostics: Diagnostic[] }) => void published.set(p.uri, p.diagnostics));
  connection.onRequest('client/registerCapability', () => null);
  connection.onRequest('workspace/configuration', () => []);
  connection.listen();
  const init = (await connection.sendRequest('initialize', {
    processId: null,
    rootUri: 'file:///work',
    workspaceFolders: [{ uri: 'file:///work', name: 'work' }],
    capabilities: { notebookDocument: { synchronization: {} }, textDocument: { publishDiagnostics: {}, definition: {}, completion: {} } },
  })) as { capabilities: Record<string, any> };
  capabilities = init.capabilities;
  await connection.sendNotification('initialized', {});
});

afterAll(async () => {
  const exited = server.exitCode === null ? new Promise((done) => server.once('exit', done)) : Promise.resolve();
  await connection.sendRequest('shutdown').catch(() => undefined);
  // 🔴 Await the write before the kill. Left unawaited, it can reach a dead server's pipe after the last test, and the
  // unhandled `write EPIPE` fails a run in which every test passed.
  await connection.sendNotification('exit').catch(() => undefined);
  connection.dispose();
  server.kill();
  await exited;
});

describe('the server and notebooks', () => {
  it('advertises notebook sync for both notebook types, and for their TypeQLite cells only', () => {
    expect(capabilities['notebookDocumentSync'].notebookSelector).toEqual([
      { notebook: { notebookType: 'typeqlite-notebook' }, cells: [{ language: 'typeqlite' }] },
      { notebook: { notebookType: 'typeqlite-notebook-markdown' }, cells: [{ language: 'typeqlite' }] },
    ]);
  });

  it('builds the cells of a notebook, and a label defined in one cell resolves in another', async () => {
    await openNotebook('reading', 'typeqlite-notebook', [
      'define attribute title, value string;',
      'define entity book, owns title, owns missing;',
    ]);
    expect(await diagnosticsOf(cell('reading', 0))).toEqual([]);
    // Exactly the one label no cell defines: `title` resolved into the cell before.
    expect(await diagnosticsOf(cell('reading', 1))).toEqual([expect.stringContaining("'missing'")]);
  });

  it('keeps notebooks apart: another notebook does not see the first one\'s schema', async () => {
    await openNotebook('other', 'typeqlite-notebook-markdown', ['define entity shelf, owns title;']);
    expect(await diagnosticsOf(cell('other', 0))).toEqual([expect.stringContaining("'title'")]);
  });

  it('goes to a definition in another cell of the same notebook', async () => {
    const found = (await connection.sendRequest('textDocument/definition', {
      textDocument: { uri: cell('reading', 1) },
      position: { line: 0, character: 27 },
    })) as { targetUri: string }[];
    expect(found.map((f) => f.targetUri)).toEqual([cell('reading', 0)]);
  });

  it('offers a cell its own notebook\'s definitions, and not another notebook\'s', async () => {
    await openNotebook('typing', 'typeqlite-notebook', ['define entity only-here;', 'match $x isa ']);
    await diagnosticsOf(cell('typing', 0));
    const list = (await connection.sendRequest('textDocument/completion', {
      textDocument: { uri: cell('typing', 1) },
      position: { line: 0, character: 13 },
    })) as { items: { label: string }[] } | null;
    const labels = (list?.items ?? []).map((i) => i.label);
    expect(labels).toContain('only-here');
    expect(labels).not.toContain('book');
    expect(labels).not.toContain('shelf');
  });
});
