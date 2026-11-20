import { createRequire } from 'node:module';
import { join } from 'node:path';

/**
 * Where the installed `@typedblite/runtime` is, resolved the way Node resolves any package from a running file: up
 * the `node_modules` chain from `fromDirectory`.
 *
 * This is the fallback of `loadTypeDbLiteRuntime` for a CommonJS bundle that cannot `import()` the ESM-only runtime
 * directly. The runtime is an ordinary dependency, hoisted beside the installed package or nested under it, so a
 * fixed path under the bundle would find neither.
 *
 * @param fromDirectory the reading module's directory (a CommonJS bundle's `__dirname`).
 * @returns the absolute path of the runtime's entry file.
 * @throws when no copy is reachable, naming the directory it looked from.
 *
 * @privateRemarks
 * `createRequire(...).resolve` is used, not `import.meta.resolve`, because it resolves from any directory, and
 * `import.meta.resolve` only from this module's. The runtime's exports map names a `default` condition, which
 * `require.resolve` accepts.
 */
export function installedRuntimeEntry(fromDirectory: string): string {
  // Not named `require`: a bundler reads a local called that as the module system's own.
  const resolver = createRequire(join(fromDirectory, 'noop.js'));
  try {
    return resolver.resolve('@typedblite/runtime');
  } catch (error) {
    throw new Error(
      `@typedblite/runtime is not installed where ${fromDirectory} can resolve it: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}. ` +
        'It is a dependency of the package that holds this file; reinstall that package from a registry that has it.',
    );
  }
}
