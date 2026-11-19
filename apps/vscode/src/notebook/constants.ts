/** The notebook type for `*.tql.md`: a TypeQLite notebook, the default editor for those files (ADR-012 N2). */
export const NOTEBOOK_TYPE = 'typeqlite-notebook';

/**
 * The same notebook for any `*.md` file, offered only through "Open With" (`priority: option`), so the existing guides
 * open and run without being renamed, and no Markdown file is taken over. VS Code gives one `priority` to a type, and
 * `*.md` cannot be the default, so it is a second type over the same serializer.
 */
export const NOTEBOOK_TYPE_MARKDOWN = 'typeqlite-notebook-markdown';

/** The language ids of a notebook's cells: a code cell is TypeQLite, the language server's own id; the rest is Markdown. */
export const CODE_CELL_LANGUAGE = 'typeqlite';
export const MARKUP_CELL_LANGUAGE = 'markdown';
