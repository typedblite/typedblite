import { EmptyFileSystem } from 'langium';
// 🔴 Not `vscode-languageserver`. Two copies of `vscode-languageserver-types` are installed —
// langium nests its own — and `document.diagnostics` carries langium's. Importing the other copy
// makes two structurally identical types unassignable. Deriving it from langium keeps one.
import type { LangiumDocument } from 'langium';

type Diagnostic = NonNullable<LangiumDocument['diagnostics']>[number];
import { createTypeQLiteServices } from '../src/typeqlite-module.js';
import type { TypeQLiteFile } from '../src/generated/ast.js';

const { TypeQLite } = createTypeQLiteServices(EmptyFileSystem);


/** Parse TypeQLite, returning the AST alongside every lexer and parser error. */
export function parse(text: string) {
  const result = TypeQLite.parser.LangiumParser.parse<TypeQLiteFile>(text);
  return {
    value: result.value,
    lexerErrors: result.lexerErrors,
    parserErrors: result.parserErrors,
  };
}

/** Parse *and validate*, returning diagnostics. Validation needs a built document, not just a parse. */
export async function validate(text: string): Promise<Diagnostic[]> {
  const { parseHelper } = await import('langium/test');
  const helper = parseHelper<TypeQLiteFile>(TypeQLite);
  const document = await helper(text, { validation: true });
  return document.diagnostics ?? [];
}

/**
 * Format TypeQLite, returning the formatted text.
 *
 * Goes through `lsp.Formatter` and applies the returned edits, rather than calling the formatter's
 * internals — so what the test exercises is what an editor would receive.
 */
export async function format(text: string, tabSize = 4): Promise<string> {
  const { parseHelper } = await import('langium/test');
  const { TextDocument } = await import('vscode-languageserver-textdocument');
  const helper = parseHelper<TypeQLiteFile>(TypeQLite);
  const document = await helper(text);
  const formatter = TypeQLite.lsp.Formatter;
  if (!formatter) throw new Error('No Formatter service is registered.');
  const edits = await formatter.formatDocument(document, {
    textDocument: { uri: document.textDocument.uri },
    options: { insertSpaces: true, tabSize },
  });
  return TextDocument.applyEdits(document.textDocument, edits);
}

/**
 * A position-free, structural view of the AST, for asserting a transform preserved meaning.
 *
 * 🔴 Must go through `parseHelper`, not `parse`. `JsonSerializer.serialize` resolves each node to
 * its `LangiumDocument` and throws *"AST node has no document"* against a bare parse result — which
 * is what the raw `LangiumParser` returns. Cross-references serialize as document-relative paths,
 * so a reference that silently re-pointed after formatting would still be caught.
 */
export async function astShape(text: string): Promise<string> {
  const { parseHelper } = await import('langium/test');
  const helper = parseHelper<TypeQLiteFile>(TypeQLite);
  const document = await helper(text);
  return TypeQLite.serializer.JsonSerializer.serialize(document.parseResult.value, { space: 0 });
}

/**
 * Semantic tokens, decoded to `{ type, modifier, text }`.
 *
 * 🔴 Decoded on purpose. The wire format is a flat array of five-integer groups with
 * delta-encoded positions; asserting on it directly produces a test whose failure message is a
 * list of numbers. `SemanticTokensDecoder` is Langium's own answer and gives assertions a reader
 * can check against the source text.
 */
export async function semanticTokens(
  text: string,
): Promise<Array<{ type: string; modifiers: number; text: string }>> {
  const { parseHelper } = await import('langium/test');
  const helper = parseHelper<TypeQLiteFile>(TypeQLite);
  const document = await helper(text, { validation: true });
  const provider = TypeQLite.lsp.SemanticTokenProvider;
  if (!provider) throw new Error('No SemanticTokenProvider service is registered.');
  const { SemanticTokensDecoder } = await import('langium/lsp');
  const tokens = await provider.semanticHighlight(document, {
    textDocument: { uri: document.textDocument.uri },
  });
  return SemanticTokensDecoder.decode(tokens, provider.tokenTypes, document).map((token) => ({
    type: token.tokenType as string,
    modifiers: token.tokenModifiers,
    text: token.text,
  }));
}
