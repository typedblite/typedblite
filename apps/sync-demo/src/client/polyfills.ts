/**
 * `Object.groupBy`, which the runtime's parser (Chevrotain, through Langium) calls. Chromium has it
 * from 117; Android 14's built-in WebView is Chromium 113. TypeDBLite documents the floor and does
 * not patch globals (ADR-009 D6) — an application targeting an older engine adds this, as the demo
 * does for its Android app. Imported first, before the runtime.
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
