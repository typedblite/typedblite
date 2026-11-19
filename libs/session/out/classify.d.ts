/**
 * What a statement is, found from its text alone: the one classifier the CLI and the engine host share.
 *
 * 🔴 Classification is **textual, on the leading keyword**, and that is deliberate rather than lazy. The
 * interpreter already parses properly and rejects what it cannot run; duplicating a parse here to decide
 * which of its three methods to call would be a second, worse parser that can disagree with the real one.
 * This only has to answer "which method", and the interpreter has the final say on whether the text is
 * valid at all.
 */
/**
 * - `empty`: nothing but whitespace.
 * - `define`: a schema block, run by the interpreter's `define`.
 * - `read`: a pipeline with no write stage, run by `query`.
 * - `write`: anything else, run by `execute`.
 */
export type StatementKind = 'empty' | 'define' | 'read' | 'write';
/** Classify one statement. It never throws and never touches a store. */
export declare function classifyStatement(source: string): StatementKind;
/**
 * Split a source into statements a session can run one at a time.
 *
 * A pipeline may span lines and semicolons: `match $s isa project, has project-id "x";` followed by `insert …;`
 * is one pipeline, so splitting on `;` alone would tear every `match … insert` in half. A statement ends at a `;`
 * that is not followed by a stage keyword.
 *
 * @privateRemarks
 * 🔴 The rule is the same ordering the grammar encodes, where `match` is followed by an optional write and an
 * optional projection.
 */
export declare function splitStatements(source: string): string[];
//# sourceMappingURL=classify.d.ts.map