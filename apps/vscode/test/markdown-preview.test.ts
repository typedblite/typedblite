import MarkdownIt from 'markdown-it';
import { fallbackPalette, paintBlock, themePalette, type Palette } from '../src/markdown/paint';
import { PreviewHighlighter, typeqliteFences, type HighlighterHost } from '../src/markdown/preview-highlighter';
import type { BlockHighlight, HighlightBlocksResult } from '../src/markdown/protocol';
import { resolveTheme } from '../src/markdown/theme';

const KEYWORD = ['keyword.control.typeqlite'];

/** A palette that names what it draws, so a case reads the layers directly. */
const naming: Palette = {
  textmate: (stack) => ({ className: `tm-${stack.at(-1)}` }),
  semantic: (type) => (type === 'parameter' ? undefined : { className: `sem-${type}` }),
};

describe('painting a block', () => {
  const text = 'match $p isa person;';
  const highlight: BlockHighlight = {
    textmate: [{ offset: 0, length: 5, scopes: KEYWORD }, { offset: 9, length: 3, scopes: KEYWORD }],
    semantic: [
      { offset: 6, length: 2, type: 'variable', modifiers: [] },
      { offset: 13, length: 6, type: 'type', modifiers: [] },
    ],
  };

  it('draws the TextMate layer, then semantic tokens over it', () => {
    expect(paintBlock(text, highlight, naming)).toBe(
      '<span class="tm-keyword.control.typeqlite">match</span> <span class="sem-variable">$p</span> ' +
        '<span class="tm-keyword.control.typeqlite">isa</span> <span class="sem-type">person</span>;',
    );
  });

  it('leaves the TextMate colour where the palette gives a semantic token none', () => {
    const over: BlockHighlight = {
      textmate: [{ offset: 0, length: 5, scopes: KEYWORD }],
      semantic: [{ offset: 0, length: 5, type: 'parameter', modifiers: [] }],
    };
    expect(paintBlock('match', over, naming)).toBe('<span class="tm-keyword.control.typeqlite">match</span>');
  });

  it('escapes the text', () => {
    expect(paintBlock('"<b>" & \'x\'', { textmate: [], semantic: [] }, naming)).toBe(
      '&quot;&lt;b&gt;&quot; &amp; &#39;x&#39;',
    );
  });

  it("writes the theme's style inline", () => {
    const theme = resolveTheme(
      [{ tokenColors: [{ scope: 'keyword', settings: { foreground: '#c586c0', fontStyle: 'italic underline' } }] }],
      { themeName: 'x', semanticHighlighting: false },
    );
    expect(paintBlock('match', { textmate: [{ offset: 0, length: 5, scopes: KEYWORD }], semantic: [] }, themePalette(theme))).toBe(
      '<span style="color:#c586c0;font-style:italic;text-decoration:underline">match</span>',
    );
  });

  it("falls back to the preview's highlight.js classes", () => {
    expect(paintBlock(text, highlight, fallbackPalette)).toBe(
      '<span class="hljs-keyword">match</span> <span class="hljs-variable">$p</span> ' +
        '<span class="hljs-keyword">isa</span> <span class="hljs-type">person</span>;',
    );
  });
});

describe('the Markdown preview plugin', () => {
  const DOCUMENT = [
    '```typeql',
    'define entity person;',
    '```',
    '',
    '```ts',
    'const x = 1;',
    '```',
    '',
    '```tql',
    'match $p isa person;',
    '```',
    '',
  ].join('\n');

  /** A host whose server and theme answer when the case says so. */
  function host() {
    const requests: (readonly string[])[] = [];
    let answer: (result: HighlightBlocksResult) => void = () => undefined;
    let fail: () => void = () => undefined;
    let palettes = 0;
    const refreshed = vi.fn();
    const h: HighlighterHost = {
      request: (blocks) => {
        requests.push(blocks);
        return new Promise((done, failed) => {
          answer = done;
          fail = () => failed(new Error('server gone'));
        });
      },
      palette: async () => {
        palettes += 1;
        return naming;
      },
      refresh: refreshed,
    };
    return { h, requests, refreshed, answer: (r: HighlightBlocksResult) => answer(r), fail: () => fail(), palettes: () => palettes };
  }

  const result: HighlightBlocksResult = [
    { textmate: [{ offset: 0, length: 6, scopes: KEYWORD }], semantic: [] },
    { textmate: [{ offset: 0, length: 5, scopes: KEYWORD }], semantic: [{ offset: 13, length: 6, type: 'type', modifiers: [] }] },
  ];
  const settled = () => new Promise((done) => setTimeout(done, 0));

  it('draws the blocks plain, asks for all of them at once, and redraws them once the answer lands', async () => {
    const { h, requests, refreshed, answer } = host();
    const md = typeqliteFences(new MarkdownIt(), new PreviewHighlighter(h));
    const plain = md.render(DOCUMENT);
    expect(plain).toContain('<code class="language-typeql">define entity person;\n</code>');
    expect(requests).toEqual([['define entity person;\n', 'match $p isa person;\n']]);

    answer(result);
    await settled();
    expect(refreshed).toHaveBeenCalled();
    const painted = md.render(DOCUMENT);
    expect(painted).toContain(
      '<pre><code class="language-typeql"><span class="tm-keyword.control.typeqlite">define</span> entity person;\n</code></pre>',
    );
    expect(painted).toContain('<span class="sem-type">person</span>');
    // Other languages render exactly as before.
    expect(painted).toContain('<code class="language-ts">const x = 1;\n</code>');
    expect(requests).toHaveLength(1);
  });

  it('asks once per content, however often the preview renders before the answer', () => {
    const { h, requests } = host();
    const md = typeqliteFences(new MarkdownIt(), new PreviewHighlighter(h));
    md.render(DOCUMENT);
    md.render(DOCUMENT);
    expect(requests).toHaveLength(1);
  });

  it('keeps the blocks plain after a failed request, rather than asking on every render', async () => {
    const { h, requests, fail } = host();
    const md = typeqliteFences(new MarkdownIt(), new PreviewHighlighter(h));
    md.render(DOCUMENT);
    fail();
    await settled();
    expect(md.render(DOCUMENT)).toContain('<code class="language-tql">match $p isa person;\n</code>');
    expect(requests).toHaveLength(1);
  });

  it('reads the palette again when the theme changes', async () => {
    const { h, palettes, refreshed } = host();
    const highlighter = new PreviewHighlighter(h);
    typeqliteFences(new MarkdownIt(), highlighter).render(DOCUMENT);
    await settled();
    refreshed.mockClear();
    highlighter.themeChanged();
    await settled();
    expect(palettes()).toBe(2);
    expect(refreshed).toHaveBeenCalled();
  });
});
