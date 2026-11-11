import type { AstNode } from 'langium';
import { DiagnosticSeverity, type Diagnostic, type Range } from 'vscode-languageserver';
import { TypeQLiteValidationCode } from '@typedblite/language';

/**
 * Execution diagnostics for TypeQLite — ADR-004.
 *
 * 🔴 **Returned, never emitted.** The engine has no dependency on a domain events module and
 * must not acquire one: `change-stream.ts` avoided even the *name* `EventSource` to stay clear of
 * domain event types. The application handler that already publishes domain events is what decides
 * whether a diagnostic belongs in a payload.
 *
 * 🔴 **This is not an error channel.** Anything that throws today still throws; a diagnostic is
 * *attached* to the thrown error, never substituted for it. See `attachDiagnostic`.
 */

export const DIAGNOSTIC_SOURCE = 'typedblite';

/**
 * The cap ADR-004 Decision 5 requires.
 *
 * Execution facts are counts rather than lists precisely so a large write cannot produce a large
 * payload — but a statement with hundreds of unknown attributes still could, so the collector stops
 * and says how many it dropped.
 */
export const MAX_DIAGNOSTICS = 50;

export interface ExecutionReport {
  readonly diagnostics: readonly Diagnostic[];
}

/** Codes are stable identifiers a consumer can branch on; messages are for people. */
export const DiagnosticCode = {
  // 🔴 Not re-declared. This rule lives in `TypeQLiteValidator` and is forwarded from `parse()` as a
  // fact, so a second string here would be a second vocabulary for one rule — which is exactly
  // what `TypeQLiteValidationCode`'s header records going wrong.
  annotationNotEnforced: TypeQLiteValidationCode.annotationNotEnforced,
  parseFailed: 'typedblite.parse-failed',
  /** A reserved word where a label belongs — TypeDB's `[DEX31]`; the validator's code, forwarded. */
  reservedKeyword: TypeQLiteValidationCode.reservedKeyword,
  unknownType: 'typedblite.unknown-type',
  unknownAttribute: 'typedblite.unknown-attribute',
  danglingRelation: 'typedblite.dangling-relation',
  constraintViolated: 'typedblite.constraint-violated',
  schemaApplied: 'typedblite.schema-applied',
  keysRegistered: 'typedblite.keys-registered',
  emptyMatch: 'typedblite.empty-match',
  wrote: 'typedblite.wrote',
  tombstones: 'typedblite.tombstones',
  noCandidates: 'typedblite.no-candidates',
  projected: 'typedblite.projected',
  unprojectableVariable: TypeQLiteValidationCode.unprojectableVariable,
  /** `insert $l links (source: $b);` against an already-matched relation — see `runInsert`. */
  unsupportedIncrementalRole: 'typedblite.unsupported-incremental-role',
  unownedAttribute: 'typedblite.unowned-attribute',
  /** `email owns name;` — an attribute re-open carrying a trait. The attribute is known; the trait is the fault. */
  traitOnAttribute: 'typedblite.trait-on-attribute',
  /** `code-name sub name, value integer` under a string `name` — a subtype's value type is its parent's. */
  valueTypeConflict: 'typedblite.value-type-conflict',
  // The schema rules TypeDB applies at `define` — `schema-rules.ts`, Phase 03 of the conformance
  // feature. Three are the validator's own codes, forwarded: the rule is the same, the schema is
  // what settles it.
  annotationNotAdmitted: TypeQLiteValidationCode.annotationNotAdmitted,
  annotationArguments: TypeQLiteValidationCode.annotationArguments,
  valueTypeOnThing: TypeQLiteValidationCode.valueTypeOnThing,
  /** `entity name;` over an attribute `name` — a label keeps its kind. */
  kindChanged: 'typedblite.kind-changed',
  /** `entity pigeon sub animal;` when `pigeon sub bird` is applied — a parent changes by redefine only. */
  supertypeChanged: 'typedblite.supertype-changed',
  cyclicHierarchy: 'typedblite.cyclic-hierarchy',
  /** `entity contractor sub employment` — a parent is of its child's kind. */
  supertypeKind: 'typedblite.supertype-kind',
  /** `person @abstract;` when persons exist. */
  abstractWithInstances: 'typedblite.abstract-with-instances',
  /** `insert $x isa factory;` when `factory` is abstract. */
  abstractType: 'typedblite.abstract-type',
  /** `house owns person;` — only an attribute type is owned. */
  ownsNotAttribute: 'typedblite.owns-not-attribute',
  /** `plays employment:ceo` — no such role declared by that relation (an inherited one counts as its declarer's). */
  unknownRole: 'typedblite.unknown-role',
  /** `person relates employee;` on an entity. */
  relatesOnNonRelation: 'typedblite.relates-on-non-relation',
  /** `fathership relates parent;` when `parentship relates parent` is above it. */
  roleRedeclared: 'typedblite.role-redeclared',
  /** `person owns barcode @key;` when two products share a barcode — the data does not conform. */
  dataDoesNotConform: 'typedblite.data-does-not-conform',
  journalMode: 'typedblite.journal-mode',
  /** A statement the grammar has and the engine does not — ADR-002 D7's third layer, named. */
  notImplemented: 'typedblite.not-implemented',
  // `undefine` and `redefine` — `schema-mutation.ts`, Phase 04 of the conformance feature.
  /** `redefine person sub x` on a parentless type; `undefine @card from …` where none is — "Try define instead" / "no defined". */
  notDefined: 'typedblite.not-defined',
  /** A redefine that restates what is applied — "already defined". */
  alreadyDefined: 'typedblite.already-defined',
  /** A redefine whose one statement changes nothing this engine records — "Nothing was redefined". */
  nothingRedefined: 'typedblite.nothing-redefined',
  /** `undefine person` while persons exist — "must be deleted". */
  hasInstances: 'typedblite.has-instances',
  /** `undefine person` while `child sub person` exists. */
  hasSubtypes: 'typedblite.has-subtypes',
  /** `undefine owns name from child` when `person owns name` — inherited, "not allowed". */
  inheritedCapability: 'typedblite.inherited-capability',
  /** `redefine entity x label y` when `y` is taken — the validator's own duplicate-label code, forwarded. */
  duplicateLabel: TypeQLiteValidationCode.duplicateLabel,
  /** `undefine`/`redefine` applied — what changed, as a fact. */
  schemaChanged: 'typedblite.schema-changed',
  /** `$x sub person, has name $n` — a variable used as a type and as a thing in one pattern (Phase 05). */
  mixedPattern: 'typedblite.mixed-pattern',
  /** An arithmetic result outside its type — a 64-bit integer overflow, a division by zero (Phase 06). */
  valueOutOfRange: 'typedblite.value-out-of-range',
  /** A function the engine does not know (Phase 06). */
  unknownFunction: 'typedblite.unknown-function',
  /** A built-in called with the wrong number of arguments (Phase 06). */
  functionArity: 'typedblite.function-arity',
  /** A value expression reads a variable nothing binds (Phase 06). */
  unboundValue: 'typedblite.unbound-value',
  /** A `let` variable assigned twice in one branch (Phase 06). */
  valueAssignedTwice: 'typedblite.value-assigned-twice',
  /** `let`s that wait on each other and can never be evaluated (Phase 06). */
  valueCycle: 'typedblite.value-cycle',
  /** A reducer the engine does not know, or one applied to the wrong kind of variable (Phase 06). */
  reducer: 'typedblite.reducer',
  /**
   * A `fetch` the engine refuses before any row: a variable not available to it, a key mapped twice,
   * an entity or relation fetched as a value, an attribute no owner can have, a scalar projection
   * of an attribute that can be owned more than once, a sub-query with no `fetch`.
   */
  fetch: 'typedblite.fetch',
  truncated: 'typedblite.diagnostics-truncated',
} as const;

