/**
 * Where a debug session can stop, in order: a walk of the program, statement by statement. Pure, so every stepping
 * rule is specified without a host or a client.
 *
 * Before a statement has run, the timeline holds one stop for it. Running it, which every forward move past that
 * stop must do so that the next statement sees what it wrote, puts the stops inside it after it (ADR-014 B1). A
 * statement runs once: moving back reads what was recorded.
 *
 * Depth is what stepping reads: 0 for a statement, 1 for a stage, more for what a stage holds. Over goes to the next
 * stop no deeper than this one, in to the very next stop, out to the next stop shallower than this one.
 */
export type StopKind = 'statement' | 'stage' | 'step' | 'end';

export interface Stop {
  /** The statement's index in the program; the end's is the number of statements. */
  readonly statement: number;
  readonly depth: number;
  readonly kind: StopKind;
  /** The ids of the records from the statement's frame down to this stop's own; empty for a statement or the end. */
  readonly path: readonly number[];
}

/** How a forward move chooses where to stop. */
export type Motion = 'over' | 'in' | 'out' | 'continue';

export class Timeline {
  private readonly stops: Stop[];
  private readonly expanded = new Set<number>();
  private position = 0;

  constructor(readonly statements: number) {
    this.stops = Array.from({ length: statements }, (_, statement): Stop => ({ statement, depth: 0, kind: 'statement', path: [] }));
    this.stops.push({ statement: statements, depth: 0, kind: 'end', path: [] });
  }

  get current(): Stop {
    return this.stops[this.position]!;
  }

  get index(): number {
    return this.position;
  }

  at(index: number): Stop | undefined {
    return this.stops[index];
  }

  moveTo(index: number): void {
    if (index < 0 || index >= this.stops.length) throw new RangeError(`No stop ${index}.`);
    this.position = index;
  }

  /** Whether a statement's own stops are in: it has run. */
  isExpanded(statement: number): boolean {
    return this.expanded.has(statement);
  }

  /** Put a statement's inner stops after its own stop. Once only: a statement runs once. */
  expand(statement: number, inner: readonly Stop[]): void {
    if (this.expanded.has(statement)) throw new Error(`Statement ${statement} has already run.`);
    this.expanded.add(statement);
    const at = this.stops.findIndex((stop) => stop.kind === 'statement' && stop.statement === statement);
    this.stops.splice(at + 1, 0, ...inner);
  }

  /** The index of the stop of a statement. */
  statementIndex(statement: number): number {
    return this.stops.findIndex((stop) => (stop.kind === 'statement' || stop.kind === 'end') && stop.statement === statement);
  }
}

/** Whether a forward move that began at `from` stops at `to`, before breakpoints are asked. */
export function accepts(motion: Motion, from: Stop, to: Stop): boolean {
  if (to.kind === 'end') return true;
  switch (motion) {
    case 'in':
      return true;
    case 'over':
      return to.depth <= from.depth;
    case 'out':
      // Out of a statement is to the next one: there is nothing shallower to go to.
      return from.depth === 0 ? to.depth === 0 : to.depth < from.depth;
    case 'continue':
      return false;
  }
}
