import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * @internal The directory of a module, from its CommonJS `__dirname` (read through `readDirname`) or, failing that,
 * its `import.meta.url`.
 *
 * @privateRemarks
 * 🔴 **`__dirname` first, when there is one.** A bundler that inlines the module into a CommonJS bundle provides the
 * bundle's directory there, which is where the installed engine is found; it also rewrites `import.meta.url` to the
 * path of the source it bundled from (a build machine's path) or to nothing. Natively, as ESM, there is no
 * `__dirname`, and reading it throws a `ReferenceError`.
 *
 * 🔴 **A thunk, not a value, so the choice lives here and is unit tested.** The caller's only job is
 * `() => __dirname`; reading it inside a `try` is what makes the ESM case safe, and both arms can be exercised
 * without building a bundle.
 */
export function moduleDirectoryFrom(readDirname: () => unknown, moduleUrl: string | undefined): string {
  let commonJsDirname: unknown;
  try {
    commonJsDirname = readDirname();
  } catch {
    commonJsDirname = undefined;
  }
  if (typeof commonJsDirname === 'string' && commonJsDirname !== '') return commonJsDirname;
  if (typeof moduleUrl === 'string' && moduleUrl !== '') return dirname(fileURLToPath(moduleUrl));
  throw new Error('Cannot tell where this module is installed: it has neither a __dirname nor an import.meta.url');
}
