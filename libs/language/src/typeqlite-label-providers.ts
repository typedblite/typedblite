import {
  AstUtils,
  Cancellation,
  CstUtils,
  DefaultDocumentBuilder,
  DefaultDocumentValidator,
  DocumentState,
  type AstNode,
  type LangiumDocument,
  type NameProvider,
  type ValidationOptions,
} from 'langium';
import {
  DefaultDefinitionProvider,
  DefaultReferencesProvider,
} from 'langium/lsp';
import {
  DiagnosticSeverity,
  LocationLink,
  type CancellationToken,
  type DefinitionParams,
  type Diagnostic,
  type Location,
  type ReferenceParams,
} from 'vscode-languageserver';
import { TypeQLiteLabels, type LabelSite, type TypeQLiteLabelServices } from './typeqlite-labels.js';
import { TypeQLiteValidationCode } from './typeqlite-validation-codes.js';

/**
 * The editor's side of labels that are plain `ID`s (ADR-008 D5): definition, references and the
 * unknown-label warning, each built on `TypeQLiteLabels`. Langium's own providers answer for
 * cross-references first; these add what the labels resolve to.
 */

type WithLabels = TypeQLiteLabelServices;

/** A link from a label to a definition it names. */
function linkTo(target: AstNode, origin: LabelSite, names: NameProvider): LocationLink | undefined {
  const cst = target.$cstNode;
  if (!cst) return undefined;
  const name = names.getNameNode(target)?.range ?? cst.range;
  return LocationLink.create(AstUtils.getDocument(target).uri.toString(), cst.range, name, origin.range);
}

/**
 * Go to definition for a label that is a plain `ID` (`isa person`). Langium answers for cross-references first;
 * when it finds nothing, the label is resolved through {@link TypeQLiteLabels} to the definitions it names (ADR-008 D5).
 *
 * @category Language features
 */
export class TypeQLiteDefinitionProvider extends DefaultDefinitionProvider {
  private readonly labels: TypeQLiteLabels;

  /**
   * Created with the language's services by {@link TypeQLiteModule}.
   *
   * @param services Langium's services, with the label resolver.
   */
  constructor(services: WithLabels) {
    super(services);
    this.labels = services.labels.Labels;
  }

  /** Langium's definitions of the position, or, when it has none, those of the label under it. */
  override async getDefinition(
    document: LangiumDocument,
    params: DefinitionParams,
    cancelToken?: CancellationToken,
  ): Promise<LocationLink[] | undefined> {
    const found = await super.getDefinition(document, params, cancelToken);
    if (found && found.length > 0) return found;
    const site = this.labels.siteAt(document, document.textDocument.offsetAt(params.position));
    if (!site) return found;
    const links = this.labels
      .resolve(site)
      .map((target) => linkTo(target, site, this.nameProvider))
      .filter((link): link is LocationLink => link !== undefined);
    return links.length > 0 ? links : undefined;
  }
}

/**
 * References to a type are its cross-references (`owns name`, `sub person`) **and** its labels
 * (`has name`, `isa person`), wherever the request starts from: a declaration, a cross-reference,
 * or a label.
 *
 * @category Language features
 */
export class TypeQLiteReferencesProvider extends DefaultReferencesProvider {
  private readonly labels: TypeQLiteLabels;

  /**
   * Created with the language's services by {@link TypeQLiteModule}.
   *
   * @param services Langium's services, with the label resolver.
   */
  constructor(services: WithLabels) {
    super(services);
    this.labels = services.labels.Labels;
  }

