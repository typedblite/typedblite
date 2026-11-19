import { describe, expect, it } from 'vitest';

import { rowNode, rowsNode, scopeNodes, thingNode, valueNode, type VariableNode } from '../src/values.js';
import type { Recording } from '../src/wire.js';

const RECORDING = (things: Recording['things'] = {}, extra: Partial<Recording> = {}): Recording => ({
  version: 1,
  limits: { rowsPerStep: 2, callsPerSite: 50, bytes: 1000 },
  frames: [],
  things,
  ...extra,
});

const open = (node: VariableNode): Array<[string, string]> => (node.children?.() ?? []).map((child) => [child.name, child.value]);

describe('how a value reads', () => {
  it('a thing: its type and iid, opening to its attributes as recorded, several of one type numbered', () => {
    const node = thingNode('$p', { iid: '0x1e01', type: 'person', relation: false, attributes: [{ type: 'name', value: 'Ann' }, { type: 'nick', value: 'A' }, { type: 'nick', value: 'Annie' }] }, '0x1e01');
    expect(node.value).toBe('person 0x1e01');
    expect(open(node)).toEqual([
      ['type', 'person'],
      ['iid', '0x1e01'],
      ['name', '"Ann"'],
      ['nick[0]', '"A"'],
      ['nick[1]', '"Annie"'],
    ]);
  });

  it('a thing that no longer exists, or that the recording left out', () => {
    expect(thingNode('$p', { iid: '0x1e01', type: '', relation: false, attributes: [] }, '0x1e01')).toEqual({ name: '$p', value: '(no longer exists) 0x1e01' });
    expect(thingNode('$p', undefined, '0x1e09').value).toBe('(no longer exists) 0x1e09');
  });

  it('an attribute, a value, a type and an empty variable, as a person writes them', () => {
    const things = {};
    expect(valueNode('$n', { kind: 'attribute', type: 'name', valueType: 'string', value: 'Ann' }, things).value).toBe('name "Ann"');
    expect(valueNode('$a', { kind: 'attribute', type: 'age', valueType: 'integer', value: '30' }, things).value).toBe('age 30');
    expect(valueNode('$d', { kind: 'value', valueType: 'integer', value: '60' }, things).value).toBe('60');
    expect(valueNode('$s', { kind: 'value', valueType: 'string', value: 'x"y' }, things).value).toBe('"x\\"y"');
    expect(valueNode('$t', { kind: 'type', label: 'person' }, things).value).toBe('person');
    expect(valueNode('$k', { kind: 'empty' }, things).value).toBe('(empty: the try did not match)');
  });

  it('a row: its bindings on one line, opening to each', () => {
    const things = { 'r#0': { iid: '0x1e01', type: 'person', relation: false, attributes: [] } };
    const node = rowNode('1', { $p: { kind: 'thing', iid: '0x1e01', type: 'person', ref: 'r#0' }, $n: { kind: 'attribute', type: 'name', valueType: 'string', value: 'Ann' } }, things);
    expect(node.value).toBe('{ $p: person 0x1e01, $n: name "Ann" }');
    expect(open(node).map(([name]) => name)).toEqual(['$p', '$n']);
  });

  it('a row set: its total, a row a child, and a line for the rows the cap left out', () => {
    const rows = [{ $x: { kind: 'value', valueType: 'integer', value: '1' } }, { $x: { kind: 'value', valueType: 'integer', value: '2' } }] as const;
    const node = rowsNode('Rows', rows, 3, 5, RECORDING());
    expect([node.value, node.indexed]).toEqual(['5 row(s)', 3]);
    expect(open(node)).toEqual([
      ['1', '{ $x: 1 }'],
      ['2', '{ $x: 2 }'],
      ['…', '3 more, not recorded: a step keeps 2'],
    ]);
    expect(open(rowsNode('Rows', [], 5, 5, RECORDING({}, { rowsOmitted: true })))).toEqual([['…', '5 more, not recorded: the recording passed its size limit, so it kept counts only']]);
  });

  it('a scope: each variable`s kind, value type, and whether it may be empty', () => {
    expect(scopeNodes([{ name: '$p', kind: 'thing', optional: false }, { name: '$k', kind: 'value', valueType: 'string', optional: true }])).toEqual([
      { name: '$p', value: 'thing' },
      { name: '$k', value: 'value, string, may be empty' },
    ]);
  });
});
