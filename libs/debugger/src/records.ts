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
 * The stops inside a statement, in the order a person reads them (ADR-014 B6, B11): each stage of each of its
 * pipelines, and inside a stage each step of its `match`, in the order the steps ran. Inside a step, the steps of the
 * blocks it ran (an `or`'s branches, a `try`, a `not`) and the stages of the functions it called; inside a `fetch`
 * stage, its sub-queries. Each level is one deeper. A stop's path holds the ids of the frames, stages and steps from
 * the statement's frame down to its own record.
 */
export function stopsOf(statement: number, recording: Recording): Stop[] {
  const stops: Stop[] = [];
  const stagesOf = (frame: FrameRecord, path: readonly number[], depth: number): void => {
    for (const stage of frame.stages) {
      const at = [...path, stage.id];
      stops.push({ statement, depth, kind: 'stage', path: at });
      blocksOf(stage.blocks, at, depth + 1);
      framesOf(stage.frames, at, depth + 1);
    }
  };
  const blocksOf = (blocks: readonly BlockRecord[], path: readonly number[], depth: number): void => {
    for (const block of blocks) {
      for (const step of block.steps) {
        const at = [...path, step.id];
        stops.push({ statement, depth, kind: 'step', path: at });
        blocksOf(step.blocks, at, depth + 1);
        framesOf(step.frames, at, depth + 1);
      }
    }
  };
  const framesOf = (frames: readonly FrameRecord[], path: readonly number[], depth: number): void => {
    for (const frame of frames) stagesOf(frame, [...path, frame.id], depth);
  };
  for (const frame of recording.frames) stagesOf(frame, [frame.id], 1);
  return stops;
}

/**
 * Whether a record's ranges are in the statement's own text. A function defined in the schema reports ranges in the
 * text that defined it, not the program's, so it and everything inside it has no place in the program's file: the
 * stack shows it without a position, and no line breakpoint stops in it. A function the statement defines itself
 * (`with fun …`) is placed as any other record is.
 */
export function placedIn(path: readonly number[], index: Map<number, IndexedRecord>, text: string): boolean {
  return path.every((id) => {
    const entry = index.get(id);
    if (entry?.kind !== 'frame' || entry.record.kind !== 'function') return true;
    const range = entry.record.range;
    if (range === undefined) return false;
    const lines = text.split('\n');
    const from = lines[range.start.line]?.slice(range.start.character) ?? '';
    return new RegExp(`^fun\\s+${entry.record.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(from);
  });
}

/** The record a stop is at: the last of its path. */
export function recordAt(stop: Stop, index: Map<number, IndexedRecord>): IndexedRecord | undefined {
  const id = stop.path[stop.path.length - 1];
  return id === undefined ? undefined : index.get(id);
}
