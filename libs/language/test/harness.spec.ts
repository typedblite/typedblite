import { describe, expect, it } from 'vitest';
import { parse } from './parse.js';

describe('the test harness itself', () => {
  it('loads the ESM language package and parses', () => {
    const result = parse('define entity thing;');
    expect(result.parserErrors).toHaveLength(0);
  });
});
