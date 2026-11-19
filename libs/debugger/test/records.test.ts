import { describe, expect, it } from 'vitest';

import { indexRecording, inFile, placedIn, recordAt, stopsOf, type IndexedRecord } from '../src/records.js';
import { InProcessHost } from './support/in-process-host.js';
import type { DebugResult } from '../src/wire.js';

const record = async (statement: string): Promise<DebugResult> => {
  const host = new InProcessHost();
  const { id } = await host.call<{ id: string }>('session.open', { location: ':memory:' });
  await host.call('session.run', { session: id, statement: 'define attribute name, value string; entity person, owns name;' });
  await host.call('session.run', { session: id, statement: 'insert $a isa person, has name "Ann"; $b isa person, has name "Bob";' });
  return host.call<DebugResult>('session.debug', { session: id, statement });
};

describe('a recording, read by the debugger', () => {
  it('indexes every record by id, with the record that holds it', async () => {
    const { recording } = await record('match $p isa person, has name $n;\nselect $n;');
    const index = indexRecording(recording);
    const frame = recording.frames[0]!;
    const [match, select] = frame.stages;
    expect(index.get(frame.id)).toEqual({ kind: 'frame', record: frame });
    expect(index.get(match!.id)).toMatchObject({ kind: 'stage', parent: frame.id });
    const block = match!.blocks[0]!;
    expect(index.get(block.id)).toMatchObject({ kind: 'block', parent: match!.id });
    expect(index.get(block.steps[0]!.id)).toMatchObject({ kind: 'step', parent: block.id });
    expect(index.get(select!.id)?.kind).toBe('stage');
  });

  it('gives a stop per stage, and inside a match a stop per step, one deeper, in the order they ran', async () => {
    const { recording } = await record('match $p isa person, has name $n;\nsort $n;\nselect $n;');
    const stops = stopsOf(4, recording);
    const index = indexRecording(recording);
    expect(stops.map((stop) => [stop.statement, stop.depth, stop.kind, (recordAt(stop, index)?.record as { kind: string }).kind])).toEqual([
      [4, 1, 'stage', 'match'],
      [4, 2, 'step', 'thing'],
      [4, 2, 'step', 'has'],
      [4, 1, 'stage', 'sort'],
      [4, 1, 'stage', 'select'],
    ]);
    // A step's path runs from the statement's frame, through its stage, to the step.
    expect(stops[1]!.path).toEqual([recording.frames[0]!.id, recording.frames[0]!.stages[0]!.id, recording.frames[0]!.stages[0]!.blocks[0]!.steps[0]!.id]);
    expect(recordAt({ statement: 0, depth: 0, kind: 'statement', path: [] }, index)).toBeUndefined();
  });

  it('places a range reported for a statement in its file', () => {
    const at = { text: '', line: 10, character: 4 };
    expect(inFile({ start: { line: 0, character: 6 }, end: { line: 2, character: 3 } }, at)).toEqual({ start: { line: 10, character: 10 }, end: { line: 12, character: 3 } });
  });

  it('places a function the statement defines, and nothing inside a function defined elsewhere', () => {
    const frame = (name: string, line: number, character: number): IndexedRecord => ({
      kind: 'frame',
      record: { id: 2, kind: 'function', name, calls: 1, stages: [], range: { start: { line, character }, end: { line, character: character + 3 } } },
      parent: 1,
    });
    const text = 'with fun names($x: person) -> { name }:\n  match $x has name $n;';
    const index = new Map<number, IndexedRecord>([[2, frame('names', 0, 5)]]);
    expect(placedIn([1, 2, 3], index, text)).toBe(true);
    // The same range in a statement that does not define it: the function's text is elsewhere.
    expect(placedIn([1, 2, 3], index, 'match let $m in names($p);\nselect $m;')).toBe(false);
    expect(placedIn([1, 2, 3], new Map([[2, frame('nam', 0, 5)]]), text)).toBe(false);
    expect(placedIn([1, 3], index, 'anything')).toBe(true);
  });
});
