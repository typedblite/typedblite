import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { installedRuntimeEntry } from '../src/installed-runtime-entry.js';

describe('installedRuntimeEntry', () => {
  let root: string;
  const put = (path: string, text: string): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  // The package as typedblite ships it: ESM, with only a `default` condition in its exports map.
  const installRuntime = (at: string): void => {
    put(`${at}/package.json`, JSON.stringify({ name: '@typedblite/runtime', version: '0.0.1', type: 'module', main: './out/index.js', exports: { '.': { types: './out/index.d.ts', default: './out/index.js' } } }));
    put(`${at}/out/index.js`, 'export const SqliteEngine = class {};\n');
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'runtime-entry-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('finds the copy npm hoisted beside the installed package, not one vendored inside it', () => {
    // <prefix>/node_modules/@example/app/main.js with @typedblite/runtime a sibling under node_modules
    installRuntime('prefix/node_modules/@typedblite/runtime');
    put('prefix/node_modules/@example/app/main.js', '');
    expect(installedRuntimeEntry(join(root, 'prefix/node_modules/@example/app'))).toBe(
      join(root, 'prefix/node_modules/@typedblite/runtime/out/index.js'),
    );
  });

  it('finds a copy nested under the installed package, which is where npm puts it when versions conflict', () => {
    installRuntime('prefix/node_modules/@example/app/node_modules/@typedblite/runtime');
    expect(installedRuntimeEntry(join(root, 'prefix/node_modules/@example/app'))).toBe(
      join(root, 'prefix/node_modules/@example/app/node_modules/@typedblite/runtime/out/index.js'),
    );
  });

  it('prefers the nearer copy', () => {
    installRuntime('prefix/node_modules/@typedblite/runtime');
    installRuntime('prefix/node_modules/@example/app/node_modules/@typedblite/runtime');
    expect(installedRuntimeEntry(join(root, 'prefix/node_modules/@example/app'))).toContain('@example/app/node_modules/@typedblite/runtime');
  });

  it('refuses when no copy is reachable, naming the directory it looked from', () => {
    put('lonely/main.js', '');
    expect(() => installedRuntimeEntry(join(root, 'lonely'))).toThrow(/@typedblite\/runtime.*is not installed.*lonely/);
  });
});
