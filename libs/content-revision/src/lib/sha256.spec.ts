/**
 * ADR-009 D5: revisions are hashed by this repository's own SHA-256, and 🔴 **a revision must not
 * change** — every store written before the switch from `node:crypto` must keep converging with every
 * store written after it, on any platform. So this is a differential: the same inputs through
 * `node:crypto` (the old path, still available to a test) and through `sha256`.
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { canonical, type EntityState } from './canonical.js';
import { computeRevision } from './revision.js';
import { sha256, sha256Hex } from './sha256.js';

const nodeHex = (text: string): string => createHash('sha256').update(text).digest('hex');

/** A small deterministic generator, so a failure names a reproducible case. */
function* random(seed: number): Generator<number> {
  let state = seed >>> 0;
  for (;;) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    yield state / 0x100000000;
  }
}

/** Strings that stress UTF-8: ASCII, NUL, 2-, 3- and 4-byte sequences, and lone surrogates. */
const ALPHABET = ['a', 'Z', '0', ' ', '\0', '\n', '"', 'é', 'ß', '€', '中', '😀', '\uD800', '\uDC00', 'x'];
function strings(seed: number, count: number, maxLength: number): string[] {
  const next = random(seed);
  const out: string[] = [];
  for (let n = 0; n < count; n++) {
    const length = Math.floor(next.next().value * maxLength);
    let text = '';
    for (let i = 0; i < length; i++) text += ALPHABET[Math.floor(next.next().value * ALPHABET.length)];
    out.push(text);
  }
  return out;
}

describe('sha256', () => {
  it('matches the FIPS 180-4 test vectors', () => {
    assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.equal(
      sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('equals node:crypto at every padding boundary', () => {
    for (let length = 0; length <= 200; length++) {
      const text = 'q'.repeat(length);
      assert.equal(sha256Hex(text), nodeHex(text), `length ${length}`);
    }
  });

  it('equals node:crypto over a corpus of mixed UTF-8, NUL and lone surrogates', () => {
    for (const text of strings(9, 2000, 120)) assert.equal(sha256Hex(text), nodeHex(text), JSON.stringify(text));
  });

  it('equals node:crypto for a large input', () => {
    const text = strings(17, 1, 1)[0] + '€😀'.repeat(200_000);
    assert.equal(sha256Hex(text), nodeHex(text));
  });

  it('hashes bytes as given', () => {
    const bytes = new Uint8Array([0, 255, 128, 1]);
    assert.equal(Buffer.from(sha256(bytes)).toString('hex'), createHash('sha256').update(bytes).digest('hex'));
  });
});

describe('computeRevision after ADR-009', () => {
  /** The algorithm exactly as it was on `node:crypto`, before ADR-009. */
  const before = (state: EntityState | undefined, parent: string | undefined, deleted: boolean): string => {
    const generation = parent ? Number(parent.slice(0, parent.indexOf('-'))) + 1 : 1;
    const digest = createHash('sha256')
      .update(state ? canonical(state) : '')
      .update('\0')
      .update(parent ?? '')
      .update('\0')
      .update(deleted ? '1' : '0')
      .digest('hex')
      .slice(0, 32);
    return `${generation}-${digest}`;
  };

  it('gives every state, parent and tombstone the revision it had before', () => {
    const values = strings(23, 600, 40);
    const next = random(31);
    let parent: string | undefined;
    for (let i = 0; i < 300; i++) {
      const state: EntityState = {
        type: values[i] || 'thing',
        attributes: [
          { type: 'name', value: values[i + 1] ?? '' },
          { type: 'note', value: values[i + 2] ?? '' },
        ],
        roles: i % 3 === 0 ? [{ role: 'employee', player: values[i + 3] ?? '' }] : [],
      };
      const deleted = next.next().value < 0.1;
      const withState = deleted ? undefined : state;
      assert.equal(computeRevision({ state: withState, parent, deleted }), before(withState, parent, deleted), `case ${i}`);
      parent = computeRevision({ state: withState, parent, deleted });
    }
  });
});
