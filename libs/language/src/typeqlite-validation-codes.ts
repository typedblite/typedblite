/**
 * Diagnostic codes for the validation rules, defined once.
 *
 * 🔴 **There were two vocabularies for the same rules, and they disagreed.** `TypeQLiteValidator`
 * emitted `not-implemented-card` while the runtime's hand-rolled copy emitted
 * `typedblite.card-not-implemented` — for one rule, `@card`. A consumer branching on the code would
 * have handled one and silently missed the other, and the codes are documented as *"stable
 * identifiers a consumer can branch on"*.
 *
 * They live here, in the language package, because that is the layer the runtime depends on rather
 * than the reverse. `diagnostics.ts` composes its `DiagnosticCode` from these for the rules both
 * layers speak about.
 */
export const TypeQLiteValidationCode = {
  /**
   * One code for every annotation the grammar parses and the runtime does not enforce — `@card`,
   * `@unique`, `@independent`, … Replaced `card-not-implemented` and `unique-not-implemented`
   * on 2026-09-11, when the rule changed from refusing to reporting (see `TypeQLiteValidator`).
   */
  annotationNotEnforced: 'typedblite.annotation-not-enforced',
  duplicateLabel: 'typedblite.duplicate-label',
  reservedKeyword: 'typedblite.reserved-keyword',
  /** An annotation on a subject that does not admit it — `ADMITTED` in `typeqlite-annotations.ts`. Replaced `key-on-role`, its one row, on 2026-09-11. */
  annotationNotAdmitted: 'typedblite.annotation-not-admitted',
  /** Two annotations of one category on one subject — *"Try redefine instead"*. */
  annotationRepeated: 'typedblite.annotation-repeated',
  /** A repeated `@values` argument, or an argument that does not fit the value type. */
  annotationArguments: 'typedblite.annotation-arguments',
  /** `entity cream value double` — a thing type has no value. */
  valueTypeOnThing: 'typedblite.value-type-on-thing',
  /** `value rgba` — a name that is not a value type. */
  unknownValueType: 'typedblite.unknown-value-type',
  duplicateOwns: 'typedblite.duplicate-owns',
  unprojectableVariable: 'typedblite.unprojectable-variable',
  /** `$v > $h` with `$v` bound by nothing — a value read before anything assigns it (Phase 06). */
  unboundValue: 'typedblite.unbound-value',
} as const;

export type TypeQLiteValidationCodeValue =
  (typeof TypeQLiteValidationCode)[keyof typeof TypeQLiteValidationCode];
