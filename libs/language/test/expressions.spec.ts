import { describe, expect, it } from 'vitest';
import { parse, validate } from './parse.js';
import { TypeQLiteValidationCode } from '../src/typeqlite-validation-codes.js';
import {
  isBinaryExpression,
  isLetPattern,
  isMatchStage,
  isNegationExpression,
  type LetPattern,
  type Pipeline,
} from '../src/generated/ast.js';

/**
 * Value expressions — Phase 06 of the conformance feature. Every form the behaviour spec writes,
 * pinned to parse, and the precedence table pinned by shape: what an expression EVALUATES to is
 * the interpreter's and the report card's.
 */
const parses = (text: string): boolean => {
  const { lexerErrors, parserErrors } = parse(text);
  return lexerErrors.length === 0 && parserErrors.length === 0;
};

const firstLet = (text: string): LetPattern => {
  const pipeline = parse(text).value.clauses[0] as Pipeline;
  const match = pipeline.stages.find(isMatchStage);
  const pattern = match?.patterns.find(isLetPattern);
  if (!pattern) throw new Error('no let');
  return pattern;
};

describe('value expressions', () => {
  it.each([
    'match let $a = 6 + 3; let $b = 6 - 3; let $c = 6 * 3; let $d = 6 / 3; select $a, $b, $c, $d;',
    'match let $a = 6.0dec + 3.0dec;',
    'match $x isa person, has age $a, has height $h; let $v = $a * 2; select $v;',
    'match $x isa person, has age $a; $a > 10;',
    'match $x isa person, has age $a, has height $h; $v == $a; $v > $h; select $x, $v;',
    'match let $a = floor(3/2); let $b = ceil(3/2);',
    'match let $result = std::math::floor(3/2);',
    'match let $in = -11.5dec; let $out = ceil($in); select $in, $out;',
    'match let $a = 2 ^ 3 ^ 2; let $b = -2 ^ 2; let $c = (1 + 2) * 3 % 2;',
    'match let $a = max(2, -3); let $c = max(10.2dec, 13.5dec);',
    'match $x isa person, has age $y; reduce $red_var = sum($y);',
    'match $x isa person, has age $y; reduce $red_var? = max($y);',
    'match $x isa person; $y isa person; reduce $cy = count($y), $cz = count($z) groupby $x;',
    'match $x isa person; select $y; reduce $s = sum($y);',
    'match $p isa person; reduce $c = count();',
    // A bare `count` takes no parentheses (reduce.feature L92).
    'match $x isa person; reduce $count = count;',
    // `std::string::len` — `string` is a value-type keyword and still a namespace segment (L2398).
    'match let $result = std::string::len("12345");',
    // Single-quoted strings (L1002) and an exponent on a double (L668).
    "insert $x isa person, has name 'Steve';",
    'match let $a = 1.8e308;',
  ])('parses %s', (text) => expect(parses(text)).toBe(true));

  it("refuses a value read nothing binds, in TypeDB's words — expression.feature L34", async () => {
    const diagnostics = await validate(
      'match $x isa person, has age $a, has height $h; $v == $a; $v > $h; select $x, $v;',
    );
    const unbound = diagnostics.filter(
      (d) => d.code === TypeQLiteValidationCode.unboundValue,
    );
    expect(unbound.map((d) => d.message)).toEqual([
      "The variable 'v' must be bound to a value before it's used.",
      "The variable 'v' must be bound to a value before it's used.",
    ]);
    // The `select` check leaves `$v` to this one: one finding, not two, is what the engine throws.
    expect(
      diagnostics.some(
        (d) => d.code === TypeQLiteValidationCode.unprojectableVariable,
      ),
    ).toBe(false);
    // A `let` binds it; a `has` binds `$a`; a later `let` may read an earlier one.
    expect(
      (
        await validate(
          'match $x isa person, has age $a; let $v = $a * 2; let $w = $v + 1; $w > 3;',
        )
      ).filter((d) => d.severity === 1),
    ).toEqual([]);
  });

  it('stays silent on a later stage, which may read what an earlier one selected — variables.feature L38', async () => {
    const diagnostics = await validate(
      'match let $x = 1; select $x; match let $y = $x + 2;',
    );
    expect(
      diagnostics.filter(
        (d) => d.code === TypeQLiteValidationCode.unboundValue,
      ),
    ).toEqual([]);
    // A `define` before the match is not an earlier stage: the check still fires (review, round 1).
    const afterDefine = await validate(
      'define entity person; match let $y = $x + 2;',
    );
    expect(
      afterDefine.filter(
        (d) => d.code === TypeQLiteValidationCode.unboundValue,
      ),
    ).toHaveLength(1);
    // An earlier pipeline that binds nothing of the name does not silence it either (round 2):
    // what an earlier stage selects, binds or reduces to counts as bound, nothing else.
    const unrelated = await validate(
      'match $p isa person; select $p; match let $y = $x + 2;',
    );
    expect(
      unrelated.filter((d) => d.code === TypeQLiteValidationCode.unboundValue),
    ).toHaveLength(1);
    const reduced = await validate(
      'match $p isa person, has age $a; reduce $s = sum($a); match let $y = $s + 2;',
    );
    expect(
      reduced.filter((d) => d.code === TypeQLiteValidationCode.unboundValue),
    ).toEqual([]);
  });

  it('binds + and - below * and /, and ^ above unary minus', () => {
    const sum = firstLet('match let $a = 1 + 2 * 3;').expression;
    expect(isBinaryExpression(sum) && sum.operator === '+').toBe(true);
    expect(
      isBinaryExpression(sum) &&
        isBinaryExpression(sum.right) &&
        sum.right.operator === '*',
    ).toBe(true);
    // In an expression a literal is unsigned: `-10` is a negation over `10`, so that `10-1` is a
    // subtraction and not `10` beside `-1` (Phase 06 review). `- $x` is a negation too.
    const neg = firstLet('match let $b = - $x;').expression;
    expect(isNegationExpression(neg)).toBe(true);
    expect(
      isNegationExpression(firstLet('match let $b = -10;').expression),
    ).toBe(true);
    const tight = firstLet('match let $b = 10-1;').expression;
    expect(isBinaryExpression(tight) && tight.operator === '-').toBe(true);
    // Outside an expression the sign is the literal's: `has age -5`.
    expect(parses('insert $x isa person, has age -5;')).toBe(true);
    const power = firstLet('match let $c = 2 ^ 3 ^ 2;').expression;
    // right-associative: 2 ^ (3 ^ 2)
    expect(
      isBinaryExpression(power) &&
        isBinaryExpression(power.right) &&
        power.right.operator === '^',
    ).toBe(true);
  });

  it('lexes 10.2dec as a decimal, 10.2 as a double, 10 as an integer', () => {
    expect(firstLet('match let $a = 10.2dec;').expression.$type).toBe(
      'LiteralExpression',
    );
    expect(parse('match let $a = 10.2dec;').value.$cstNode?.text).toContain(
      '10.2dec',
    );
  });
});
