import { describe, expect, it } from 'vitest';
import { validate } from './parse.js';

const messages = async (text: string) =>
  (await validate(text)).map((d) => d.message).join('\n');

describe('reserved TypeQLite keywords are rejected as identifiers', () => {
  // 🔴 This test used to pin `label`, because the substrate phase hit `[DEX31] The reserved keyword
  // "label"` — against the old WASM adapter (removed in ADR-002). TypeDB 3.10.4 ACCEPTS `label` as an
  // identifier (probed 2026-09-11; `reserved-keywords.spec.ts` pins the whole list both ways).
  // The rule is unchanged: a word the server refuses is refused here, naming it, because it
  // parses perfectly and would otherwise surface only against a real TypeDB.
  it('rejects `isa` as an attribute name, naming the keyword', async () => {
    expect(await messages('define attribute isa, value string;')).toMatch(
      /isa/,
    );
  });

  it('rejects a reserved word as an entity name', async () => {
    expect(await messages('define entity value;')).toMatch(/value/);
  });

  it('leaves the deliberate workarounds alone', async () => {
    // `skill-name` and `step-kind` exist precisely because `name` and `kind` were unavailable.
    expect(
      await messages(
        'define attribute skill-name, value string; entity skill, owns skill-name;',
      ),
    ).toBe('');
  });
});

describe('a type is not defined twice', () => {
  // The same label as the same kind is one type stated twice — additive, a no-op where it repeats, as on
  // TypeDB (define.feature L2529). A second KIND is a second type, and refused (below).
  it('accepts the same entity stated twice', async () => {
    expect(await messages('define entity skill; entity skill;')).toBe('');
  });

  it('rejects an entity and a relation sharing a name', async () => {
    // The real trap, recorded in skills.schema.typeqlite: TypeDB labels are unique across ALL types,
    // so `relation skill-step` beside `entity skill-step` fails with
    // `[SVL2] Label 'skill-step' should be unique, but is already used by 'entity'`.
    expect(
      await messages(
        'define entity skill-step; relation skill-step, relates x;',
      ),
    ).toMatch(/skill-step/);
  });

  it('accepts distinct names', async () => {
    expect(
      await messages(
        'define entity skill-step; relation skill-composition, relates owner;',
      ),
    ).toBe('');
  });
});

describe('annotations sit where they are meaningful', () => {
  // The one row of the admissibility table this file pinned before Phase 03 of the conformance
  // feature — `@key` on a `relates` role, which has no values to key on. The whole table is in
  // `annotation-admissibility.spec.ts`; this stays as the row that was learned the hard way.
  it('rejects @key on a `relates` role', async () => {
    expect(
      await messages('define relation membership, relates member @key;'),
    ).toMatch(/@key/);
  });

  it('accepts @key on an `owns`', async () => {
    expect(
      await messages(
        'define attribute membership-key, value string; relation membership, relates member, owns membership-key @key;',
      ),
    ).toBe('');
  });
});

describe('a type does not own the same attribute twice', () => {
  it('rejects a duplicated `owns`', async () => {
    expect(
      await messages(
        'define attribute skill-id, value string; entity skill, owns skill-id @key, owns skill-id;',
      ),
    ).toMatch(/skill-id/);
  });

  it('accepts distinct owns', async () => {
    expect(
      await messages(
        'define attribute skill-id, value string; attribute skill-name, value string; entity skill, owns skill-id @key, owns skill-name;',
      ),
    ).toBe('');
  });
});
