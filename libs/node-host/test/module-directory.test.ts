import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { moduleDirectoryFrom } from '../src/module-directory.js';

const bundleDir = join('/', 'srv', 'app', 'dist');
const sourceUrl = pathToFileURL(join('/', 'build-machine', 'src', 'typedblite-database.js')).href;

describe('moduleDirectoryFrom', () => {
  it("prefers a CommonJS bundle's __dirname over the import.meta.url a bundler rewrote", () => {
    expect(moduleDirectoryFrom(() => bundleDir, sourceUrl)).toBe(bundleDir);
  });

  it('uses __dirname even when the bundler rewrote import.meta.url to nothing', () => {
    expect(moduleDirectoryFrom(() => bundleDir, undefined)).toBe(bundleDir);
    expect(moduleDirectoryFrom(() => bundleDir, '')).toBe(bundleDir);
  });

  it('falls back to import.meta.url natively as ESM, where reading __dirname throws a ReferenceError', () => {
    const esm = (): unknown => {
      throw new ReferenceError('__dirname is not defined in ES module scope');
    };

    expect(moduleDirectoryFrom(esm, sourceUrl)).toBe(join('/', 'build-machine', 'src'));
  });

  it('falls back to import.meta.url when __dirname is not a usable string', () => {
    for (const value of [undefined, '', 42]) {
      expect(moduleDirectoryFrom(() => value, sourceUrl)).toBe(join('/', 'build-machine', 'src'));
    }
  });

  it('says so when it has neither', () => {
    expect(() => moduleDirectoryFrom(() => undefined, undefined)).toThrow(/neither a __dirname nor an import\.meta\.url/);
  });
});
