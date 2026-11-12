import { beforeEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { TypeDBLiteInterpreter, type TypeDBLiteValue } from '../src/interpreter.js';

/**
 * `relates father as parent` — a role specialising an inherited one (define.feature L635,
 * match.feature L3546). The specialising role is a sub-role: role-type patterns walk it as `sub`
 * walks types, and a relation matched through the general role finds players of the special one.
 */
const SCHEMA = [
  'define',
  'attribute ref value integer;',
  'entity person, owns ref @key, plays marriage:spouse, plays hetero-marriage:husband, plays hetero-marriage:wife;',
  'relation marriage relates spouse @card(0..);',
  'relation hetero-marriage sub marriage, relates husband as spouse, relates wife as spouse;',
  'relation family-relation relates member @abstract;',
  'relation parentship sub family-relation, relates parent as member, relates child as member;',
].join('\n');

let engine: TypeDBLiteInterpreter;
beforeEach(() => {
  engine = new TypeDBLiteInterpreter(':memory:');
  engine.define(SCHEMA);
});

const labels = (query: string, variable: string): string[] =>
  engine.query(query).rows.map((row: Record<string, TypeDBLiteValue>) => row[variable]?.label).sort() as string[];
const refusal = (statement: string): string | undefined => {
  try {
    engine.define(statement);
  } catch (error) {
    return (error as Error).message;
  }
  return undefined;
};

describe('role types form a hierarchy', () => {
  it('a specialising role is a sub-role of the one it specialises', () => {
    assert.deepEqual(labels('match $x sub marriage:spouse;', 'x'), ['hetero-marriage:husband', 'hetero-marriage:wife', 'marriage:spouse']);
  });

  it('`relates $r as member` answers the role and every role specialising it, once each', () => {
    assert.deepEqual(labels('match $_ relates $x as member;', 'x'), ['family-relation:member', 'parentship:child', 'parentship:parent']);
    assert.deepEqual(labels('match $x relates $_ as family-relation:member;', 'x'), ['family-relation', 'parentship']);
  });
});

describe('defining specialisations', () => {
  it('refuses a role no supertype relates — L685', () => {
    assert.match(refusal('define relation close-marriage relates close as spouse;') ?? '', /no supertype of 'close-marriage' relates 'spouse'/);
  });

  it('refuses specialising a role a supertype already specialised — L985', () => {
    assert.match(refusal('define relation fathership sub parentship, relates father as member;') ?? '', /'family-relation:member' must be inherited without specialization/);
  });

  it('adds a specialisation to a plain role, refuses a different one, and redefines it — L619, L630', () => {
    engine.define('define relation step-parentship sub parentship, relates step;');
    assert.equal(refusal('define step-parentship relates step as parent;'), undefined);
    assert.match(refusal('define step-parentship relates step as child;') ?? '', /different 'step-parentship relates step as parent' is already defined/);
    assert.equal(refusal('redefine step-parentship relates step as child;'), undefined);
    assert.match(refusal('redefine step-parentship relates step as child;') ?? '', /already defined/);
  });

  it('undefines a specialisation only as it is defined — L631', () => {
    assert.match(refusal('undefine as member from parentship relates parent;') ?? 'x', /^x$/);
    assert.match(refusal('undefine as member from parentship relates parent;') ?? '', /there is no defined 'parentship relates parent as member' to undefine/);
  });
});

describe('matching relations through specialised roles', () => {
  it('finds players of the special roles through the general one — match.feature L1484', () => {
    engine.execute('insert $a isa person, has ref 1; $b isa person, has ref 2; (wife: $a, husband: $b) isa hetero-marriage;');
    assert.equal(engine.query('match $m links (spouse: $x, spouse: $y), isa hetero-marriage;').rows.length, 2);
    assert.equal(engine.query('match $m links (wife: $x, husband: $y), isa marriage;').rows.length, 1);
  });
});
