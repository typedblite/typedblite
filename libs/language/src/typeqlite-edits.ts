import {
  AstUtils,
  CstUtils,
  DocumentValidator,
  GrammarAST,
  GrammarUtils,
  type AstNode,
  type LangiumDocument,
  type Reference,
} from 'langium';
import {
  DefaultRenameProvider,
  type CodeActionProvider,
} from 'langium/lsp';
import {
  CodeActionKind,
  ErrorCodes,
  ResponseError,
  TextEdit,
  type CancellationToken,
  type CodeAction,
  type CodeActionParams,
  type Diagnostic,
  type Range,
  type RenameParams,
  type TextDocumentPositionParams,
  type WorkspaceEdit,
} from 'vscode-languageserver';
import { isAnnotation, type Annotation } from './generated/ast.js';
import type { TypeQLiteLabels, TypeQLiteLabelServices } from './typeqlite-labels.js';
import { TypeQLiteValidationCode } from './typeqlite-validation-codes.js';
import { isReservedKeyword } from './typeqlite-validator.js';

/**
 * Edits the editor proposes: rename, and quick fixes. Editor-only, like everything built on the
 * workspace index (ADR-008 D2).
 */

type WithLabels = TypeQLiteLabelServices;

/**
 * Rename a type or a role everywhere the workspace names it.
 *
 * 🔴 Langium's rename edits cross-references only. A TypeQLite label in a query (`isa person`) is a
 * plain `ID` (ADR-008 D5), so renaming `person` in its schema would leave every query naming a type
 * that no longer exists. This edits the label uses too, and a rename may start from a label.
 */
export class TypeQLiteRenameProvider extends DefaultRenameProvider {
  private readonly labels: TypeQLiteLabels;
  private readonly identifier: RegExp;

  /**
   * Created with the language's services by {@link TypeQLiteModule}.
   *
   * @param services Langium's services, with the label resolver.
   * @throws if the grammar has no `ID` terminal.
   */
  constructor(services: WithLabels) {
    super(services);
    this.labels = services.labels.Labels;
    // The grammar's own `ID` terminal, so what may be a name is defined once.
    const id = services.Grammar.rules.find((rule) => rule.name === 'ID');
    if (!id || !GrammarAST.isTerminalRule(id)) throw new Error('The TypeQLite grammar has no ID terminal.');
    this.identifier = new RegExp(`^(?:${GrammarUtils.terminalRegex(id).source})$`, 'u');
  }

  /**
   * Renames the type or role at the position everywhere the workspace names it: its definition, its
   * cross-references and its label uses.
   *
   * @throws a `ResponseError` if the new name is not a TypeQLite label, or is a reserved keyword.
   */
  override async rename(
    document: LangiumDocument,
    params: RenameParams,
    cancelToken?: CancellationToken,
  ): Promise<WorkspaceEdit | undefined> {
    if (!this.identifier.test(params.newName)) {
      throw new ResponseError(ErrorCodes.InvalidParams, `'${params.newName}' is not a TypeQLite label.`);
    }
    if (isReservedKeyword(params.newName)) {
      throw new ResponseError(ErrorCodes.InvalidParams, `'${params.newName}' is a reserved TypeQLite keyword.`);
    }
    const target = this.targetAt(document, params.position);
    if (!target) return super.rename(document, params, cancelToken);

    const edits = new Map<string, Map<string, TextEdit>>();
    const add = (uri: string, range: Range) => {
      const key = `${range.start.line}:${range.start.character}`;
      if (!edits.has(uri)) edits.set(uri, new Map());
      edits.get(uri)!.set(key, TextEdit.replace(range, params.newName));
    };
    for (const reference of this.references.findReferences(target, { includeDeclaration: true })) {
      add(reference.sourceUri.toString(), reference.segment.range);
    }
    for (const use of this.labels.usesOf(target)) add(use.document.uri.toString(), use.range);
    const changes: Record<string, TextEdit[]> = {};
    for (const [uri, byRange] of edits) changes[uri] = [...byRange.values()];
    return { changes };
  }

