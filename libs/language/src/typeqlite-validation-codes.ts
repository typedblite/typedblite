/**
 * Diagnostic codes for the validation rules, defined once.
 *
 * They live here, in the language package, because that is the layer the runtime depends on rather
 * than the reverse. `diagnostics.ts` composes its `DiagnosticCode` from these for the rules both
 * layers speak about.
 *
 * @privateRemarks
 * 🔴 **There were two vocabularies for the same rules, and they disagreed.** `TypeQLiteValidator`
 * emitted `not-implemented-card` while the runtime's hand-rolled copy emitted
 * `typedblite.card-not-implemented` — for one rule, `@card`. A consumer branching on the code would
 * have handled one and silently missed the other, and the codes are documented as *"stable
 * identifiers a consumer can branch on"*.
 */
export const TypeQLiteValidationCode = {
  /**
   * One code for every annotation the grammar parses and the runtime does not enforce — `@card`,
   * `@unique`, `@independent`, … It replaced `card-not-implemented` and `unique-not-implemented`
   * when the rule changed from refusing to reporting (see `TypeQLiteValidator`).
   */
  annotationNotEnforced: 'typedblite.annotation-not-enforced',
  duplicateLabel: 'typedblite.duplicate-label',
  reservedKeyword: 'typedblite.reserved-keyword',
  /** An annotation on a subject that does not admit it — `ADMITTED` in `typeqlite-annotations.ts`. It replaced `key-on-role`. */
  annotationNotAdmitted: 'typedblite.annotation-not-admitted',
  /** Two annotations of one category on one subject — *"Try redefine instead"*. */
  annotationRepeated: 'typedblite.annotation-repeated',
  /** A repeated `@values` argument, or an argument that does not fit the value type. */
  annotationArguments: 'typedblite.annotation-arguments',
  /** `entity cream value double` — a thing type has no value. */
  valueTypeOnThing: 'typedblite.value-type-on-thing',
  /** `entity a sub b, sub c` — a second `sub` or `value` clause on one type. */
  repeatedClause: 'typedblite.repeated-clause',
  /** `value rgba` — a name that is not a value type. */
  unknownValueType: 'typedblite.unknown-value-type',
  duplicateOwns: 'typedblite.duplicate-owns',
  unprojectableVariable: 'typedblite.unprojectable-variable',
  /** `$v > $h` with `$v` bound by nothing — a value read before anything assigns it. */
  unboundValue: 'typedblite.unbound-value',
  /** `select $_`, `sort $_`, `reduce … groupby $_` — a stage that names a variable needs a named one. */
  anonymousVariable: 'typedblite.anonymous-variable',
  /**
   * A label no file in the workspace defines (ADR-008 D6). Editor-only: reported by
   * `TypeQLiteDocumentValidator`, never by a registered check, so the runtime never sees it (ADR-008 D2).
   */
  unknownLabel: 'typedblite.unknown-label',
} as const;

/** A diagnostic code of a validation rule: one of the values of {@link TypeQLiteValidationCode}. */
export type TypeQLiteValidationCodeValue =
  (typeof TypeQLiteValidationCode)[keyof typeof TypeQLiteValidationCode];
