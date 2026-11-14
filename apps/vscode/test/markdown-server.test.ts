import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from 'vscode-jsonrpc/node';
import { HIGHLIGHT_BLOCKS, type HighlightBlocksResult } from '../src/markdown/protocol';

/**
 * `typeqlite/highlightBlocks` on the BUNDLED server, over stdio (ADR-010): the request the Markdown
 * preview sends. It proves the bundle carries the request and finds the grammar it ships with.
 */
const SERVER = resolve(__dirname, '../out/language-server/main.cjs');

let server: ChildProcess;
let connection: MessageConnection;

beforeAll(async () => {
  server = spawn(process.execPath, [SERVER, '--stdio'], { stdio: 'pipe' });
  connection = createMessageConnection(new StreamMessageReader(server.stdout!), new StreamMessageWriter(server.stdin!));
  connection.onRequest(() => null);
  connection.listen();
  await connection.sendRequest('initialize', { processId: process.pid, rootUri: null, workspaceFolders: null, capabilities: {} });
  await connection.sendNotification('initialized', {});
});

afterAll(() => {
  connection.dispose();
  server.kill();
});

const highlight = (blocks: string[]) => connection.sendRequest<HighlightBlocksResult>(HIGHLIGHT_BLOCKS, { blocks });

/** A block's semantic tokens as `text:type[.modifier…]`. */
const semantic = (blocks: string[], result: HighlightBlocksResult, index: number) =>
  result[index]!.semantic.map(
    (t) => `${blocks[index]!.slice(t.offset, t.offset + t.length)}:${[t.type, ...t.modifiers].join('.')}`,
  );

describe('typeqlite/highlightBlocks', () => {
  const SCHEMA = 'define\nattribute name, value string;\nentity person, owns name;\n';
  const QUERY = 'match $p isa person, has name "Ann", has nickname "A";\n';

  it("resolves a query block's labels against the schema in another block of the same page", async () => {
    const blocks = [SCHEMA, QUERY];
    const result = await highlight(blocks);
    expect(semantic(blocks, result, 0)).toEqual(
      expect.arrayContaining(['name:property.declaration', 'person:type.declaration', 'name:property']),
    );
    // `nickname` is defined nowhere on the page, so, as in the editor, it is not coloured as a label.
    expect(semantic(blocks, result, 1)).toEqual(['$p:variable', 'person:type', 'name:property', '"Ann":string', '"A":string']);
  });

  it('colours labels by position on a page with no schema, as an editor workspace with none does', async () => {
    const blocks = [QUERY];
    expect(semantic(blocks, await highlight(blocks), 0)).toEqual(
      expect.arrayContaining(['person:type', 'name:property', 'nickname:property']),
    );
  });

  it("returns the TextMate layer from the grammar the extension ships", async () => {
    const [block] = await highlight([QUERY]);
    expect(block!.textmate.slice(0, 3)).toEqual([
      { offset: 0, length: 5, scopes: ['keyword.control.typeqlite'] },
      { offset: 6, length: 2, scopes: ['variable.parameter.typeqlite'] },
      { offset: 9, length: 3, scopes: ['keyword.control.typeqlite'] },
    ]);
  });

  it('highlights a block that does not parse, as far as it can', async () => {
    const blocks = ['match $p isa;'];
    const [block] = await highlight(blocks);
    expect(block!.textmate.map((t) => blocks[0]!.slice(t.offset, t.offset + t.length))).toEqual(['match', '$p', 'isa']);
  });
});