export type DiagnosticCodeValue =
  (typeof DiagnosticCode)[keyof typeof DiagnosticCode];

/**
 * The range used when a statement can be located but a *term* inside it cannot.
 *
 * 🔴 The honest case is a SQLite constraint violation: it is raised inside the database, which has
 * never seen the TypeQLite, so there is no term to point at. Pointing at one anyway would be worse
 * than pointing at the whole statement.
 */
export const WHOLE_DOCUMENT: Range = {
  start: { line: 0, character: 0 },
  end: { line: 0, character: 0 },
};

export const rangeOf = (node: AstNode | undefined): Range | undefined =>
  node?.$cstNode?.range;

/** Build a range from character offsets, for errors that predate the AST. */
export function rangeFromOffset(
  text: string,
  offset: number,
  length: number,
): Range {
  const before = text.slice(0, Math.max(0, offset));
  const line = before.split('\n').length - 1;
  const character = offset - (before.lastIndexOf('\n') + 1);
  return {
    start: { line, character },
    end: { line, character: character + Math.max(0, length) },
  };
}

type WithDiagnostic = { diagnostic?: Diagnostic };

/**
 * Attach a diagnostic to an error **without** changing its class or message.
 *
 * 🔴 Deliberately not a subclass. Consumers match on the error message text; a new subclass would
 * silently break them. A new error type here would break the duplicate-registration guarantee in
 * exactly the way ADR-004 Decision 3 exists to prevent.
 */
