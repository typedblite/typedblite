import type { Stop } from './timeline.js';
import type { BlockRecord, FrameRecord, LocatedStatement, Range, Recording, StageRecord, StepRecord, ValueRecord } from './wire.js';

/** A record of a recording, with the id of the record that holds it. */
export type IndexedRecord =
  | { readonly kind: 'frame'; readonly record: FrameRecord; readonly parent?: number }
  | { readonly kind: 'stage'; readonly record: StageRecord; readonly parent: number }
  | { readonly kind: 'block'; readonly record: BlockRecord; readonly parent: number }
  | { readonly kind: 'step'; readonly record: StepRecord; readonly parent: number }
  | { readonly kind: 'value'; readonly record: ValueRecord; readonly parent: number };

/** Every record of a recording by its id: what a stop's path names, and what a refusal's `at` names. */
export function indexRecording(recording: Recording): Map<number, IndexedRecord> {
  const index = new Map<number, IndexedRecord>();
  const frames = (list: readonly FrameRecord[], parent?: number): void => {
    for (const frame of list) {
      index.set(frame.id, parent === undefined ? { kind: 'frame', record: frame } : { kind: 'frame', record: frame, parent });
      for (const stage of frame.stages) {
        index.set(stage.id, { kind: 'stage', record: stage, parent: frame.id });
        blocks(stage.blocks, stage.id);
        frames(stage.frames, stage.id);
      }
    }
  };
  const blocks = (list: readonly BlockRecord[], parent: number): void => {
    for (const block of list) {
      index.set(block.id, { kind: 'block', record: block, parent });
      for (const step of block.steps) {
        index.set(step.id, { kind: 'step', record: step, parent: block.id });
        for (const value of step.values) index.set(value.id, { kind: 'value', record: value, parent: step.id });
        blocks(step.blocks, step.id);
        frames(step.frames, step.id);
      }
    }
  };
  frames(recording.frames);
  return index;
}

/** A range the engine reported for a statement, placed in the file: the statement starts at `at`. */
export function inFile(range: Range, at: LocatedStatement): Range {
  const place = (position: Range['start']): Range['start'] => ({
    line: at.line + position.line,
    character: (position.line === 0 ? at.character : 0) + position.character,
  });
  return { start: place(range.start), end: place(range.end) };
}

/**
 * The stops inside a statement, in the order a person reads them: each stage of each of its pipelines (ADR-014 B11).
 * A stop's path runs from the statement's frame to the stage.
 */
export function stopsOf(statement: number, recording: Recording): Stop[] {
  return recording.frames.flatMap((frame) =>
    frame.stages.map((stage): Stop => ({ statement, depth: 1, kind: 'stage', path: [frame.id, stage.id] })),
  );
}

/** The record a stop is at: the last of its path. */
export function recordAt(stop: Stop, index: Map<number, IndexedRecord>): IndexedRecord | undefined {
  const id = stop.path[stop.path.length - 1];
  return id === undefined ? undefined : index.get(id);
}
