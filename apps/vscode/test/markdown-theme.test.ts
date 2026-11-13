import { resolveTheme, semanticStyle, textMateStyle, type ThemeFile, type ThemeSettings } from '../src/markdown/theme';

/**
 * Each case pins one of VS Code's colouring rules, as `theme.ts` restates them. A rule that drifted
 * would colour a code block in the preview differently from the same text in the editor.
 */
const SETTINGS: ThemeSettings = { themeName: 'Test Theme', semanticHighlighting: 'configuredByTheme' };
const theme = (files: ThemeFile[], settings: Partial<ThemeSettings> = {}) =>
  resolveTheme(files, { ...SETTINGS, ...settings });
const STRING = ['source.typeqlite', 'string.quoted.double.typeqlite'];
const ESCAPE = [...STRING, 'constant.character.escape.typeqlite'];

describe('semantic token colours', () => {
  const semantic = (semanticTokenColors: Record<string, unknown>, more: Partial<ThemeSettings> = {}) =>
    theme([{ semanticHighlighting: true, semanticTokenColors }], more);

  it('takes each field from the best-scoring selector: type 100, each modifier 100, language 10', () => {
    const t = semantic({
      type: '#111111',
      'type.declaration': { foreground: '#222222' },
      '*.declaration': { italic: true },
      'type:typeqlite': '#333333',
      'type:typescript': '#444444',
    });
    expect(semanticStyle(t, 'type', ['declaration'])).toEqual({ foreground: '#222222', italic: true });
    expect(semanticStyle(t, 'type', [])).toEqual({ foreground: '#333333' });
  });

  it("lets a later rule win a tie, so the user's customisation beats the theme", () => {
    const t = semantic({ variable: '#aaaaaa' }, {
      semanticTokenColorCustomizations: { rules: { variable: '#bbbbbb' } },
    });
    expect(semanticStyle(t, 'variable', [])).toEqual({ foreground: '#bbbbbb' });
  });

  it("falls back to the token type's TextMate scopes, in VS Code's order", () => {
    const t = theme([{
      semanticHighlighting: true,
      tokenColors: [
        { scope: 'support.type', settings: { foreground: '#000002' } },
        { scope: 'variable.other.property', settings: { foreground: '#000003' } },
      ],
    }]);
    expect(semanticStyle(t, 'type', [])).toEqual({ foreground: '#000002' });
    expect(semanticStyle(t, 'property', [])).toEqual({ foreground: '#000003' });
    // Nothing styles a parameter: the editor leaves the TextMate colour showing.
    expect(semanticStyle(t, 'parameter', [])).toBeUndefined();
  });

  it('fills only the fields the semantic rules leave unset from the fallback', () => {
    const t = theme([{
      semanticHighlighting: true,
      semanticTokenColors: { type: { bold: true } },
      tokenColors: [{ scope: 'entity.name.type', settings: { foreground: '#4ec9b0' } }],
    }]);
    expect(semanticStyle(t, 'type', [])).toEqual({ bold: true, foreground: '#4ec9b0' });
  });
});

describe('whether semantic highlighting is on', () => {
  const colours = { semanticTokenColors: { type: '#123456' } };
  const on = (files: ThemeFile[], more: Partial<ThemeSettings> = {}) =>
    semanticStyle(theme(files, more), 'type', []) !== undefined;

  it("follows the theme when the setting is configuredByTheme, and is off when the theme says nothing", () => {
    expect(on([{ ...colours, semanticHighlighting: true }])).toBe(true);
    expect(on([colours])).toBe(false);
  });

  it("lets the customisation's enabled, for this theme or globally, override the theme", () => {
    expect(on([{ ...colours, semanticHighlighting: true }], {
      semanticTokenColorCustomizations: { '[Test Theme]': { enabled: false } },
    })).toBe(false);
    expect(on([colours], { semanticTokenColorCustomizations: { enabled: true } })).toBe(true);
  });

  it('lets editor.semanticHighlighting.enabled override everything', () => {
    expect(on([{ ...colours, semanticHighlighting: true }], { semanticHighlighting: false })).toBe(false);
    expect(on([colours], { semanticHighlighting: true })).toBe(true);
  });
});

describe('TextMate colours', () => {
  const rules = (...tokenColors: unknown[]) => theme([{ tokenColors }]);

  it('prefers the longer scope prefix', () => {
    const t = rules(
      { scope: 'string.quoted', settings: { foreground: '#000002' } },
      { scope: 'string', settings: { foreground: '#000001' } },
    );
    expect(textMateStyle(t, STRING)).toEqual({ foreground: '#000002' });
  });

  it('inherits from the enclosing scope what the inner scope does not set', () => {
    const t = rules(
      { scope: 'string', settings: { foreground: '#000001', fontStyle: 'italic' } },
      { scope: 'constant.character.escape', settings: { foreground: '#000002' } },
    );
    expect(textMateStyle(t, ESCAPE)).toEqual({
      foreground: '#000002', italic: true, bold: false, underline: false, strikethrough: false,
    });
  });

  it('breaks a tie of scope length by ancestors, and then by order', () => {
    const t = rules(
      { scope: 'source.typeqlite string', settings: { foreground: '#000002' } },
      { scope: 'string', settings: { foreground: '#000001' } },
      { scope: ['comment', 'string'], settings: { bold: true } },
    );
    expect(textMateStyle(t, STRING)).toEqual({ foreground: '#000002', bold: true });
  });

  it('lets fontStyle "" clear an inherited italic', () => {
    const t = rules(
      { scope: 'string', settings: { fontStyle: 'italic' } },
      { scope: 'constant.character.escape', settings: { fontStyle: '' } },
    );
    expect(textMateStyle(t, ESCAPE)?.italic).toBe(false);
  });

  it('ignores a rule with no scope: those are the theme defaults, not a token colour', () => {
    expect(textMateStyle(rules({ settings: { foreground: '#ffffff' } }), STRING)).toBeUndefined();
  });

  it("applies the customisation shorthands with VS Code's scopes, exclusions included", () => {
    const t = theme([{}], {
      tokenColorCustomizations: { keywords: '#000001', '[Other Theme]': { strings: '#000009' } },
    });
    expect(textMateStyle(t, ['source.typeqlite', 'keyword.control.typeqlite'])).toEqual({ foreground: '#000001' });
    expect(textMateStyle(t, ['source.typeqlite', 'keyword.operator'])).toBeUndefined();
    // The `[Other Theme]` block names another theme.
    expect(textMateStyle(t, STRING)).toBeUndefined();
  });

  it('applies textMateRules from a theme block whose name matches, wildcards included', () => {
    const t = theme([{}], {
      tokenColorCustomizations: { '[Test*]': { textMateRules: [{ scope: 'string', settings: { foreground: '#000003' } }] } },
    });
    expect(textMateStyle(t, STRING)).toEqual({ foreground: '#000003' });
  });

  it('refuses a colour that is not a hex colour, so nothing else reaches the style attribute', () => {
    const t = rules({ scope: 'string', settings: { foreground: 'red;background:url(x)' } });
    expect(textMateStyle(t, STRING)).toBeUndefined();
  });
});
