import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Read a `.typeqlite` schema file shipped as a **packaged asset** beside the module that reads it.
 *
 * The two candidates are both *package-relative*: the source layout, or beside a build output (one directory
 * deeper for a build that emits there). A bundle that failed to copy the asset is reported as the build defect it is,
 * when the database opens.
 *
 * @param fromDirectory the reading module's directory (`__dirname`, or `import.meta.dirname`).
 * @param fileName      e.g. `inventory.schema.typeqlite`.
 * @returns the schema's text.
 * @throws when neither candidate can be read, naming both.
 *
 * @privateRemarks
 * 🔴 **There is no cwd-relative candidate, and its absence is the point.** `join(process.cwd(), path)` resolves a
 * source-tree path against **whoever started the process**. For an installed program run in an arbitrary directory it
 * finds nothing; run in a checkout of its own source, it finds a schema belonging to a **different version than the one
 * running**, and does all the work while the packaged asset is missing.
 */
export function readSchemaFile(fromDirectory: string, fileName: string): string {
  const candidates = [
    join(fromDirectory, fileName), // source tree, and beside a bundle that copied the asset
    join(fromDirectory, '..', fileName), // a build layout that emits one directory deeper
  ];

  for (const candidate of candidates) {
    try {
      return readFileSync(candidate, 'utf8');
    } catch {
      // try the next candidate
    }
  }

  throw new Error(
    `Could not read ${fileName} — it is missing from the package.\n` +
      'This is a build defect, not a configuration problem: the schema ships as a packaged asset, so the bundle ' +
      'that omitted it is what needs fixing. Check that the build copies it beside the code that reads it ' +
      "(a bundler's list of assets, for example).\n" +
      `Looked in:\n  ${candidates.join('\n  ')}`,
  );
}
