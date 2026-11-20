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
export declare function installedRuntimeEntry(fromDirectory: string): string;
//# sourceMappingURL=installed-runtime-entry.d.ts.map