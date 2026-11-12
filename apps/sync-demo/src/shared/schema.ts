import { TypeDBLiteValue, type TypeDBLiteInterpreter } from '@typedblite/runtime';

/**
 * The demo's one type: a task. `task-id` is its `@key`, which is what makes a task replicable — its
 * identity on every device is `task/<task-id>`, never the store's local iid (ADR-003, amendment 10).
 */
export const SCHEMA = `
  define
    entity task, owns task-id @key, owns title, owns done, owns created-at, owns origin;
    attribute task-id, value string;
    attribute title, value string;
    attribute done, value boolean;
    attribute created-at, value string;
    attribute origin, value string;
`;

export interface Task {
  readonly id: string;
  readonly title: string;
  readonly done: boolean;
  readonly createdAt: string;
  /** The device that created it. */
  readonly origin: string;
}

/** Every task in `db`, oldest first. */
export function readTasks(db: TypeDBLiteInterpreter): Task[] {
  const { rows } = db.query(`
    match $t isa task, has task-id $id, has title $title, has done $done, has created-at $at, has origin $origin;
    select $id, $title, $done, $at, $origin;
    sort $at, $id;
  `);
  return rows.map((row) => ({
    id: row['id'].asString(),
    title: row['title'].asString(),
    done: row['done'].asString() === 'true',
    createdAt: row['at'].asString(),
    origin: row['origin'].asString(),
  }));
}

/** A string `given` cell. User text reaches the engine only this way, never interpolated. */
export const text = (value: string): TypeDBLiteValue => TypeDBLiteValue.value('string', value);
export const flag = (value: boolean): TypeDBLiteValue => TypeDBLiteValue.value('boolean', String(value));
