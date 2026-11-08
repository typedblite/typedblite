import { afterEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TypeDBLiteInterpreter } from '@typedblite/runtime';
import { ownerCheck } from '../src/owners.js';

/**
 * A deviation's owner must resolve. An `adr-NNN` resolves against `docs/architecture`; a `d-…`
 * resolves against the defect store when one is present, and on format alone — with the caveat
 * printed — only when there is none. The first version accepted any well-formed `d-…` on every
 * machine and printed the caveat only where the store was absent: a deviation owned by a defect
 * that does not exist was a silent `deviation` here.
 */
let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

const repository = (withStore: boolean): string => {
  root = mkdtempSync(join(tmpdir(), 'conformance-owners-'));
  mkdirSync(join(root, 'docs', 'architecture'), { recursive: true });
  writeFileSync(join(root, 'docs', 'architecture', 'adr-002-something.md'), '# ADR-002');
  if (withStore) {
    mkdirSync(join(root, '.mvp', 'defects'), { recursive: true });
    const store = new TypeDBLiteInterpreter(join(root, '.mvp', 'defects', 'defects.db'));
    store.define('define attribute defect-id, value string; entity defect, owns defect-id @key;');
    store.execute('insert $d isa defect, has defect-id "d-20260911-a-real-one";');
    store.close();
  }
  return root;
};

describe('owner resolution', () => {
  it('resolves an ADR against the index, and refuses one that is not there', () => {
    const check = ownerCheck(repository(false));
    assert.equal(check.resolves('adr-002'), true);
    assert.equal(check.resolves('adr-999'), false);
    assert.equal(check.resolves('nonsense'), false);
  });

  it('with a defect store, a d- owner resolves only if the record exists', () => {
    const check = ownerCheck(repository(true));
    assert.equal(check.caveat, undefined);
    assert.equal(check.resolves('d-20260911-a-real-one'), true);
    assert.equal(check.resolves('d-20260911-never-opened'), false);
  });

  it('with a store file that is not yet a store — zero bytes, or no schema — the run degrades, and says which', () => {
    // An interrupted first run leaves the file; a `define` never reached leaves no `attr` table.
    // Either used to throw before a single scenario ran. Both are the third outcome, with a caveat
    // that names this case rather than claiming there is no store.
    const emptyRoot = repository(false);
    mkdirSync(join(emptyRoot, '.mvp', 'defects'), { recursive: true });
    writeFileSync(join(emptyRoot, '.mvp', 'defects', 'defects.db'), '');
    const empty = ownerCheck(emptyRoot);
    assert.match(empty.caveat ?? '', /present and could not be read/);
    assert.equal(empty.resolves('d-20260911-never-opened'), true);

    rmSync(emptyRoot, { recursive: true, force: true });
    const schemalessRoot = repository(false);
    mkdirSync(join(schemalessRoot, '.mvp', 'defects'), { recursive: true });
    new TypeDBLiteInterpreter(join(schemalessRoot, '.mvp', 'defects', 'defects.db')).close();
    const schemaless = ownerCheck(schemalessRoot);
    assert.match(schemaless.caveat ?? '', /present and could not be read/);
    assert.equal(schemaless.resolves('d-20260911-never-opened'), true);
  });

  it('without a defect store, a d- owner resolves on format alone and the caveat says so', () => {
    const check = ownerCheck(repository(false));
    assert.match(check.caveat ?? '', /format alone/);
    assert.equal(check.resolves('d-20260911-never-opened'), true);
    assert.equal(check.resolves('d-bad'), false);
  });
});
