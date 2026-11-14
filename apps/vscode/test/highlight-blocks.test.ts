import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { highlightBlocks } from '../src/language-server/highlight-blocks';
import type { RawGrammar } from '../src/language-server/textmate';
import type { HighlightBlocksResult } from '../src/markdown/protocol';

/**
 * `highlightBlocks` in this process (ADR-010 D1, D2). `markdown-server.test.ts` proves the bundled
 * server answers the request; this proves what the answer holds, where coverage can see it.
 */
const GRAMMAR: RawGrammar = JSON.parse(readFileSync(resolve(__dirname, '../syntaxes/typeqlite.tmLanguage.json'), 'utf8'));

const semantic = (blocks: string[], result: HighlightBlocksResult, index: number) =>
  result[index]!.semantic.map((t) => `${blocks[index]!.slice(t.offset, t.offset + t.length)}:${[t.type, ...t.modifiers].join('.')}`);

describe('highlighting the TypeQLite blocks of one Markdown page', () => {
  const SCHEMA = 'define\nattribute name, value string;\nentity person, owns name;\n';
  const QUERY = 'match $p isa person, has name "Ann", has nickname "A";\n';

  it('answers one highlight per block, in order', async () => {
    const result = await highlightBlocks([SCHEMA, QUERY, ''], GRAMMAR);
    expect(result).toHaveLength(3);
    expect(result[2]).toEqual({ textmate: [], semantic: [] });
  });

  it("resolves a query block's labels against a schema in another block, and leaves an unknown one", async () => {
    const blocks = [SCHEMA, QUERY];
    const result = await highlightBlocks(blocks, GRAMMAR);
    expect(semantic(blocks, result, 0)).toEqual(expect.arrayContaining(['person:type.declaration', 'name:property.declaration']));
    expect(semantic(blocks, result, 1)).toEqual(['$p:variable', 'person:type', 'name:property', '"Ann":string', '"A":string']);
  });

  it("never gives one block another block's tokens", async () => {
    // 🔴 The provider keeps the document it is highlighting on itself; built concurrently, the schema's
    // tokens once arrived in the query's answer, at offsets past its end.
    const blocks = [SCHEMA, QUERY];
    const result = await highlightBlocks(blocks, GRAMMAR);
    result.forEach((block, index) => {
      for (const token of [...block.semantic, ...block.textmate]) {
        expect(token.offset + token.length).toBeLessThanOrEqual(blocks[index]!.length);
      }
    });
  });

  it('builds each request as its own workspace, so one page never sees another', async () => {
    await highlightBlocks([SCHEMA], GRAMMAR);
    const blocks = [QUERY];
    // A page with no schema: labels coloured by position, nickname included, as ADR-008 D6 says.
    expect(semantic(blocks, await highlightBlocks(blocks, GRAMMAR), 0)).toEqual(
      expect.arrayContaining(['person:type', 'name:property', 'nickname:property']),
    );
  });
});
