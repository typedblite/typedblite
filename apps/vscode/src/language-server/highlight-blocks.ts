import { EmptyFileSystem, URI } from 'langium';
import { SemanticTokensDecoder } from 'langium/lsp';
import { createTypeQLiteServices } from '@typedblite/language';
import type { BlockHighlight, HighlightBlocksResult } from '../markdown/protocol.js';
import { tokenizeTextMate, type RawGrammar } from './textmate.js';

/**
 * Highlight the TypeQLite code blocks of one Markdown document: the TextMate scopes and the semantic
 * tokens an editor would show for each, were it a `.tql` file (ADR-010).
 *
 * 🔴 **The blocks are built as their own workspace, never the editor's.** A docs page's examples are
 * self-contained. Resolved against the open workspace, a page's labels would be coloured by
 * whatever schema happens to sit beside it, and left uncoloured where none does. Built together, a
 * `define` in one block resolves the labels in the queries below it, as a reader expects. A page
 * with no schema falls back to colouring labels by position, as an editor workspace with no schema
 * does (ADR-008 D6).
 *
 * The services are created per request, so nothing outlives it. The client caches by content.
 */
export async function highlightBlocks(
  blocks: readonly string[],
  grammar: RawGrammar,
): Promise<HighlightBlocksResult> {
  const services = createTypeQLiteServices(EmptyFileSystem);
  const { LangiumDocuments, LangiumDocumentFactory, DocumentBuilder } = services.shared.workspace;
  const documents = blocks.map((text, index) => {
    const document = LangiumDocumentFactory.fromString(text, URI.parse(`file:///markdown/block-${index}.tql`));
    LangiumDocuments.addDocument(document);
    return document;
  });
  await DocumentBuilder.build(documents, { validation: false });

  const provider = services.TypeQLite.lsp.SemanticTokenProvider!;
  // 🔴 Langium's modifier table holds masks (`declaration: 1 << 2`), not bit positions.
  const modifierMasks = Object.entries(provider.tokenModifiers);
  const highlights: BlockHighlight[] = [];
  // 🔴 One document at a time: the provider keeps the document it is highlighting on itself, so two
  // calls in flight at once hand one block's tokens to the other.
  for (const [index, document] of documents.entries()) {
    const encoded = await provider.semanticHighlight(document, {
      textDocument: { uri: document.uri.toString() },
    });
    const semantic = SemanticTokensDecoder.decode(encoded, provider.tokenTypes, document).map((token) => ({
      offset: token.offset,
      length: token.text.length,
      type: token.tokenType as string,
      modifiers: modifierMasks.filter(([, mask]) => (token.tokenModifiers & mask) !== 0).map(([name]) => name),
    }));
    highlights.push({ textmate: tokenizeTextMate(grammar, blocks[index]!), semantic });
  }
  return highlights;
}
