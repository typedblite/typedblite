import { describe, expect, it } from 'vitest';
import { grammarKeywords, TypeQLiteGrammar } from '@typedblite/language';
import { LANGUAGE_ID, MONARCH, SURFACE, themeRules, TOKEN } from '../src/highlighting';

/**
 * The editor's base colouring comes from the same table as the VS Code grammar (`KEYWORD_SCOPES`), so these
 * check the one thing that can go wrong in between: a keyword the grammar has that this tokenizer would miss.
 */
const grammarWords = grammarKeywords(TypeQLiteGrammar()).filter((word) => /^[A-Za-z]/.test(word) && !word.startsWith('@'));
const lists = [MONARCH.controlWords, MONARCH.storageWords, MONARCH.valueTypeWords, MONARCH.operatorWords, MONARCH.constantWords];

describe('the tokenizer knows every keyword of the grammar', () => {
  it('puts each word keyword in exactly one category (isa! and sub! are read by their own rule)', () => {
    const tokenizerWords = grammarWords.filter((word) => !word.endsWith('!'));
    for (const word of tokenizerWords) {
      expect(lists.filter((list) => list.includes(word)), word).toHaveLength(1);
    }
  });

  it('knows no word the grammar does not have', () => {
    const known = new Set(grammarWords);
    for (const word of lists.flat()) expect(known.has(word), word).toBe(true);
  });

  it('reads `isa!` and `sub!` as control keywords, and only after a non-name character', () => {
    const rule = MONARCH.tokenizer.root.find(([pattern]) => pattern instanceof RegExp && pattern.source.includes('isa|sub'));
    expect(rule?.[1]).toBe(TOKEN.control);
    const pattern = rule![0] as RegExp;
    expect(pattern.test('isa!')).toBe(true);
    expect(pattern.test(' sub! ')).toBe(true);
    expect(pattern.test('xisa!')).toBe(false);
    expect(pattern.test('my-isa!')).toBe(false);
  });

  it('reads a name with a hyphen whole, so `value` inside `value-type` is not a keyword', () => {
    const name = MONARCH.tokenizer.root.find(([pattern]) => pattern instanceof RegExp && pattern.source.startsWith('[A-Za-z_'));
    const match = (name![0] as RegExp).exec('value-type');
    expect(match?.[0]).toBe('value-type');
    expect(MONARCH.controlWords).not.toContain('value-type');
  });

  it('has regular expressions that compile, and no state that points at a missing state', () => {
    for (const rules of Object.values(MONARCH.tokenizer)) {
      for (const [pattern, action] of rules) {
        expect(() => new RegExp((pattern as RegExp).source)).not.toThrow();
        const next = typeof action === 'object' && 'next' in action ? (action as { next: string }).next : undefined;
        if (next && next !== '@pop') expect(MONARCH.tokenizer, next).toHaveProperty(next.replace('@', ''));
      }
    }
  });
});

describe('the themes', () => {
  it.each(['light', 'dark'] as const)('%s: every rule has a six-digit hex colour, and no scope is coloured twice', (scheme) => {
    const rules = themeRules(scheme);
    for (const rule of rules) expect(rule.foreground, rule.token).toMatch(/^[0-9A-F]{6}$/);
    const tokens = rules.map((rule) => rule.token);
    expect(new Set(tokens).size).toBe(tokens.length);
  });

  it('colours the scopes the tokenizer emits, and the semantic types the server sends', () => {
    const tokens = themeRules('dark').map((rule) => rule.token);
    for (const emitted of Object.values(TOKEN)) {
      expect(tokens.some((token) => emitted === token || emitted.startsWith(`${token}.`)), emitted).toBe(true);
    }
    for (const semantic of ['type', 'property', 'parameter', 'variable']) expect(tokens).toContain(semantic);
  });

  it.each([
    ['light', '0000FF'],
    ['dark', '569CD6'],
  ] as const)("%s: colours an annotation as VS Code's themes colour the keyword scope the grammar gives it", (scheme, keyword) => {
    // `@key` is `keyword.annotations.typeqlite` in the TextMate grammar, so a VS Code theme gives it its `keyword`
    // colour. The playground, the extension and the site must show the same.
    const rule = themeRules(scheme).find((r) => r.token === 'keyword.annotations');
    expect(rule?.foreground).toBe(keyword);
  });

  it('keeps the editor surface in step with the page: both schemes set a background and a foreground', () => {
    for (const scheme of ['light', 'dark'] as const) {
      expect(SURFACE[scheme]['editor.background']).toMatch(/^#[0-9a-f]{6}$/);
      expect(SURFACE[scheme]['editor.foreground']).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('names the language the server and the editor share', () => {
    expect(LANGUAGE_ID).toBe('typeqlite');
  });
});
