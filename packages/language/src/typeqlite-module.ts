import { type Module, inject } from 'langium';
import {
  createDefaultModule,
  createDefaultSharedModule,
  type DefaultSharedModuleContext,
  type LangiumServices,
  type LangiumSharedServices,
  type PartialLangiumServices,
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
import { TypeQLiteFormatter } from './typeqlite-formatter.js';
import { TypeQLiteSemanticTokenProvider } from './typeqlite-semantic-tokens.js';

/** Language-specific services — the seam ADR-018 Decision 7's middle layer lives in. */
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
  },
  references: {
    ScopeProvider: (services) => new TypeQLiteScopeProvider(services),
  },
  validation: {
    TypeQLiteValidator: () => new TypeQLiteValidator(),
    // 🔴 So a synchronous caller can use the registry at all. Langium's default wraps every check in
    // an `async` function, which makes `getChecks()` promise-returning however the rule was written
    // — see `SyncValidationRegistry`. The language server is unaffected: it awaits either way.
    ValidationRegistry: (services) => new SyncValidationRegistry(services),
  },
};

export function createTypeQLiteServices(context: DefaultSharedModuleContext): {
  shared: LangiumSharedServices;
  TypeQLite: TypeQLiteServices;
} {
  const shared = inject(
    createDefaultSharedModule(context),
    TypeQLiteGeneratedSharedModule,
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
