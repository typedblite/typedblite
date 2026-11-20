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
export declare function readSchemaFile(fromDirectory: string, fileName: string): string;
//# sourceMappingURL=schema-file.d.ts.map