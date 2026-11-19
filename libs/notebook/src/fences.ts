/**
 * The fence languages that make a block of Markdown a TypeQLite block: the docs write `typeql`, the language's id is
 * `typeqlite`, and `tql` is the file extension. One list for the notebook's file format, the Markdown preview's
 * highlighting (ADR-010) and the tour's parser, so they cannot disagree about what a TypeQLite block is.
 */
export const FENCE_LANGUAGES: ReadonlySet<string> = new Set(['typeql', 'typeqlite', 'tql']);

/** The language of a fence's info string, `typeql title="x"` → `typeql`. */
export const fenceLanguage = (info: string): string => info.trim().split(/\s+/)[0]!.toLowerCase();
