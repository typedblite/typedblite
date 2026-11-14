import { describe, expect, it } from 'vitest';
import { TypeQLiteGrammar } from '../src/generated/grammar.js';
import { grammarKeywords, KEYWORD_SCOPES, typeqliteTextMate } from '../src/typeqlite-textmate.js';

/**
 * The TextMate grammar's keywords come from the Langium grammar and its scopes from
 * `KEYWORD_SCOPES`. These cases are what keep the two from drifting: a construct added to the
 * grammar fails here until its keyword has a scope.
 */
describe('the TypeQLite TextMate grammar', () => {
  const keywords = grammarKeywords(TypeQLiteGrammar());

  it('gives every keyword of the grammar a scope, and names none the grammar lacks', () => {
    expect(() => typeqliteTextMate(keywords, ['.tql'])).not.toThrow();
  });

  it('refuses a keyword the grammar gains without a scope', () => {
    expect(() => typeqliteTextMate([...keywords, 'frobnicate'], ['.tql'])).toThrow(
      /No TextMate scope for the keyword\(s\) frobnicate/,
    );
  });

  it('refuses a scope for a keyword the grammar no longer has', () => {
    expect(() => typeqliteTextMate(keywords.filter((k) => k !== 'struct'), ['.tql'])).toThrow(
      /KEYWORD_SCOPES names struct, which the grammar no longer has/,
    );
  });

  it('scopes a new annotation by its shape, with no entry of its own', () => {
    const grammar = typeqliteTextMate([...keywords, '@frozen'], ['.tql']);
    expect(JSON.stringify(grammar.repository['annotations'])).toContain('frozen');
  });

  it('gives no keyword two scopes', () => {
    const all = Object.values(KEYWORD_SCOPES).flat();
    expect(all.length).toBe(new Set(all).size);
  });

  it('compiles every regex as JavaScript with the u flag, as the Markdown preview runs them', () => {
    const regexes = JSON.stringify(typeqliteTextMate(keywords, ['.tql'])).match(/"(?:match|begin|end)":"(?:[^"\\]|\\.)*"/g)!;
    for (const entry of regexes) {
      const source = JSON.parse(`{${entry}}`) as Record<string, string>;
      expect(() => new RegExp(Object.values(source)[0]!, 'u')).not.toThrow();
    }
  });
});