export function attachDiagnostic<E>(error: E, diagnostic: Diagnostic): E {
  if (error && typeof error === 'object') {
    (error as E & WithDiagnostic).diagnostic = diagnostic;
  }
  return error;
}

export const diagnosticOf = (error: unknown): Diagnostic | undefined =>
  error && typeof error === 'object'
    ? (error as WithDiagnostic).diagnostic
    : undefined;

/**
 * Gathers diagnostics for one call, and stops at the cap.
 *
 * Severities follow LSP: `Error` for anything that also throws, `Information` for an execution
 * fact. There is no `Warning` tier on purpose — a thing either stopped execution or it did not, and
 * a middle category would invite exactly the "it's only a warning" reading that ADR-004 Decision 3
 * forbids.
 */
export class DiagnosticCollector {
  private readonly items: Diagnostic[] = [];
  private dropped = 0;

  error(code: DiagnosticCodeValue, message: string, range?: Range): Diagnostic {
    return this.push(DiagnosticSeverity.Error, code, message, range);
  }

  fact(code: DiagnosticCodeValue, message: string, range?: Range): void {
    this.push(DiagnosticSeverity.Information, code, message, range);
  }

  private push(
    severity: DiagnosticSeverity,
    code: DiagnosticCodeValue,
    message: string,
    range?: Range,
  ): Diagnostic {
    const diagnostic: Diagnostic = {
      range: range ?? WHOLE_DOCUMENT,
      severity,
      code,
      message,
      source: DIAGNOSTIC_SOURCE,
    };
    // 🔴 An error is always kept, even past the cap. Dropping the diagnostic attached to a throw
    // would leave the caller with an exception and no position — the situation this phase exists
    // to end.
    if (this.items.length < MAX_DIAGNOSTICS || severity === DiagnosticSeverity.Error) {
      this.items.push(diagnostic);
    } else {
      this.dropped += 1;
    }
    return diagnostic;
  }

  report(): ExecutionReport {
    if (this.dropped === 0) return { diagnostics: this.items };
    return {
      diagnostics: [
        ...this.items,
        {
          range: WHOLE_DOCUMENT,
          severity: DiagnosticSeverity.Information,
          code: DiagnosticCode.truncated,
          message: `${this.dropped} further diagnostics were suppressed (cap ${MAX_DIAGNOSTICS}).`,
          source: DIAGNOSTIC_SOURCE,
        },
      ],
    };
  }
}
