/**
 * A conditional breakpoint's condition (ADR-014 B11): comparisons of a stage's or a step's row counts, joined by `&&`
 * and `||`, read by a small parser and never by `eval`.
 *
 * ```
 * rowsOut == 0
 * rowsIn > 0 && rowsOut == 0
 * rows < 10 || rowsIn >= 1000
 * ```
 *
 * `rows` is `rowsOut`. `&&` binds tighter than `||`, and there are no brackets: what is useful here is short.
 */
export interface Counts {
  readonly rowsIn: number;
  readonly rowsOut: number;
}

/** A condition, read: `test` answers whether it holds for some counts. */
export type Condition = { readonly ok: true; readonly test: (counts: Counts) => boolean } | { readonly ok: false; readonly message: string };

const NAMES: Record<string, keyof Counts> = { rowsIn: 'rowsIn', rowsOut: 'rowsOut', rows: 'rowsOut' };
const COMPARE: Record<string, (a: number, b: number) => boolean> = {
  '==': (a, b) => a === b,
  '!=': (a, b) => a !== b,
  '<=': (a, b) => a <= b,
  '>=': (a, b) => a >= b,
  '<': (a, b) => a < b,
  '>': (a, b) => a > b,
};

/** Read a condition. A condition that cannot be read says why, in words a person can act on. */
export function parseCondition(text: string): Condition {
  const tests: Array<Array<(counts: Counts) => boolean>> = [];
  for (const either of text.split('||')) {
    const all: Array<(counts: Counts) => boolean> = [];
    for (const part of either.split('&&')) {
      const match = /^\s*(\w+)\s*(==|!=|<=|>=|<|>)\s*(\d+)\s*$/.exec(part);
      if (!match) {
        return { ok: false, message: `Cannot read '${part.trim()}': write a count, a comparison and a number, as in rowsOut == 0. Counts are rowsIn, rowsOut and rows.` };
      }
      const [, name, operator, number] = match;
      const count = NAMES[name!];
      if (count === undefined) return { ok: false, message: `There is no count '${name}': the counts are rowsIn, rowsOut and rows.` };
      const compare = COMPARE[operator!]!;
      const value = Number(number);
      all.push((counts) => compare(counts[count], value));
    }
    tests.push(all);
  }
  return { ok: true, test: (counts) => tests.some((all) => all.every((test) => test(counts))) };
}
