import { describe, expect, it } from 'vitest';
import { validate } from './parse.js';
import { TypeQLiteValidationCode } from '../src/typeqlite-validation-codes.js';

/**
 * An annotation the grammar parses and the runtime does not enforce is REPORTED, not refused.
 *
 * 🔴 This file used to assert the opposite — `@card` and `@unique` were errors, on ADR-002 D7's
 * rule that unsupported TypeQLite never silently succeeds. That rule stands; what changed is the
 * shape of "not silently" (founder decision 2026-09-11, TypeDBLite Conformance Phase 01). Refusing
 * a valid TypeDB schema was the wrong side of it: `downstream-store`'s schema could not be applied at
 * all, and every Background in the behaviour spec was refused before a single semantic could be
 * measured. So the diagnostic is below error severity, `define` applies the schema, and the
 * runtime forwards the diagnostic as a fact in its report — a reader sees *"`@card` is parsed and
 * not enforced"* on every call, which is neither a refusal nor a silence. The conformance report
 * card measures each annotation's semantics scenario by scenario until it is enforced.
 *
 * `@key` is enforced (a UNIQUE index) and is not reported.
 */
const notEnforced = async (text: string) =>
  (await validate(text)).filter(
    (d) => d.code === TypeQLiteValidationCode.annotationNotEnforced,
  );

describe('annotations that parse but are not enforced are reported, not refused', () => {
  it.each([
    [
      '@card',
      'define attribute doc-tag, value string; entity doc, owns doc-tag @card(0..);',
    ],
    ['@independent', 'define attribute age @independent, value integer;'],
    ['@regex', 'define attribute email value string @regex("^.*@.*$");'],
    ['@values', 'define attribute n value integer @values(1, 2, 3);'],
    ['@range', 'define attribute s value string @range("A".."z");'],
    // ⚠️ No `@distinct` row: it belongs to lists (`owns t[]`), which the grammar does not have,
    // so no subject admits it yet and `schema-rules.spec.ts` pins the refusal instead. The row
    // that was here put it on a plain `owns`, where TypeDB refuses it too.
    ['@cascade', 'define relation r @cascade, relates x;'],
  ])(
    '%s is reported below error severity, naming the annotation',
    async (annotation, text) => {
      const diagnostics = await notEnforced(text);
      expect(diagnostics).toHaveLength(1);
      const [first] = diagnostics;
      expect(first.severity).not.toBe(1);
      expect(first.message).toContain(annotation);
      expect(first.message).toMatch(/parsed and not enforced/);
      // And nothing about it is an error: the schema is applied.
      expect((await validate(text)).filter((d) => d.severity === 1)).toEqual(
        [],
      );
    },
  );

  // Metadata constrains nothing; what is missing is retention, and the report says so.
  it.each([
    ['@doc', 'define entity player @doc("docs here");'],
    ['@meta', 'define entity player @meta("key", "value");'],
  ])('%s is reported as parsed and not retained', async (annotation, text) => {
    const diagnostics = await notEnforced(text);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].severity).not.toBe(1);
    expect(diagnostics[0].message).toContain(annotation);
    expect(diagnostics[0].message).toMatch(/parsed and not retained/);
    expect((await validate(text)).filter((d) => d.severity === 1)).toEqual([]);
  });

  it.each([
    [
      '@key',
      'define entity skill, owns skill-id @key; attribute skill-id, value string;',
    ],
    [
      '@unique',
      'define attribute email, value string; entity principal, owns email @unique;',
    ],
    ['@abstract', 'define entity abstract-type @abstract;'],
  ])(
    'does not report %s, which the runtime enforces',
    async (_annotation, text) => {
      expect(await validate(text)).toHaveLength(0);
    },
  );
});
