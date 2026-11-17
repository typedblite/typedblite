import { AstUtils, GrammarAST } from 'langium';
import {
  DefaultCompletionProvider,
  type CompletionAcceptor,
  type CompletionContext,
  type LangiumServices,
  type NextFeature,
} from 'langium/lsp';
import { LABEL_POSITIONS, type LabelKind, type TypeQLiteLabels } from './typeqlite-labels.js';
import { kindOf } from './typeqlite-navigation.js';

/**
 * Completion for TypeQLite.
 *
 * Langium already completes keywords, and cross-references from their scope: `owns`, `sub` and
 * `plays` in a `define`, which since ADR-008 D3 means the whole workspace. What it cannot complete is
 * a label that is a plain `ID` (`isa |`, `has |`, a role player), because there is no scope to ask.
 * Those positions are listed in `LABEL_POSITIONS`, and offer the workspace's definitions of the kind
 * each one expects (ADR-008 D5).
 */
export class TypeQLiteCompletionProvider extends DefaultCompletionProvider {
  private readonly labels: TypeQLiteLabels;

  /**
   * Created with the language's services by {@link TypeQLiteModule}.
   *
   * @param services Langium's services, with the label resolver.
   */
  constructor(services: LangiumServices & { labels: { Labels: TypeQLiteLabels } }) {
    super(services);
    this.labels = services.labels.Labels;
  }

  /**
   * At a position that takes a plain `ID` for a type or a role, offers the workspace's definitions of the kind
   * expected there; anywhere else, Langium's completion.
   */
  protected override completionFor(
    context: CompletionContext,
    next: NextFeature,
    acceptor: CompletionAcceptor,
  ) {
    const kind = labelKindOf(next);
    if (kind === undefined) return super.completionFor(context, next, acceptor);
    const before = context.textDocument.getText().slice(0, context.tokenOffset);
    const relation = kind === 'role' ? relationBefore(before) : undefined;
    const offered = new Set<string>();
    for (const candidate of this.labels.candidates(kind, relation)) {
      const name = (candidate as { name?: string }).name;
      if (!name || offered.has(name)) continue;
      offered.add(name);
      acceptor(context, {
        label: name,
        kind: this.nodeKindProvider.getCompletionItemKind(candidate),
        detail: kindOf(candidate),
        // Ahead of keywords: at a label position, a label is what is being typed.
        sortText: `0${name}`,
      });
    }
    return undefined;
  }
}

/** The label kind a grammar feature expects, if it is a label position. */
function labelKindOf(next: NextFeature): LabelKind | undefined {
  const call = next.feature;
  if (!GrammarAST.isRuleCall(call)) return undefined;
  const callee = call.rule.ref?.name;
  if (callee !== 'ID' && callee !== 'ScopedLabel') return undefined;
  const assignment = AstUtils.getContainerOfType(call, GrammarAST.isAssignment);
  const rule = AstUtils.getContainerOfType(call, GrammarAST.isParserRule);
  if (!assignment || !rule) return undefined;
  return LABEL_POSITIONS[`${rule.name}.${assignment.feature}`];
}

/**
 * The relation a role being typed belongs to, read from the text before the cursor. The statement is
 * unfinished, so it may not parse, and the text is all there is.
 *
 * - `plays employment:|` and `redefine employment:|`: the label before the colon.
 * - `$e isa employment (|`, `employment (|`, `… isa employment, links (|`: the relation the players
 *   belong to.
 */
export function relationBefore(text: string): string | undefined {
  const scoped = /([^\s,;:()$]+):[^\s,;:()$]*$/.exec(text);
  if (scoped && !/\(\s*[^()]*$/.test(text.slice(0, scoped.index))) return scoped[1];
  const statement = text.slice(text.lastIndexOf(';') + 1);
  const players = /([^\s,;:()$]+)\s*\(([^()]*)$/.exec(statement);
  if (!players) return undefined;
  if (players[1] !== 'links') return players[1];
  return /isa!?\s+([^\s,;:()$]+)/.exec(statement)?.[1];
}