  /** Every reference to what the position names: Langium's cross-references, and the labels that use it. */
  override async findReferences(
    document: LangiumDocument,
    params: ReferenceParams,
    cancelToken?: CancellationToken,
  ): Promise<Location[]> {
    const locations = [...(await super.findReferences(document, params, cancelToken))];
    const offset = document.textDocument.offsetAt(params.position);
    const site = this.labels.siteAt(document, offset);
    let targets: AstNode[];
    if (site) {
      targets = this.labels.resolve(site);
      // Langium found nothing at a plain `ID`, so the cross-references are ours to add.
      for (const target of targets) {
        this.references
          .findReferences(target, { includeDeclaration: params.context.includeDeclaration })
          .forEach((reference) =>
            locations.push({ uri: reference.sourceUri.toString(), range: reference.segment.range }),
          );
      }
    } else {
      const leaf = CstUtils.findDeclarationNodeAtOffset(
        document.parseResult.value.$cstNode,
        offset,
        this.grammarConfig.nameRegexp,
      );
      targets = leaf ? this.references.findDeclarations(leaf) : [];
    }
    for (const target of targets) {
      for (const use of this.labels.usesOf(target)) {
        locations.push({ uri: use.document.uri.toString(), range: use.range });
      }
    }
    const seen = new Set<string>();
    return locations.filter((location) => {
      const key = `${location.uri}@${location.range.start.line}:${location.range.start.character}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}

/**
 * The unknown-label warning (ADR-008 D6).
 *
 * It runs only where a document is built, which is the editor, so the runtime never sees it. It warns only in a
 * workspace that defines at least one type: in TypeDB the schema lives in the database, and a query file with no
 * schema beside it may be perfectly correct.
 *
 * @privateRemarks
 * 🔴 This is a `DocumentValidator`, not a check in `ValidationRegistry`, and that is the whole point
 * (ADR-008 D2). The runtime runs every registered check through `validateSync`, so a registered check
 * would refuse a query whose type lives only in the database. A `DocumentValidator` runs only where a
 * document is built, which is only in the editor.
 *
 * @category Validation
 */
export class TypeQLiteDocumentValidator extends DefaultDocumentValidator {
  private readonly labels: TypeQLiteLabels;

  /**
   * Created with the language's services by {@link TypeQLiteModule}.
   *
   * @param services Langium's services, with the label resolver.
   */
  constructor(services: WithLabels) {
    super(services);
    this.labels = services.labels.Labels;
  }

  /**
   * Langium's diagnostics, and a warning for each label that names a type the workspace does not define. The
   * warnings are left out when the document has parse errors, and in a workspace that defines no type at all.
   */
  override async validateDocument(
    document: LangiumDocument,
    options?: ValidationOptions,
    cancelToken?: CancellationToken,
  ): Promise<Diagnostic[]> {
    const diagnostics = await super.validateDocument(document, options, cancelToken);
    if (document.parseResult.parserErrors.length > 0 || !this.labels.workspaceHasSchema(document.uri)) {
      return diagnostics;
    }
    for (const site of this.labels.sitesIn(document)) {
      if (!site.checked || this.labels.resolve(site).length > 0) continue;
      diagnostics.push({
        severity: DiagnosticSeverity.Warning,
        range: site.range,
        message: unknownMessage(site),
        code: TypeQLiteValidationCode.unknownLabel,
        source: 'typedblite',
      });
    }
    return diagnostics;
  }
}

function unknownMessage(site: LabelSite): string {
  if (site.kind === 'role') {
    return `No relation '${site.relation}' in this workspace relates a role '${site.name}'.`;
  }
  const kind = site.kind === 'type' ? '' : `${site.kind} `;
  return `No ${kind}type '${site.name}' is defined in this workspace. The database may still define it.`;
}

/**
 * Relinks a document that holds labels whenever any document changes.
 *
 * @privateRemarks
 * 🔴 Langium relinks a document when something it cross-references changed. A label is not a
 * cross-reference, so a query file would keep a stale unknown-label warning after the schema file
 * defining the type was saved. A document with label sites therefore counts every change as its own.
 *
 * @category Language features
 */
export class TypeQLiteDocumentBuilder extends DefaultDocumentBuilder {
  protected override shouldRelink(document: LangiumDocument, changedUris: Set<string>): boolean {
    if (super.shouldRelink(document, changedUris)) return true;
    const services = this.serviceRegistry.getServices(document.uri) as Partial<WithLabels>;
    return (services.labels?.Labels.sitesIn(document).length ?? 0) > 0;
  }

  /**
   * Publishes a validated document's diagnostics even if a newer update has canceled the build.
   *
   * The diagnostics already exist at this point, and sending them is cheap, so cancelling here saves
   * nothing and loses them for good. Every other phase keeps its token.
   *
   * @privateRemarks
   * 🔴 Langium 4.4 sets a document's state to `Validated`, and marks its build completed, and only
   * then calls the `Validated` phase listeners, which is where the language server sends the
   * diagnostics. It checks the cancellation token before each listener. An editor that opens several
   * files at once sends a burst of `didOpen`s, each of which cancels the build in flight, so a cancel
   * can land between "validated" and "published": the listener is skipped, and because the document
   * is already `Validated` and complete, no later build revisits it. Its diagnostics are never sent
   * until the file is edited. It hit the first document of five about three runs in ten
   * (`apps/vscode/test/server.test.ts`).
   */
  protected override notifyDocumentPhase(
    document: LangiumDocument,
    state: DocumentState,
    cancelToken: Cancellation.CancellationToken,
  ): Promise<void> {
    const token = state === DocumentState.Validated ? Cancellation.CancellationToken.None : cancelToken;
    return super.notifyDocumentPhase(document, state, token);
  }
}
