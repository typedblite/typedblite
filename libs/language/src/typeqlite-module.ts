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

/** Language-specific services — the seam ADR-002 Decision 7's middle layer lives in. */
export interface TypeQLiteAddedServices {
  validation: {
    TypeQLiteValidator: TypeQLiteValidator;
  };
}

export type TypeQLiteServices = LangiumServices & TypeQLiteAddedServices;

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
  },
};

/** Services shared across languages: here, only what kind of symbol each definition is. */
export const TypeQLiteSharedModule: Module<LangiumSharedServices, PartialLangiumSharedServices> = {
  lsp: {
    NodeKindProvider: () => new TypeQLiteNodeKindProvider(),
  },
};

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
