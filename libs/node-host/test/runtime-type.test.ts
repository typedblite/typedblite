import * as runtime from '@typedblite/runtime';
import { describe, expect, it } from 'vitest';

import type { TypeDbLiteRuntime } from '../src/index.js';

type Declared = TypeDbLiteRuntime;
/** The runtime's own change-log type, which `TypeDbLiteRuntime` deliberately widens to `unknown` for hosts. */
type ChangeLog = ConstructorParameters<typeof runtime.TypeDBLiteReplicator>[0];
type Rest<T extends readonly unknown[]> = T extends readonly [unknown, ...infer R] ? R : never;

/**
 * `loadTypeDbLiteRuntime` casts the module it loads to `TypeDbLiteRuntime`, so nothing at run time compares the two.
 * These assignments are that comparison: if the runtime renames, removes or changes anything the shape promises, the
 * file stops compiling and `typecheck` fails. The one difference allowed is the change log, which the shape takes
 * as `unknown` so a host can pass the opaque value its store registry gives it; it is put back to the runtime's
 * `ChangeLog` here, and every other parameter, option and result must match.
 */
describe('TypeDbLiteRuntime', () => {
  it('is satisfied by the real runtime module, apart from the widened change log, checked by the compiler', () => {
    const engine: Declared['SqliteEngine'] = runtime.SqliteEngine;
    const replicator: new (
      log: ChangeLog,
      ...rest: Rest<ConstructorParameters<Declared['TypeDBLiteReplicator']>>
    ) => InstanceType<Declared['TypeDBLiteReplicator']> = runtime.TypeDBLiteReplicator;
    const handler: (
      log: ChangeLog,
      ...rest: Rest<Parameters<Declared['createChangeStreamHandler']>>
    ) => ReturnType<Declared['createChangeStreamHandler']> = runtime.createChangeStreamHandler;

    expect(engine).toBe(runtime.SqliteEngine);
    expect(replicator).toBe(runtime.TypeDBLiteReplicator);
    expect(handler).toBe(runtime.createChangeStreamHandler);
  });
});
