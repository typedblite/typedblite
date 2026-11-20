import { describe, expect, it } from 'vitest';

import * as nodeHost from '../src/index.js';

/**
 * The values the entry point exports. A host switches its imports to this package name for name, so adding or
 * removing one is a decision: update this list, and the changelog.
 */
describe('the entry point', () => {
  it('exports exactly these values', () => {
    expect(Object.keys(nodeHost).sort()).toEqual(
      [
        'TransactionsNotSupportedError',
        'TypeDBLiteDatabase',
        'TypeQLiteValueError',
        'createSqliteEngine',
        'escapeTypeQLite',
        'installedRuntimeEntry',
        'isUniqueConstraintViolation',
        'loadTypeDbLiteRuntime',
        'openSchemaDatabase',
        'readSchemaFile',
        'requiredRowNumber',
        'requiredRowString',
        'rowNumber',
        'rowString',
        'typeQLiteDatetime',
        'typeQLiteValue',
      ].sort(),
    );
  });
});
