import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startLanguageServer } from 'langium/lsp';
import { NodeFileSystem } from 'langium/node';
import { createConnection, ProposedFeatures } from 'vscode-languageserver/node';
import { createTypeQLiteServices } from '@typedblite/language';
import { HIGHLIGHT_BLOCKS, type HighlightBlocksParams } from '../markdown/protocol.js';
import { highlightBlocks } from './highlight-blocks.js';
import type { RawGrammar } from './textmate.js';

/**
 * The TypeQLite language server: the same services the language library's tests use, connected
 * to an editor.
 *
 * Nothing here defines TypeQLite. `createTypeQLiteServices` brings the grammar, the scope provider,
 * the validator, the formatter and the semantic tokens. `startLanguageServer` advertises whichever
 * of them are registered, so a service added to `TypeQLiteModule` reaches the editor without a
 * change here.
 *
 * The one request of its own is `typeqlite/highlightBlocks`, for code blocks in the Markdown preview
 * (ADR-010). It reuses the same services, in a workspace of its own.
 *
 * The transport (`--node-ipc` from the extension, `--stdio` from a test) comes from argv.
 */
const connection = createConnection(ProposedFeatures.all);
const { shared } = createTypeQLiteServices({ connection, ...NodeFileSystem });

// 🔴 The grammar the EDITOR uses: the copy the manifest contributes, beside `out/`, read when first
// needed. Bundling a second copy would let the preview drift from the editor.
let grammar: RawGrammar | undefined;
const textMateGrammar = () =>
  (grammar ??= JSON.parse(
    readFileSync(join(__dirname, '../../syntaxes/typeqlite.tmLanguage.json'), 'utf8'),
  ) as RawGrammar);
connection.onRequest(HIGHLIGHT_BLOCKS, (params: HighlightBlocksParams) =>
  highlightBlocks(params.blocks, textMateGrammar()),
);

startLanguageServer(shared);