  /** The range of the label under the position when it names a definition, otherwise Langium's answer. */
  override prepareRename(
    document: LangiumDocument,
    params: TextDocumentPositionParams,
    cancelToken?: CancellationToken,
    // Annotated, not inferred: with Langium 4.4 the LSP types resolve to a nested copy of
    // `vscode-languageserver-types`, and TypeScript (TS2883) cannot name an inferred `Range` from it.
  ): ReturnType<DefaultRenameProvider['prepareRename']> {
    const site = this.labels.siteAt(document, document.textDocument.offsetAt(params.position));
    if (site && this.labels.resolve(site).length > 0) return site.range;
    return super.prepareRename(document, params, cancelToken);
  }

  /** What a rename at this position renames: the label's definition, or the declaration under it. */
  private targetAt(document: LangiumDocument, position: TextDocumentPositionParams['position']) {
    const offset = document.textDocument.offsetAt(position);
    const site = this.labels.siteAt(document, offset);
    if (site) return this.labels.resolve(site)[0];
    const leaf = CstUtils.findDeclarationNodeAtOffset(
      document.parseResult.value.$cstNode,
      offset,
      this.grammarConfig.nameRegexp,
    );
    return leaf ? this.references.findDeclarations(leaf)[0] : undefined;
  }
}

/**
 * Quick fixes, only where the fix is mechanical and the diagnostic's code says which fix it is.
 *
 * - An annotation the position does not admit, or one repeated, is removed.
 * - An unknown label, or a reference that did not resolve, can be changed to the nearest names the
 *   workspace defines of the right kind.
 *
 * `duplicate-owns` (which of two disagreeing `owns` is meant) and `reserved-keyword` (what the new
 * name should be) are the writer's to decide, so they get no fix.
 */
export class TypeQLiteCodeActionProvider implements CodeActionProvider {
  private readonly labels: TypeQLiteLabels;
  private readonly services: WithLabels;

  /**
   * Created with the language's services by {@link TypeQLiteModule}.
   *
   * @param services Langium's services, with the label resolver.
   */
  constructor(services: WithLabels) {
    this.services = services;
    this.labels = services.labels.Labels;
  }

  getCodeActions(document: LangiumDocument, params: CodeActionParams): CodeAction[] {
    return params.context.diagnostics.flatMap((diagnostic) => this.fixesFor(document, diagnostic));
  }

  private fixesFor(document: LangiumDocument, diagnostic: Diagnostic): CodeAction[] {
    switch (diagnostic.code) {
      case TypeQLiteValidationCode.annotationNotAdmitted:
        return this.removeAnnotation(document, diagnostic);
      case TypeQLiteValidationCode.annotationRepeated:
        return this.keepOneOf(document, diagnostic);
      case TypeQLiteValidationCode.unknownLabel:
        return this.didYouMean(document, diagnostic, this.labelCandidates(document, diagnostic));
    }
    if ((diagnostic.data as { code?: string } | undefined)?.code === DocumentValidator.LinkingError) {
      return this.didYouMean(document, diagnostic, this.scopeCandidates(document, diagnostic));
    }
    return [];
  }

  private annotationAt(document: LangiumDocument, diagnostic: Diagnostic): Annotation | undefined {
    const offset = document.textDocument.offsetAt(diagnostic.range.start);
    const leaf = CstUtils.findLeafNodeAtOffset(document.parseResult.value.$cstNode!, offset);
    return leaf ? AstUtils.getContainerOfType(leaf.astNode, isAnnotation) : undefined;
  }

  /** Delete an annotation and the whitespace before it: `entity player @card(1..1);` → `entity player;`. */
  private deletion(document: LangiumDocument, annotation: Annotation): TextEdit | undefined {
    const cst = annotation.$cstNode;
    if (!cst) return undefined;
    const text = document.textDocument.getText();
    let start = cst.offset;
    while (start > 0 && /[ \t]/.test(text[start - 1]!)) start -= 1;
    return TextEdit.del({
      start: document.textDocument.positionAt(start),
      end: document.textDocument.positionAt(cst.end),
    });
  }

