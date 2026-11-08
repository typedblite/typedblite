import {
  AstUtils,
  Cancellation,
  GrammarUtils,
  ValidationRegistry,
  isOperationCancelled,
  type AstNode,
  type ValidationAcceptor,
  type ValidationCheck,
} from 'langium';
import type { Diagnostic } from 'vscode-languageserver';
import type { TypeQLiteServices } from './typeqlite-module.js';

/**
 * A registry whose wrapper keeps a synchronous check synchronous.
 *
 * 🔴 **Langium wraps EVERY registered check in an `async` function**, in
 * `ValidationRegistry.wrapValidationException`, so `getChecks()` yields promise-returning callables
 * however the rule was written. That is right for the language server, which awaits them, and it is
 * what stops a synchronous engine using the registry at all: the promise is the wrapper's, not the
 * rule's, and there is no way to drain a microtask synchronously.
 *
 * `wrapValidationException` is `protected` and `ValidationRegistry` is a DI slot, so this is
 * Langium's own extension point rather than a fork. The override keeps the wrapper's actual job —
 * catch a throwing check and report it as a diagnostic instead of letting it escape — and returns
 * the check's own result, so a genuinely async rule still surfaces as a promise and
 * {@link validateSync} refuses it rather than ignoring it.
 */
export class SyncValidationRegistry extends ValidationRegistry {
  protected override wrapValidationException(
    check: ValidationCheck,
    thisObj: unknown,
  ): ValidationCheck {
    return (node, accept, cancelToken) => {
      try {
        return check.call(thisObj, node, accept, cancelToken);
      } catch (error) {
        // Cancellation is control flow, not a validation problem — Langium rethrows it and so must
        // this, or a cancelled run would be reported to the author as an error in their document.
        if (isOperationCancelled(error)) throw error;
        const detail = error instanceof Error ? error.message : String(error);
        accept('error', `An error occurred during validation: ${detail}`, { node });
        return undefined;
      }
    };
  }
}

/**
 * Run the registered validation checks over an AST, synchronously.
 *
 * 🔴 **Why this exists rather than `DocumentValidator`.** Langium's validator is the right thing and
 * this reuses its registry and every rule in `TypeQLiteValidator` — but `validateDocument` is `async`,
 * for cancellation and for checks that may return a promise. The interpreter is synchronous
 * throughout, because `node:sqlite`'s `DatabaseSync` is, and `execute`/`query` are called
 * synchronously from every repository. Making them async to reach a validator would ripple through
 * the whole persistence layer to buy nothing: **every check in `TypeQLiteValidator` is synchronous.**
 *
 * So this is Langium's own driver with the `await` removed. The loop is
 * `DefaultDocumentValidator.validateAstNodes` — `streamAst`, then `getChecks(node.$type)` per node —
 * and `getChecks` is public API for exactly this. What is NOT re-implemented is any rule: they stay
 * in `TypeQLiteValidator`, registered once, and serve the language server and the engine alike.
 *
 * ⚠️ **A check that returns a promise is refused, not awaited.** Silently ignoring one would mean a
 * rule that appears registered and never runs — the shape ADR-002 D7 exists to prevent. If a rule
 * ever needs to be async, this function is what says so.
 */
export function validateSync(
  services: TypeQLiteServices,
  root: AstNode,
): readonly Diagnostic[] {
  const registry = services.validation.ValidationRegistry;
  const diagnostics: Diagnostic[] = [];

  const accept: ValidationAcceptor = (severity, message, info): void => {
    diagnostics.push({
      range: rangeOf(info),
      severity: SEVERITY[severity],
      message,
      code: info.code,
      source: 'typedblite',
    });
  };

  for (const node of AstUtils.streamAst(root)) {
    for (const check of registry.getChecks(node.$type)) {
      const outcome = check(node, accept, Cancellation.CancellationToken.None);
      if (outcome && typeof (outcome as PromiseLike<void>).then === 'function') {
        throw new Error(
          `A validation check registered for '${node.$type}' returned a promise. ` +
            'validateSync cannot await it, and ignoring it would leave a rule that looks ' +
            'registered and never runs. Make the check synchronous, or move this caller to ' +
            "Langium's async DocumentValidator.",
        );
      }
    }
  }
  return diagnostics;
}

/** LSP severities, so a diagnostic from here is indistinguishable from the language server's. */
const SEVERITY = { error: 1, warning: 2, info: 3, hint: 4 } as const;

/**
 * The narrowest range Langium can give for this diagnostic.
 *
 * Mirrors `DefaultDocumentValidator.toDiagnostic`'s intent: prefer the CST node of the named
 * property, fall back to the node itself. A check that names `property` wants the reader pointed at
 * that term, not at the whole statement.
 */
function rangeOf(info: {
  node: AstNode;
  property?: string;
  index?: number;
}): Diagnostic['range'] {
  const { node, property, index } = info;
  if (property) {
    const feature = node.$cstNode
      ? GrammarUtils.findNodeForProperty(node.$cstNode, property, index)
      : undefined;
    if (feature) return feature.range;
  }
  return (
    node.$cstNode?.range ?? {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 0 },
    }
  );
}
