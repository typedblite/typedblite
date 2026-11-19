import type { RecordedRow, RecordedThing, RecordedValue, Recording, ScopeVariable, StageRecord } from './wire.js';

/**
 * A line of the Variables view: a name, a value, and what it opens to. Pure, so what a person sees at a stop is
 * specified without a client; the adapter turns these into DAP variables.
 */
export interface VariableNode {
  readonly name: string;
  readonly value: string;
  /** What it opens to. Absent for a leaf. */
  readonly children?: () => readonly VariableNode[];
  /** How many children it has, when they are many and paged: a row set. */
  readonly indexed?: number;
}

/** A value as a person writes it: text quoted, everything else as it is. */
function literal(valueType: string, value: string): string {
  return valueType === 'string' ? JSON.stringify(value) : value;
}

/** A thing, as its line in a row: its type and iid; it opens to its attributes as they were when it was recorded. */
export function thingNode(name: string, thing: RecordedThing | undefined, iid: string): VariableNode {
  if (thing === undefined || thing.type === '') return { name, value: `(no longer exists) ${iid}` };
  return {
    name,
    value: `${thing.type} ${thing.iid}`,
    children: () => [
      { name: 'type', value: thing.type },
      { name: 'iid', value: thing.iid },
      ...thing.attributes.map((attribute, i): VariableNode => ({
        // Several values of one attribute type each get their own line.
        name: thing.attributes.filter((a) => a.type === attribute.type).length > 1 ? `${attribute.type}[${thing.attributes.slice(0, i).filter((a) => a.type === attribute.type).length}]` : attribute.type,
        value: JSON.stringify(attribute.value),
      })),
    ],
  };
}

/** One binding of a row. */
export function valueNode(name: string, value: RecordedValue, things: Recording['things']): VariableNode {
  switch (value.kind) {
    case 'thing':
      return thingNode(name, things[value.ref], value.iid);
    case 'type':
      return { name, value: value.label };
    case 'attribute':
      return { name, value: `${value.type} ${literal(value.valueType, value.value)}` };
    case 'value':
      return { name, value: literal(value.valueType, value.value) };
    case 'empty':
      return { name, value: '(empty: the try did not match)' };
  }
}

/** One row: its bindings, summarised on one line, and opening to each. */
export function rowNode(name: string, row: RecordedRow, things: Recording['things']): VariableNode {
  const bindings = Object.entries(row).map(([variable, value]) => valueNode(variable, value, things));
  return {
    name,
    value: `{ ${bindings.map((binding) => `${binding.name}: ${binding.value}`).join(', ')} }`,
    children: () => bindings,
  };
}

/** A set of rows, paged: a row per child, and a line for the rows the recording left out. */
export function rowsNode(name: string, rows: readonly RecordedRow[], dropped: number, total: number, recording: Recording): VariableNode {
  const why = recording.rowsOmitted ? 'the recording passed its size limit, so it kept counts only' : `a step keeps ${recording.limits.rowsPerStep}`;
  const notKept: VariableNode[] = dropped === 0 ? [] : [{ name: '…', value: `${dropped} more, not recorded: ${why}` }];
  return {
    name,
    value: `${total} row(s)`,
    indexed: rows.length + notKept.length,
    children: () => [...rows.map((row, i) => rowNode(String(i + 1), row, recording.things)), ...notKept],
  };
}

/** What a stage leaves bound, from the query and the schema alone: each variable's kind and value type. */
export function scopeNodes(scope: readonly ScopeVariable[]): VariableNode[] {
  return scope.map((variable) => ({
    name: variable.name,
    value: [variable.kind ?? 'unknown', variable.valueType, variable.optional ? 'may be empty' : undefined].filter(Boolean).join(', '),
  }));
}

/** A stage's counts. */
export function stageNodes(stage: StageRecord): VariableNode[] {
  return [
    { name: 'stage', value: stage.kind },
    { name: 'rows in', value: String(stage.rowsIn) },
    { name: 'rows out', value: String(stage.rowsOut) },
    ...(stage.writes ? [{ name: 'writes', value: 'yes: the rows after it are described after the write' }] : []),
  ];
}
