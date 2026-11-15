import { describe, expect, it } from 'vitest';
import { decodeShare, encodeShare, LONG_LINK } from '../src/share';

describe('a program in a link', () => {
  it.each([
    ['plain text', 'match $p isa person;'],
    ['an empty program', ''],
    ['non-ASCII and emoji', 'insert $p isa person, has name "Zoë 🐶 日本語";'],
    ['every byte-ish character base64 treats specially', '???>>>~~~ +/= \n\t'],
    ['a large program, under the limit', 'insert $x isa thing;\n'.repeat(5_000)],
  ])('round-trips %s', (_name, source) => {
    expect(decodeShare(encodeShare(source))).toBe(source);
  });

  it('puts the program after #code=, in a URL-safe alphabet with no padding', () => {
    const hash = encodeShare('???>>>~~~');
    expect(hash.startsWith('#code=')).toBe(true);
    expect(hash.slice('#code='.length)).toMatch(/^[A-Za-z0-9_-]*$/);
  });

  it('reads a hash with or without its leading #', () => {
    expect(decodeShare(encodeShare('x').slice(1))).toBe('x');
  });

  it.each([
    ['no hash', ''],
    ['another key', '#other=abc'],
    ['characters outside the alphabet', '#code=abc$%^'],
    ['standard base64 punctuation', '#code=ab+/'],
    ['bytes that are not UTF-8', '#code=_w'],
    ['a length that cannot be base64', '#code=a'],
    ['a link far larger than any program', `#code=${'A'.repeat(500_000)}`],
    ['a program over the size limit', encodeShare('insert $x isa thing;\n'.repeat(20_000))],
  ])('refuses %s, returning undefined', (_name, hash) => {
    expect(decodeShare(hash)).toBeUndefined();
  });

  it('knows a long link when it sees one', () => {
    expect(encodeShare('x'.repeat(LONG_LINK)).length).toBeGreaterThan(LONG_LINK);
    expect(encodeShare('match $p isa person;').length).toBeLessThan(LONG_LINK);
  });
});
