import { describe, expect, it } from 'vitest';

import { accepts, Timeline, type Stop } from '../src/timeline.js';

const stop = (depth: number, kind: Stop['kind'] = depth === 0 ? 'statement' : 'stage'): Stop => ({ statement: 0, depth, kind, path: [] });

describe('a timeline', () => {
  it('holds a stop per statement, then the end', () => {
    const timeline = new Timeline(3);
    expect([0, 1, 2, 3].map((i) => timeline.at(i)?.kind)).toEqual(['statement', 'statement', 'statement', 'end']);
    expect(timeline.current).toEqual({ statement: 0, depth: 0, kind: 'statement', path: [] });
    expect(timeline.statementIndex(3)).toBe(3);
  });

  it('puts a statement`s own stops after it, once', () => {
    const timeline = new Timeline(2);
    const inner: Stop[] = [
      { statement: 0, depth: 1, kind: 'stage', path: [1, 2] },
      { statement: 0, depth: 1, kind: 'stage', path: [1, 3] },
    ];
    timeline.expand(0, inner);
    expect(timeline.isExpanded(0)).toBe(true);
    expect(timeline.isExpanded(1)).toBe(false);
    expect(timeline.at(1)).toEqual(inner[0]);
    expect(timeline.statementIndex(1)).toBe(3);
    expect(() => timeline.expand(0, [])).toThrow(/already run/);
  });

  it('refuses a stop that is not there', () => {
    expect(() => new Timeline(1).moveTo(5)).toThrow(RangeError);
  });
});

describe('where a move stops', () => {
  it('over: the next stop no deeper than this one', () => {
    expect(accepts('over', stop(1), stop(2))).toBe(false);
    expect(accepts('over', stop(1), stop(1))).toBe(true);
    expect(accepts('over', stop(1), stop(0))).toBe(true);
  });

  it('in: the very next stop', () => {
    expect(accepts('in', stop(0), stop(3))).toBe(true);
  });

  it('out: the next stop shallower than this one, or out of a statement the next statement', () => {
    expect(accepts('out', stop(2), stop(2))).toBe(false);
    expect(accepts('out', stop(2), stop(1))).toBe(true);
    expect(accepts('out', stop(0), stop(1))).toBe(false);
    expect(accepts('out', stop(0), stop(0))).toBe(true);
  });

  it('continue: only the end, until breakpoints say otherwise; every move stops at the end', () => {
    expect(accepts('continue', stop(0), stop(0))).toBe(false);
    for (const motion of ['over', 'in', 'out', 'continue'] as const) expect(accepts(motion, stop(2), stop(0, 'end'))).toBe(true);
  });
});
