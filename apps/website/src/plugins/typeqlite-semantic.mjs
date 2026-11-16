/**
 * Colours a TypeQLite code fence the way the editor does: the TextMate grammar's colours (from Shiki, in
 * the same VS Code themes the editor uses) with the language server's semantic tokens laid over them.
 *
 * The tokens come from the VERY provider the VS Code extension and the playground run
 * (`TypeQLiteSemanticTokenProvider`, through `createTypeQLiteServices`), run here at build time on each
 * fence's text. A name that resolves to a type, an attribute or a role gets the colour of its kind, and one
 * that does not resolve keeps the grammar's colour, exactly as in the editor. Nothing is listed here: a
 * token the provider gains is coloured by the same rule.
 *
 * A token's colour is the theme's colour for the TextMate scope VS Code falls back to for that token type,
 * so it follows the theme, not a second palette.
 */
import { definePlugin, InlineStyleAnnotation } from 'astro-expressive-code';
import { EmptyFileSystem, URI } from 'langium';
import { AllSemanticTokenTypes } from 'langium/lsp';
import { createTypeQLiteServices } from '@typedblite/language';

const LANGUAGES = new Set(['typeql', 'typeqlite', 'tql']);
const TOKEN_TYPES = Object.keys(AllSemanticTokenTypes);

/** VS Code's default scope for a semantic token type that its theme gives no colour of its own. */
const SCOPE_OF_TYPE = {
  type: 'entity.name.type',
  class: 'entity.name.type',
  property: 'variable.other.property',
  parameter: 'variable.parameter',
  variable: 'variable',
  string: 'string',
  number: 'constant.numeric',
};

/** The foreground a theme gives a scope: the longest settings selector that is a prefix of it. */
export function colourOfScope(settings, scope) {
  let best;
  let bestLength = -1;
  for (const setting of settings) {
    const selectors = [setting.scope ?? []].flat().flatMap((s) => s.split(','));
    for (const raw of selectors) {
      const selector = raw.trim();
      if (!selector || selector.includes(' ') || !setting.settings?.foreground) continue;
      if ((scope === selector || scope.startsWith(`${selector}.`)) && selector.length > bestLength) {
        best = setting.settings.foreground;
        bestLength = selector.length;
      }
    }
  }
  return best;
}

let services;
let counter = 0;
const language = () => (services ??= createTypeQLiteServices({ ...EmptyFileSystem }));

// 🔴 One document at a time. Langium's semantic token provider keeps its tokens in a field of the shared
// instance, so two fences highlighted concurrently (Expressive Code does that) would each come back with
// the other's tokens mixed in.
let queue = Promise.resolve();

/** The semantic tokens of `text` as `{ line, start, length, type }`, in text order. */
export function semanticTokensOf(text) {
  const result = queue.then(() => tokensOf(text));
  queue = result.catch(() => undefined);
  return result;
}

async function tokensOf(text) {
  const { shared, TypeQLite } = language();
  const uri = URI.parse(`file:///fence-${counter++}.typeqlite`);
  const document = shared.workspace.LangiumDocumentFactory.fromString(text, uri);
  shared.workspace.LangiumDocuments.addDocument(document);
  try {
    await shared.workspace.DocumentBuilder.build([document], { validation: false });
    const { data } = await TypeQLite.lsp.SemanticTokenProvider.semanticHighlight(document, { textDocument: { uri: uri.toString() } });
    const tokens = [];
    let line = 0;
    let start = 0;
    for (let i = 0; i < data.length; i += 5) {
      line += data[i];
      start = data[i] ? data[i + 1] : start + data[i + 1];
      tokens.push({ line, start, length: data[i + 2], type: TOKEN_TYPES[data[i + 3]] });
    }
    return tokens;
  } finally {
    shared.workspace.LangiumDocuments.deleteDocument(uri);
  }
}

export function typeqliteSemanticTokens() {
  return definePlugin({
    name: 'typeqlite-semantic-tokens',
    hooks: {
      annotateCode: async ({ codeBlock, styleVariants }) => {
        if (!LANGUAGES.has(codeBlock.language)) return;
        const lines = codeBlock.getLines();
        const tokens = await semanticTokensOf(codeBlock.code);
        for (const token of tokens) {
          const scope = SCOPE_OF_TYPE[token.type];
          const line = lines[token.line];
          if (!scope || !line) continue;
          styleVariants.forEach((variant, styleVariantIndex) => {
            const color = colourOfScope(variant.theme.settings, scope);
            if (!color) return;
            line.addAnnotation(
              new InlineStyleAnnotation({
                color,
                styleVariantIndex,
                inlineRange: { columnStart: token.start, columnEnd: token.start + token.length },
              }),
            );
          });
        }
      },
    },
  });
}
