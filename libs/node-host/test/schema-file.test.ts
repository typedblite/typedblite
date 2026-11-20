import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readSchemaFile } from '../src/schema-file.js';

describe('readSchemaFile', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'node-host-schema-file-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('reads the asset beside the reading module', () => {
    writeFileSync(join(root, 'store.schema.typeqlite'), 'define entity thing;');

    expect(readSchemaFile(root, 'store.schema.typeqlite')).toBe('define entity thing;');
  });

  it('reads the asset one directory up, for a build that emits one level deeper', () => {
    mkdirSync(join(root, 'lib'));
    writeFileSync(join(root, 'store.schema.typeqlite'), 'define entity up;');

    expect(readSchemaFile(join(root, 'lib'), 'store.schema.typeqlite')).toBe('define entity up;');
  });

  it('prefers the copy beside the module to the one above it', () => {
    mkdirSync(join(root, 'lib'));
    writeFileSync(join(root, 'store.schema.typeqlite'), 'define entity up;');
    writeFileSync(join(root, 'lib', 'store.schema.typeqlite'), 'define entity beside;');

    expect(readSchemaFile(join(root, 'lib'), 'store.schema.typeqlite')).toBe('define entity beside;');
  });

  it('🔴 never falls back to the working directory', () => {
    // The process's cwd holds a copy; the module's directory does not. Finding it would hide a missing asset.
    const cwd = process.cwd();
    const elsewhere = join(root, 'cwd');
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, 'store.schema.typeqlite'), 'define entity wrong;');
    mkdirSync(join(root, 'module', 'lib'), { recursive: true });
    process.chdir(elsewhere);
    try {
      expect(() => readSchemaFile(join(root, 'module', 'lib'), 'store.schema.typeqlite')).toThrow(/missing from the package/);
    } finally {
      process.chdir(cwd);
    }
  });

  it('names the asset, calls it a build defect, and lists both places it looked', () => {
    const from = join(root, 'lib');

    let message = '';
    try {
      readSchemaFile(from, 'absent.schema.typeqlite');
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message.split('\n')[0]).toBe('Could not read absent.schema.typeqlite — it is missing from the package.');
    expect(message).toContain('build defect');
    expect(message).toContain(join(from, 'absent.schema.typeqlite'));
    expect(message).toContain(join(root, 'absent.schema.typeqlite'));
  });
});
