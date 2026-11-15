import { EmptyFileSystem } from 'langium';
import { startLanguageServer } from 'langium/lsp';
import { createTypeQLiteServices } from '@typedblite/language';
import type { Connection } from 'vscode-languageserver';

/**
 * The TypeQLite language server, for the playground's editor: the very services the VS Code extension
 * runs (`createTypeQLiteServices`, ADR-008), started the same way (`startLanguageServer`), over whatever
 * connection it is given.
 *
 * Nothing here defines TypeQLite, and nothing is written for the playground. Diagnostics, completion,
 * hover, go to definition, rename, quick fixes, outline, folding, formatting and semantic tokens are the
 * extension's, because the server is. In the page the connection is a worker's message port; the unit
 * tests give it a pair of streams, so the real protocol is what they exercise.
 *
 * `EmptyFileSystem`: there is no disk in a browser, and the playground's one document is sent by the
 * editor.
 */
export function serve(connection: Connection): void {
  const { shared } = createTypeQLiteServices({ connection, ...EmptyFileSystem });
  startLanguageServer(shared);
}
