/**
 * TypeDB's doc comment: `#! This represents a person` on the line or lines directly above a definition. Returns
 * `undefined` when there is none.
 *
 * It is read from the source text because comments are hidden from the AST.
 *
 * @privateRemarks
 * 🔴 One rule, two readers. The runtime stores the comment as the definition's documentation, and the
 * editor shows it on hover. It lived in the runtime's SQL generator until the editor needed it, and a
 * second copy would have been a second definition of TypeQLite (ADR-008).
 */
export function docCommentOf(definition: {
  $cstNode?: { offset: number; root: { fullText: string } };
}): string | undefined {
  const node = definition.$cstNode;
  if (node === undefined) return undefined;
  const lines = node.root.fullText.slice(0, node.offset).split(/\r?\n/);
  // The definition's own line, up to where it starts, holds nothing but indentation.
  lines.pop();
  const comment: string[] = [];
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = /^\s*#!\s?(.*)$/.exec(lines[i]!);
    if (line === null) break;
    comment.unshift(line[1]!.trimEnd());
  }
  return comment.length === 0 ? undefined : comment.join('\n');
}
