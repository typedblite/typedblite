import {
  AstUtils,
  CstUtils,
  DefaultDocumentBuilder,
  DefaultDocumentValidator,
  type AstNode,
  type LangiumDocument,
  type NameProvider,
  type ValidationOptions,
} from 'langium';
import {
  DefaultDefinitionProvider,
  DefaultReferencesProvider,
  type LangiumServices,
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
import { TypeQLiteLabels, type LabelSite } from './typeqlite-labels.js';
import { TypeQLiteValidationCode } from './typeqlite-validation-codes.js';

/**
 * The editor's side of labels that are plain `ID`s (ADR-008 D5): definition, references and the
 * unknown-label warning, each built on `TypeQLiteLabels`. Langium's own providers answer for
 * cross-references first; these add what the labels resolve to.
 */

type WithLabels = LangiumServices & { labels: { Labels: TypeQLiteLabels } };

/** A link from a label to a definition it names. */
function linkTo(target: AstNode, origin: LabelSite, names: NameProvider): LocationLink | undefined {
  const cst = target.$cstNode;
  if (!cst) return undefined;
  const name = names.getNameNode(target)?.range ?? cst.range;
  return LocationLink.create(AstUtils.getDocument(target).uri.toString(), cst.range, name, origin.range);
}

export class TypeQLiteDefinitionProvider extends DefaultDefinitionProvider {
  private readonly labels: TypeQLiteLabels;

  constructor(services: WithLabels) {
    super(services);
    this.labels = services.labels.Labels;
  }

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
 */
export class TypeQLiteReferencesProvider extends DefaultReferencesProvider {
  private readonly labels: TypeQLiteLabels;

  constructor(services: WithLabels) {
    super(services);
    this.labels = services.labels.Labels;
  }

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
 * 🔴 This is a `DocumentValidator`, not a check in `ValidationRegistry`, and that is the whole point
 * (ADR-008 D2). The runtime runs every registered check through `validateSync`, so a registered check
 * would refuse a query whose type lives only in the database. A `DocumentValidator` runs only where a
 * document is built, which is only in the editor.
 *
 * It warns only in a workspace that defines at least one type. In TypeDB the schema lives in the
 * database, and a query file with no schema beside it may be perfectly correct.
 */
export class TypeQLiteDocumentValidator extends DefaultDocumentValidator {
  private readonly labels: TypeQLiteLabels;

  constructor(services: WithLabels) {
    super(services);
    this.labels = services.labels.Labels;
  }

  override async validateDocument(
    document: LangiumDocument,
    options?: ValidationOptions,
    cancelToken?: CancellationToken,
  ): Promise<Diagnostic[]> {
    const diagnostics = await super.validateDocument(document, options, cancelToken);
    if (document.parseResult.parserErrors.length > 0 || !this.labels.workspaceHasSchema()) {
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
 * 🔴 Langium relinks a document when something it cross-references changed. A label is not a
 * cross-reference, so a query file would keep a stale unknown-label warning after the schema file
 * defining the type was saved. A document with label sites therefore counts every change as its own.
 */
export class TypeQLiteDocumentBuilder extends DefaultDocumentBuilder {
  protected override shouldRelink(document: LangiumDocument, changedUris: Set<string>): boolean {
    if (super.shouldRelink(document, changedUris)) return true;
    const services = this.serviceRegistry.getServices(document.uri) as Partial<WithLabels>;
    return (services.labels?.Labels.sitesIn(document).length ?? 0) > 0;
  }
}
