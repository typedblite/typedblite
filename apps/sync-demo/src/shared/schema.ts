import { TypeDBLiteValue, type TypeDBLiteInterpreter } from '@typedblite/runtime';

/**
 * The demo's one type: a task. `task-id` is its `@key`, which is what makes a task replicable — its
 * identity on every device is `task/<task-id>`, never the store's local iid (ADR-003, amendment 10).
 */
export const SCHEMA = `
  define
    entity task, owns task-id @key, owns title, owns done, owns created-at, owns origin, owns edited-by;
    attribute task-id, value string;
    attribute title, value string;
    attribute done, value boolean;
    attribute created-at, value string;
    attribute origin, value string;
    attribute edited-by, value string;
`;

export interface Task {
  readonly id: string;
  readonly title: string;
  readonly done: boolean;
  readonly createdAt: string;
  /** The device that created it. */
  readonly origin: string;
  /**
   * The device that made the latest change to it: the one that added it, or the last to check or uncheck it. It is
   * written in the same transaction as the change, so it replicates with it. A task from before this was recorded
   * reads as made by the device that created it.
   */
  readonly editedBy: string;
}

/** Every task in `db`, oldest first. */
export function readTasks(db: TypeDBLiteInterpreter): Task[] {
  const { rows } = db.query(`
    match $t isa task, has task-id $id, has title $title, has done $done, has created-at $at, has origin $origin;
    try { $t has edited-by $by; };
    select $id, $title, $done, $at, $origin, $by;
    sort $at, $id;
  `);
  return rows.map((row) => ({
    id: row['id'].asString(),
    title: row['title'].asString(),
    done: row['done'].asString() === 'true',
    createdAt: row['at'].asString(),
    origin: row['origin'].asString(),
    // Absent on a task from before the attribute existed (`try` leaves the column empty): its maker made it last.
    editedBy: row['by']?.asString() ?? row['origin'].asString(),
  }));
}

/** A string `given` cell. User text reaches the engine only this way, never interpolated. */
export const text = (value: string): TypeDBLiteValue => TypeDBLiteValue.value('string', value);
export const flag = (value: boolean): TypeDBLiteValue => TypeDBLiteValue.value('boolean', String(value));
