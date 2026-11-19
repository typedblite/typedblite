import { describe, expect, it } from 'vitest';

import { parseCondition } from '../src/conditions.js';

const holds = (text: string, rowsIn: number, rowsOut: number): boolean => {
  const condition = parseCondition(text);
  if (!condition.ok) throw new Error(condition.message);
  return condition.test({ rowsIn, rowsOut });
};

describe('a breakpoint condition', () => {
  it('compares a count with a number', () => {
    expect(holds('rowsOut == 0', 3, 0)).toBe(true);
    expect(holds('rowsOut == 0', 3, 1)).toBe(false);
    expect(holds('rows < 2', 9, 1)).toBe(true);
    expect(holds('rowsIn >= 1000', 999, 0)).toBe(false);
    expect(holds('rowsIn != 3', 3, 0)).toBe(false);
    expect(holds('rowsIn<=3', 3, 0)).toBe(true);
    expect(holds('rowsIn > 2', 3, 0)).toBe(true);
  });

  it('joins comparisons with && and ||, && the tighter', () => {
    expect(holds('rowsIn > 0 && rowsOut == 0', 3, 0)).toBe(true);
    expect(holds('rowsIn > 0 && rowsOut == 0', 0, 0)).toBe(false);
    expect(holds('rowsOut == 5 || rowsIn > 0 && rowsOut == 0', 2, 0)).toBe(true);
    expect(holds('rowsOut == 5 || rowsIn > 9 && rowsOut == 0', 2, 0)).toBe(false);
  });

  it('says why it cannot be read', () => {
    expect(parseCondition('rows == ')).toEqual({ ok: false, message: "Cannot read 'rows ==': write a count, a comparison and a number, as in rowsOut == 0. Counts are rowsIn, rowsOut and rows." });
    expect(parseCondition('count > 1')).toEqual({ ok: false, message: "There is no count 'count': the counts are rowsIn, rowsOut and rows." });
    expect(parseCondition('process.exit()').ok).toBe(false);
  });
});
