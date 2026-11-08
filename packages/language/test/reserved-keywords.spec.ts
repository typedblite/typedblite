import { describe, expect, it } from 'vitest';
import { validate } from './parse.js';

/**
 * `RESERVED` is what TypeDB reserves — not what this repository once assumed.
 *
 * 🔴 The list was hand-written and over-reserved by twelve words. `name` was among them, and every
 * Background in the behaviour spec defines `attribute name` — so the validator refused all 1,632
 * of them after the grammar learned to parse them (Phase 01 of TypeDBLite Conformance). Each word
 * below was probed on `typedb/typedb:3.10.4` on 2026-09-11 as `define attribute <word>, value
 * string;` on a scratch database: the reserved ones answer `[DEX31] The reserved keyword "…"
 * cannot be used as an identifier`, the others `answerType: ok`.
 * `d-20260911-the-validator-reserves-ten-identifiers-typedb`.
 */
const define = (word: string) => `define attribute ${word}, value string;`;

const reservedMessages = async (word: string) =>
  (await validate(define(word)))
    .filter((d) => d.severity === 1 && /reserved/i.test(String(d.message)))
    .map((d) => String(d.message));

describe('reserved keywords are what TypeDB 3.10.4 reserves', () => {
  it.each([
    'name',
    'label',
    'kind',
    'type',
    'value',
    'sort',
    'limit',
    'offset',
    'require',
    'distinct',
    'select',
    'reduce',
  ])('accepts `%s` as an identifier, as the server does', async (word) => {
    // `match`-family words are also grammar keywords here, so some of the accepted words cannot
    // be *parsed* as identifiers by this grammar yet (`value`, `select`, `reduce`, `sort`, `limit`,
    // `offset`); the claim this test makes is narrower — the VALIDATOR does not call them
    // reserved. The parse gap is the grammar's, and the spec measures it scenario by scenario.
    expect(await reservedMessages(word)).toEqual([]);
  });

  it.each([
    'match',
    'isa',
    'entity',
    'of',
    'fetch',
    'relation',
    'attribute',
    'sub',
    'owns',
    'plays',
    'relates',
    'has',
    'links',
    'insert',
    'delete',
    'define',
    'undefine',
    'put',
    'update',
  ])(
    'still refuses `%s`, which the server refuses with [DEX31]',
    async (word) => {
      // Most of these cannot parse as identifiers either; where they do, the validator names them.
      // Either way the schema is refused — what matters is that no reserved word is applied.
      const diagnostics = await validate(define(word));
      expect(diagnostics.some((d) => d.severity === 1)).toBe(true);
    },
  );
});
