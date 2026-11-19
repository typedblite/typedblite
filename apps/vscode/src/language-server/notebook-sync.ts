import { DefaultLanguageServer } from 'langium/lsp';
import type { InitializeParams, InitializeResult } from 'vscode-languageserver';

import { CODE_CELL_LANGUAGE, NOTEBOOK_TYPE, NOTEBOOK_TYPE_MARKDOWN } from '../notebook/constants.js';

/**
 * The language server, told that it serves notebooks (ADR-012 N4).
 *
 * Langium's server does not advertise `notebookDocumentSync`, so a client never sends it a notebook. This one does, for
 * the two notebook types and for their TypeQLite cells only (the Markdown cells are not the server's). The cells then
 * arrive as documents with a `vscode-notebook-cell:` URI, and the language library keeps each notebook's schema to
 * itself (`schemaOwnerOf`), so nothing here decides what a cell can see.
 */
export class NotebookAwareLanguageServer extends DefaultLanguageServer {
  protected override buildInitializeResult(params: InitializeParams): InitializeResult {
    const result = super.buildInitializeResult(params);
    result.capabilities.notebookDocumentSync = {
      notebookSelector: [NOTEBOOK_TYPE, NOTEBOOK_TYPE_MARKDOWN].map((notebookType) => ({
        notebook: { notebookType },
        cells: [{ language: CODE_CELL_LANGUAGE }],
      })),
    };
    return result;
  }
}
