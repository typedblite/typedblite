import { URI } from 'langium';

/**
 * Whose schema a document is part of (ADR-012 N4).
 *
 * A workspace is one schema (ADR-008 D3): every `.tql` file in it adds to it. A **notebook** is its own schema, because
 * its cells run against a store of its own. So two notebooks must not see each other's definitions, and neither must a
 * notebook and the workspace's files. The owner of a document is the key that says which schema it belongs to:
 *
 * - a notebook cell (`vscode-notebook-cell:`) belongs to its notebook: the cell's URI without its fragment;
 * - everything else belongs to the workspace.
 *
 * A definition is visible to a reference only when both have the same owner.
 *
 * @category Language features
 */
export const NOTEBOOK_CELL_SCHEME = 'vscode-notebook-cell';

/** The owner of every document that is not a notebook cell. */
export const WORKSPACE_OWNER = '';

/** The key of the schema a document belongs to: its notebook for a cell, the workspace for anything else. */
export function schemaOwnerOf(uri: URI | string): string {
  const parsed = typeof uri === 'string' ? URI.parse(uri) : uri;
  return parsed.scheme === NOTEBOOK_CELL_SCHEME ? parsed.with({ fragment: '' }).toString() : WORKSPACE_OWNER;
}

/** Whether two documents are part of the same schema. */
export const sameSchema = (a: URI | string, b: URI | string): boolean => schemaOwnerOf(a) === schemaOwnerOf(b);
