/**
 * The request the client sends to highlight the TypeQLite code blocks of a Markdown document, and
 * what the server answers (ADR-010).
 *
 * The server says what each piece of text IS, in the two layers an editor draws: the TextMate
 * grammar's scopes, and the semantic tokens on top of them. It says nothing about color. Color is
 * the theme's, and only the client can see the theme.
 */
export const HIGHLIGHT_BLOCKS = 'typeqlite/highlightBlocks';

export interface HighlightBlocksParams {
  /** Every TypeQLite block in one Markdown document, in order: they are built as one workspace. */
  readonly blocks: readonly string[];
}

/** A run of text and its TextMate scopes, outermost first, without the grammar's root scope. */
export interface ScopeToken {
  readonly offset: number;
  readonly length: number;
  readonly scopes: readonly string[];
}

/** A semantic token: its type and modifiers by name, as the provider registers them. */
export interface SemanticToken {
  readonly offset: number;
  readonly length: number;
  readonly type: string;
  readonly modifiers: readonly string[];
}

export interface BlockHighlight {
  readonly textmate: readonly ScopeToken[];
  readonly semantic: readonly SemanticToken[];
}

export type HighlightBlocksResult = readonly BlockHighlight[];

/** The fence languages highlighted as TypeQLite, and the language of a fence's info string: the notebook's own list (`@typedblite/notebook`). */
export { FENCE_LANGUAGES, fenceLanguage } from '@typedblite/notebook';
