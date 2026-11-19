/**
 * `edited-by`: the device that made the latest change to a task, recorded in the same transaction as the change so that
 * it replicates with it. The in-browser demo's highlight takes its colour from it. These tests are the data's side of
 * that: who is recorded, when, and what an older store reads as. (`browser-hub-replication.test.ts` carries it between
 * devices.)
 */
import { describe, expect, it } from 'vitest';
import { TypeDBLiteInterpreter, TypeDBLiteValue } from '@typedblite/runtime';

import { DemoDevice } from '../src/shared/device.js';
import { SCHEMA, readTasks } from '../src/shared/schema.js';
import { newDevice, newStore } from './browser-hub-support.js';

const changes = (db: TypeDBLiteInterpreter): number => db.changeLog.since(0, 10_000).length;
const only = (device: DemoDevice) => device.tasks()[0]!;

describe('who is recorded', () => {
  it('records the device that added a task as both its maker and its latest editor', () => {
    const { device } = newDevice('a');
    device.addTask('Task 1');
    expect(only(device)).toMatchObject({ origin: 'a', editedBy: 'a' });
  });

  it('stores the editor on the add itself, and does not leave it to the fallback for a store from before', () => {
    const { device, db } = newDevice('a');
    device.addTask('Task 1');
    const stored = db.query('match $t isa task, has edited-by $by; select $by;').rows.map((row) => row['by']!.asString());
    expect(stored).toEqual(['a']);
  });

  it('records the device that checks a task, and the device that unchecks it, each as the latest editor', () => {
    const { device: a, db } = newDevice('a');
    a.addTask('Task 1');
    const id = only(a).id;
    // The same store, acted on as other devices would after a sync: the engine is the same.
    new DemoDevice('b', db, 'hub://hub').setDone(id, true);
    expect(only(a)).toMatchObject({ origin: 'a', done: true, editedBy: 'b' });
    new DemoDevice('c', db, 'hub://hub').setDone(id, false);
    expect(only(a)).toMatchObject({ origin: 'a', done: false, editedBy: 'c' });
  });

  it('keeps who made a task when someone else changes it, so the chip and the highlight can differ', () => {
    const { device: a, db } = newDevice('a');
    a.addTask('Task 1');
    new DemoDevice('b', db, 'hub://hub').setDone(only(a).id, true);
    expect(only(a).origin).toBe('a');
    expect(only(a).editedBy).toBe('b');
  });

  it('writes the change and its author as one revision, so they cannot be seen apart', () => {
    const { device, db } = newDevice('a');
    device.addTask('Task 1');
    const before = changes(db);
    device.setDone(only(device).id, true);
    expect(changes(db) - before).toBe(1);
    const latest = db.changeLog.since(0, 10_000).at(-1)!;
    expect(JSON.stringify(latest.state)).toContain('"a"');
  });

  it('keeps one device’s successive changes attributed to it', () => {
    const { device } = newDevice('a');
    device.addTask('Task 1');
    const id = only(device).id;
    for (const done of [true, false, true]) {
      device.setDone(id, done);
      expect(only(device)).toMatchObject({ done, editedBy: 'a' });
    }
  });
});

describe('a write that changes nothing is not made', () => {
  it('does not record an edit when a task is set to what it already is', () => {
    const { device, db } = newDevice('a');
    device.addTask('Task 1');
    const id = only(device).id;
    new DemoDevice('b', db, 'hub://hub').setDone(id, true);
    const before = changes(db);
    // C "checks" a task that is already checked: nothing changed, so C is not the latest editor of anything.
    new DemoDevice('c', db, 'hub://hub').setDone(id, true);
    expect(changes(db)).toBe(before);
    expect(only(device)).toMatchObject({ done: true, editedBy: 'b' });
  });

  it('still refuses a task that is not there', () => {
    const { device } = newDevice('a');
    expect(() => device.setDone('no-such-task', true)).toThrow(/No task 'no-such-task'/);
  });
});

describe('a store from before it was recorded', () => {
  const OLD_SCHEMA = `
    define
      entity task, owns task-id @key, owns title, owns done, owns created-at, owns origin;
      attribute task-id, value string;
      attribute title, value string;
      attribute done, value boolean;
      attribute created-at, value string;
      attribute origin, value string;
  `;
  const text = (value: string): TypeDBLiteValue => TypeDBLiteValue.value('string', value);

  function oldStore(): TypeDBLiteInterpreter {
    const db = new TypeDBLiteInterpreter(':memory:');
    db.define(OLD_SCHEMA);
    db.execute('given $id: string, $at: string; insert $t isa task, has task-id $id, has title "Old task", has done false, has created-at $at, has origin "a";', [{ id: text('old-1'), at: text('2026-01-01T00:00:00Z') }]);
    return db;
  }

  it('takes the new schema on opening, and keeps its tasks', () => {
    const db = oldStore();
    expect(() => db.define(SCHEMA)).not.toThrow();
    expect(readTasks(db)).toHaveLength(1);
  });

  it('reads an old task as last edited by the device that made it', () => {
    const db = oldStore();
    db.define(SCHEMA);
    expect(readTasks(db)[0]).toMatchObject({ title: 'Old task', origin: 'a', editedBy: 'a' });
  });

  it('records the editor on an old task the first time anyone changes it', () => {
    const db = oldStore();
    const device = new DemoDevice('c', db, 'hub://hub');
    device.setDone('old-1', true);
    expect(readTasks(db)[0]).toMatchObject({ origin: 'a', done: true, editedBy: 'c' });
  });

  it('takes the schema twice without harm, as every open does', () => {
    const db = newStore();
    expect(() => db.define(SCHEMA)).not.toThrow();
    expect(readTasks(db)).toEqual([]);
  });
});