  /** An annotation the position does not admit: the only fix is removing it. */
  private removeAnnotation(document: LangiumDocument, diagnostic: Diagnostic): CodeAction[] {
    const annotation = this.annotationAt(document, diagnostic);
    const edit = annotation && this.deletion(document, annotation);
    if (!annotation || !edit) return [];
    return [
      {
        title: `Remove ${annotation.$cstNode!.text.replace(/\(.*$/s, '')}`,
        kind: CodeActionKind.QuickFix,
        diagnostics: [diagnostic],
        isPreferred: true,
        edit: { changes: { [document.uri.toString()]: [edit] } },
      },
    ];
  }

  /**
   * Two annotations of one category that disagree (`@card(0..1) @card(1..2)`). Which one is meant is
   * the writer's to say, so both choices are offered, and neither is preferred.
   */
  private keepOneOf(document: LangiumDocument, diagnostic: Diagnostic): CodeAction[] {
    const later = this.annotationAt(document, diagnostic);
    const container = later?.$container as Record<string, unknown> | undefined;
    const siblings = Object.values(container ?? {}).find(
      (value): value is Annotation[] => Array.isArray(value) && value.includes(later),
    );
    const earlier = siblings?.find(
      (each) => each !== later && each.$type === later!.$type && siblings.indexOf(each) < siblings.indexOf(later!),
    );
    if (!later || !earlier) return [];
    return [
      [earlier, later],
      [later, earlier],
    ].flatMap(([keep, drop]) => {
      const edit = this.deletion(document, drop!);
      return edit
        ? [
            {
              title: `Keep ${keep!.$cstNode!.text}`,
              kind: CodeActionKind.QuickFix,
              diagnostics: [diagnostic],
              edit: { changes: { [document.uri.toString()]: [edit] } },
            },
          ]
        : [];
    });
  }

  private labelCandidates(document: LangiumDocument, diagnostic: Diagnostic): string[] {
    const site = this.labels.siteAt(document, document.textDocument.offsetAt(diagnostic.range.start));
    if (!site) return [];
    return this.labels
      .candidates(site.kind, site.relation)
      .map((node) => (node as { name?: string }).name)
      .filter((name): name is string => name !== undefined);
  }

  /** The names the failed reference's own scope holds: what it could have meant. */
  private scopeCandidates(document: LangiumDocument, diagnostic: Diagnostic): string[] {
    const data = diagnostic.data as { property?: string };
    const offset = document.textDocument.offsetAt(diagnostic.range.start);
    const leaf = CstUtils.findLeafNodeAtOffset(document.parseResult.value.$cstNode!, offset);
    const container = leaf?.astNode as (AstNode & Record<string, unknown>) | undefined;
    const reference = data.property ? (container?.[data.property] as Reference | undefined) : undefined;
    if (!container || !reference || !data.property) return [];
    return this.services.references.ScopeProvider.getScope({ container, property: data.property, reference })
      .getAllElements()
      .map((description) => description.name)
      .toArray();
  }

  private didYouMean(document: LangiumDocument, diagnostic: Diagnostic, names: string[]): CodeAction[] {
    const written = document.textDocument.getText(diagnostic.range);
    const nearest = [...new Set(names)]
      .map((name) => ({ name, distance: editDistance(written, name) }))
      .filter(({ name, distance }) => name !== written && distance <= Math.max(2, Math.floor(written.length / 4)))
      .sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name))
      .slice(0, 3);
    return nearest.map(({ name }, index) => ({
      title: `Change to '${name}'`,
      kind: CodeActionKind.QuickFix,
      diagnostics: [diagnostic],
      isPreferred: index === 0,
      edit: { changes: { [document.uri.toString()]: [TextEdit.replace(diagnostic.range, name)] } },
    }));
  }
}

/** Levenshtein distance: how many single-character edits turn one label into the other. */
export function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length]!;
}
