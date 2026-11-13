import type { BlockHighlight } from './protocol.js';
import { semanticStyle, textMateStyle, type Theme, type TokenStyle } from './theme.js';

/** How one run of text is drawn: an inline style from the theme, or a class from the preview's CSS. */
export interface Paint {
  readonly className?: string;
  readonly style?: string;
}

export interface Palette {
  textmate(stack: readonly string[]): Paint | undefined;
  semantic(type: string, modifiers: readonly string[]): Paint | undefined;
}

/** The grammar's root scope, which every TextMate token sits inside and the server leaves out. */
const ROOT = 'source.typeqlite';

/**
 * A code block's HTML: its text, escaped, with each run the palette draws in a `<span>`.
 *
 * The layers are the editor's: TextMate scopes underneath, and a semantic token on top **only where
 * the palette gives it a paint**. A semantic token the theme does not style leaves the TextMate
 * colour showing, as it does in the editor.
 */
export function paintBlock(text: string, highlight: BlockHighlight, palette: Palette): string {
  const paints: (Paint | undefined)[] = new Array<Paint | undefined>(text.length).fill(undefined);
  const lay = (offset: number, length: number, paint: Paint | undefined) => {
    if (!paint) return;
    for (let i = Math.max(0, offset); i < Math.min(text.length, offset + length); i += 1) paints[i] = paint;
  };
  for (const token of highlight.textmate) lay(token.offset, token.length, palette.textmate([ROOT, ...token.scopes]));
  for (const token of highlight.semantic) lay(token.offset, token.length, palette.semantic(token.type, token.modifiers));

  let html = '';
  let start = 0;
  for (let i = 1; i <= text.length; i += 1) {
    if (i < text.length && paints[i] === paints[start]) continue;
    const run = escapeHtml(text.slice(start, i));
    const paint = paints[start];
    html += paint ? `<span${attribute('class', paint.className)}${attribute('style', paint.style)}>${run}</span>` : run;
    start = i;
  }
  return html;
}

/** Colours from the active theme. Paints are memoised, so equal styles are one object and one run. */
export function themePalette(theme: Theme): Palette {
  const paints = new Map<string, Paint | undefined>();
  const memo = (key: string, style: () => TokenStyle | undefined) => {
    if (!paints.has(key)) {
      const css = style() && cssOf(style()!);
      paints.set(key, css ? { style: css } : undefined);
    }
    return paints.get(key);
  };
  return {
    textmate: (stack) => memo(`t ${stack.join(' ')}`, () => textMateStyle(theme, stack)),
    semantic: (type, modifiers) => memo(`s ${type}.${modifiers.join('.')}`, () => semanticStyle(theme, type, modifiers)),
  };
}

/**
 * The preview's own highlight.js classes, for when the theme cannot be read: TypeQLite still reads
 * as code, in the colours the preview gives every other language.
 */
export const fallbackPalette: Palette = (() => {
  const classes = new Map<string, Paint>();
  const paint = (className: string) => {
    if (!classes.has(className)) classes.set(className, { className });
    return classes.get(className)!;
  };
  const SCOPES: readonly [string, string][] = [
    ['comment', 'hljs-comment'],
    ['string', 'hljs-string'],
    ['keyword', 'hljs-keyword'],
    ['constant.numeric', 'hljs-number'],
  ];
  const SEMANTIC: Readonly<Record<string, string>> = {
    keyword: 'hljs-literal',
    type: 'hljs-type',
    property: 'hljs-attr',
    parameter: 'hljs-params',
    variable: 'hljs-variable',
    string: 'hljs-string',
    number: 'hljs-number',
  };
  return {
    textmate: (stack) => {
      for (const scope of [...stack].reverse()) {
        const found = SCOPES.find(([prefix]) => scope === prefix || scope.startsWith(`${prefix}.`));
        if (found) return paint(found[1]);
      }
      return undefined;
    },
    semantic: (type) => (SEMANTIC[type] ? paint(SEMANTIC[type]) : undefined),
  };
})();

function cssOf(style: TokenStyle): string | undefined {
  const declarations: string[] = [];
  if (style.foreground) declarations.push(`color:${style.foreground}`);
  if (style.italic) declarations.push('font-style:italic');
  if (style.bold) declarations.push('font-weight:bold');
  const decoration = [style.underline && 'underline', style.strikethrough && 'line-through'].filter(Boolean);
  if (decoration.length > 0) declarations.push(`text-decoration:${decoration.join(' ')}`);
  return declarations.length > 0 ? declarations.join(';') : undefined;
}

const attribute = (name: string, value: string | undefined) => (value ? ` ${name}="${escapeHtml(value)}"` : '');

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
