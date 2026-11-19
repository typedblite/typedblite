import { describe, expect, it } from 'vitest';

import { indexRecording, inFile, recordAt, stopsOf } from '../src/records.js';
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

  it('gives a stop per stage, in order, each at its record', async () => {
    const { recording } = await record('match $p isa person, has name $n;\nsort $n;\nselect $n;');
    const stops = stopsOf(4, recording);
    expect(stops.map((stop) => [stop.statement, stop.depth, stop.kind])).toEqual([
      [4, 1, 'stage'],
      [4, 1, 'stage'],
      [4, 1, 'stage'],
    ]);
    const index = indexRecording(recording);
    expect(stops.map((stop) => recordAt(stop, index)?.record).map((r) => (r as { kind: string }).kind)).toEqual(['match', 'sort', 'select']);
    expect(recordAt({ statement: 0, depth: 0, kind: 'statement', path: [] }, index)).toBeUndefined();
  });

  it('places a range reported for a statement in its file', () => {
    const at = { text: '', line: 10, character: 4 };
    expect(inFile({ start: { line: 0, character: 6 }, end: { line: 2, character: 3 } }, at)).toEqual({ start: { line: 10, character: 10 }, end: { line: 12, character: 3 } });
  });
});
