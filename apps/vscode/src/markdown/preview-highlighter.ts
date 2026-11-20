import type MarkdownIt from 'markdown-it';
import { paintBlock, type Palette } from './paint.js';
import { FENCE_LANGUAGES, fenceLanguage, type HighlightBlocksResult } from './protocol.js';

export interface HighlighterHost {
  /** Ask the language server for the blocks' tokens. */
  request(blocks: readonly string[]): Promise<HighlightBlocksResult>;
  /** The active theme's palette, or the preview's own colors when the theme cannot be read. */
  palette(): Promise<Palette>;
  /** Re-render open previews: called once tokens or a palette arrive that a render was missing. */
  refresh(): void;
}

/** Results kept, by document content. A preview being typed into asks once per change to its blocks. */
const CACHE_LIMIT = 64;

/**
 * The TypeQLite code blocks of the Markdown preview, highlighted by the language server and colored
 * from the active theme (ADR-010).
 *
 * 🔴 **markdown-it renders synchronously, and the server answers asynchronously.** So a render that
 * finds no tokens for its blocks draws them plain, asks, and calls `refresh` when the answer lands.
 * The re-render then finds them. The same goes for the palette, which is read from the theme's files
 * once and again whenever the theme or a color setting changes. A failed request is remembered as
 * failed, so the blocks stay plain instead of asking again on every render.
 */
export class PreviewHighlighter {
  private readonly results = new Map<string, HighlightBlocksResult | 'failed'>();
  private readonly asked = new Set<string>();
  private palette: Palette | undefined;
  private paletteLoading: Promise<void> | undefined;
  private rendered = false;

  constructor(private readonly host: HighlighterHost) {}

  /** The HTML of every block, or undefined when they are drawn plain this time. */
  paint(blocks: readonly string[]): readonly string[] | undefined {
    this.rendered = true;
    const palette = this.currentPalette();
    const key = JSON.stringify(blocks);
    const result = this.results.get(key);
    if (result === undefined) {
      this.ask(key, blocks);
      return undefined;
    }
    if (result === 'failed' || !palette) return undefined;
    return blocks.map((text, index) => paintBlock(text, result[index]!, palette));
  }

  /** The theme or a color setting changed: read the palette again and redraw what is open. */
  themeChanged(): void {
    this.palette = undefined;
    this.paletteLoading = undefined;
    if (this.rendered) this.currentPalette();
  }

  private currentPalette(): Palette | undefined {
    if (!this.palette && !this.paletteLoading) {
      const loading = this.host.palette().then((palette) => {
        // A theme change while this was loading started a newer load; this one is stale.
        if (this.paletteLoading !== loading) return;
        this.palette = palette;
        this.host.refresh();
      });
      this.paletteLoading = loading;
    }
    return this.palette;
  }

  private ask(key: string, blocks: readonly string[]): void {
    if (this.asked.has(key)) return;
    this.asked.add(key);
    this.host.request(blocks).then(
      (result) => this.settle(key, result.length === blocks.length ? result : 'failed'),
      () => this.settle(key, 'failed'),
    );
  }

  private settle(key: string, result: HighlightBlocksResult | 'failed'): void {
    this.asked.delete(key);
    this.results.set(key, result);
    while (this.results.size > CACHE_LIMIT) this.results.delete(this.results.keys().next().value!);
    this.host.refresh();
  }
}

/**
 * The markdown-it plugin: fences whose language is TypeQLite are drawn by the highlighter. Every
 * other fence, and a TypeQLite fence the highlighter has nothing for yet, renders as it did before.
 *
 * All of a document's TypeQLite blocks go to the highlighter together, so a schema in one block can
 * resolve the labels in another.
 */
export function typeqliteFences(md: MarkdownIt, highlighter: Pick<PreviewHighlighter, 'paint'>): MarkdownIt {
  const isTypeQLite = (token: { type: string; info: string }) =>
    token.type === 'fence' && FENCE_LANGUAGES.has(fenceLanguage(token.info));
  const fence = md.renderer.rules.fence!;
  md.renderer.rules.fence = (tokens, index, options, env, self) => {
    const token = tokens[index]!;
    if (!isTypeQLite(token)) return fence(tokens, index, options, env, self);
    const fences = tokens.filter(isTypeQLite);
    const html = highlighter.paint(fences.map((t) => t.content))?.[fences.indexOf(token)];
    if (html === undefined) return fence(tokens, index, options, env, self);
    // markdown-it's own fence rule still writes the `<pre><code>` and its attributes, which the
    // preview's scroll sync reads. Only what goes inside changes.
    return fence(tokens, index, { ...options, highlight: () => html }, env, self);
  };
  return md;
}
