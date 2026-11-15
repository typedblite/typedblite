/**
 * `Object.groupBy`, which the runtime's parser (Chevrotain, through Langium) calls. Chromium has it from
 * 117, Firefox from 119, Safari from 17.4. TypeDBLite documents the floor and does not patch globals
 * (ADR-009 D6): an application that targets older browsers adds this, as the sync demo does for its
 * Android app. Imported first in the worker, before the runtime.
 */
const objectWithGroupBy = Object as unknown as { groupBy?: unknown };
if (typeof objectWithGroupBy.groupBy !== 'function') {
  objectWithGroupBy.groupBy = <T, K extends PropertyKey>(items: Iterable<T>, key: (item: T, index: number) => K): Partial<Record<K, T[]>> => {
    const groups = Object.create(null) as Partial<Record<K, T[]>>;
    let index = 0;
    for (const item of items) {
      const group = key(item, index++);
      (groups[group] ??= []).push(item);
    }
    return groups;
  };
}
export {};
