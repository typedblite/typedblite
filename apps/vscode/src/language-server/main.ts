import { startLanguageServer } from 'langium/lsp';
import { NodeFileSystem } from 'langium/node';
import { createConnection, ProposedFeatures } from 'vscode-languageserver/node';
import { createTypeQLiteServices } from '@typedblite/language';

/**
 * The TypeQLite language server: the same services the language library's tests use, connected
 * to an editor.
 *
 * Nothing here defines TypeQLite. `createTypeQLiteServices` brings the grammar, the scope provider,
 * the validator, the formatter and the semantic tokens. `startLanguageServer` advertises whichever
 * of them are registered, so a service added to `TypeQLiteModule` reaches the editor without a
 * change here.
 *
 * The transport (`--node-ipc` from the extension, `--stdio` from a test) comes from argv.
 */
const connection = createConnection(ProposedFeatures.all);
const { shared } = createTypeQLiteServices({ connection, ...NodeFileSystem });
startLanguageServer(shared);
