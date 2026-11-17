import { type Module, inject } from 'langium';
import {
  createDefaultModule,
  createDefaultSharedModule,
  type DefaultSharedModuleContext,
  type LangiumServices,
  type LangiumSharedServices,
  type PartialLangiumServices,
  type PartialLangiumSharedServices,
} from 'langium/lsp';
import {
  TypeQLiteGeneratedModule,
  TypeQLiteGeneratedSharedModule,
} from './generated/module.js';
import {
  registerValidationChecks,
  TypeQLiteValidator,
} from './typeqlite-validator.js';
import { SyncValidationRegistry } from './typeqlite-validate-sync.js';
import { TypeQLiteScopeProvider } from './typeqlite-scope.js';
import { TypeQLiteScopeComputation } from './typeqlite-scope-computation.js';
import { TypeQLiteFormatter } from './typeqlite-formatter.js';
import { TypeQLiteSemanticTokenProvider } from './typeqlite-semantic-tokens.js';
import {
  TypeQLiteDocumentSymbolProvider,
  TypeQLiteHoverProvider,
  TypeQLiteNodeKindProvider,
} from './typeqlite-navigation.js';
import { TypeQLiteLabels } from './typeqlite-labels.js';
import { TypeQLiteCompletionProvider } from './typeqlite-completion.js';
import { TypeQLiteCodeActionProvider, TypeQLiteRenameProvider } from './typeqlite-edits.js';
import {
  TypeQLiteDefinitionProvider,
  TypeQLiteDocumentBuilder,
  TypeQLiteDocumentValidator,
  TypeQLiteReferencesProvider,
} from './typeqlite-label-providers.js';

/** Language-specific services — the seam ADR-002 Decision 7's middle layer lives in. */
export interface TypeQLiteAddedServices {
  /** The validator whose checks `registerValidationChecks` registers. */
  validation: {
    TypeQLiteValidator: TypeQLiteValidator;
  };
  /** Labels that are plain `ID`s, resolved against the workspace (ADR-008 D5). Editor-only. */
  labels: {
    Labels: TypeQLiteLabels;
  };
}

/** Langium's services for a language, with TypeQLite's added: its validator and its label resolver. */
export type TypeQLiteServices = LangiumServices & TypeQLiteAddedServices;

/**
 * The services TypeQLite writes itself, which replace or add to Langium's defaults: the formatter, semantic tokens,
 * outline, hover, definition, references, completion, rename and code actions, the label resolver, the scope
 * provider and computation, and the validator and registry.
 */
export const TypeQLiteModule: Module<
  TypeQLiteServices,
  PartialLangiumServices & TypeQLiteAddedServices
> = {
  // 🔴 Registering the formatter here is all that is needed to reach an editor: `server.ts` stands
  // up these same services, `startLanguageServer` advertises the capability, and the client
  // negotiates it. No extension change is involved.
  lsp: {
    Formatter: () => new TypeQLiteFormatter(),
    SemanticTokenProvider: (services) => new TypeQLiteSemanticTokenProvider(services),
    DocumentSymbolProvider: (services) => new TypeQLiteDocumentSymbolProvider(services),
    HoverProvider: (services) => new TypeQLiteHoverProvider(services),
    DefinitionProvider: (services) => new TypeQLiteDefinitionProvider(services),
    ReferencesProvider: (services) => new TypeQLiteReferencesProvider(services),
    CompletionProvider: (services) => new TypeQLiteCompletionProvider(services),
    RenameProvider: (services) => new TypeQLiteRenameProvider(services),
    CodeActionProvider: (services) => new TypeQLiteCodeActionProvider(services),
  },
  labels: {
    Labels: (services) => new TypeQLiteLabels(services),
  },
  references: {
    ScopeProvider: (services) => new TypeQLiteScopeProvider(services),
    // Editor-only, like everything under `references` (ADR-008 D2): the runtime never builds a
    // document, so it never computes scopes.
    ScopeComputation: (services) => new TypeQLiteScopeComputation(services),
  },
  validation: {
    TypeQLiteValidator: () => new TypeQLiteValidator(),
    // 🔴 So a synchronous caller can use the registry at all. Langium's default wraps every check in
    // an `async` function, which makes `getChecks()` promise-returning however the rule was written
    // — see `SyncValidationRegistry`. The language server is unaffected: it awaits either way.
    ValidationRegistry: (services) => new SyncValidationRegistry(services),
    // 🔴 Editor-only (ADR-008 D2): `validateSync` never calls the DocumentValidator, so the
    // unknown-label warning it adds cannot reach the runtime.
    DocumentValidator: (services) => new TypeQLiteDocumentValidator(services),
  },
};

/** Services shared across languages: here, only what kind of symbol each definition is. */
export const TypeQLiteSharedModule: Module<LangiumSharedServices, PartialLangiumSharedServices> = {
  lsp: {
    NodeKindProvider: () => new TypeQLiteNodeKindProvider(),
  },
  workspace: {
    DocumentBuilder: (services) => new TypeQLiteDocumentBuilder(services),
  },
};

/**
 * Creates the TypeQLite language services: Langium's defaults, the generated modules and the hand-written ones,
 * composed, with the validation checks registered. **Start here** to parse, validate or serve TypeQLite.
 *
 * @param context The file system and, for a language server, the connection. Use `EmptyFileSystem` from Langium
 * where there is no disk.
 * @returns `shared`, the services of the workspace, and `TypeQLite`, those of the language.
 */
export function createTypeQLiteServices(context: DefaultSharedModuleContext): {
  shared: LangiumSharedServices;
  TypeQLite: TypeQLiteServices;
} {
  const shared = inject(
    createDefaultSharedModule(context),
    TypeQLiteGeneratedSharedModule,
    TypeQLiteSharedModule,
  );
  const TypeQLite = inject(
    createDefaultModule({ shared }),
    TypeQLiteGeneratedModule,
    TypeQLiteModule,
  );
  shared.ServiceRegistry.register(TypeQLite);
  registerValidationChecks(TypeQLite);
  return { shared, TypeQLite };
}
