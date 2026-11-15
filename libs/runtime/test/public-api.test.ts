/**
 * The runtime's public API, pinned: every value its entry points export, by name.
 *
 * 🔴 What the entry points export is covered by semver (docs/guides/compatibility.md), so adding or removing one
 * is a decision, not a side effect. When this fails, check the change is meant, update the list, and say so in
 * the changelog. Types are not values and are not listed here: `npm run check-api` checks that every type the
 * API mentions is exported.
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import * as browser from '../src/index.browser.js';
import * as node from '../src/index.js';
import * as wasm from '../src/wasm.js';

const BROWSER = [
  'ChangeStreamClient',
  'DIAGNOSTIC_SOURCE',
  'DiagnosticCode',
  'FullTextIndex',
  'MAX_DIAGNOSTICS',
  'SqliteEngine',
  'TypeDBLiteInterpreter',
  'TypeDBLiteReplicator',
  'TypeDBLiteValue',
  'WHOLE_DOCUMENT',
  'attachDiagnostic', // @internal: the conformance suite's
  'canonicalTemporal', // @internal: the conformance suite's
  'diagnosticOf',
  'entityId',
  'instantOf', // @internal: the conformance suite's
  'isReplicable',
  'replicateOnce',
];

describe('the public API', () => {
  it('is exactly this, under the browser condition', () => {
    assert.deepEqual(Object.keys(browser).sort(), [...BROWSER].sort());
  });

  it('is that plus the hub and the node:sqlite binding, on Node', () => {
    assert.deepEqual(Object.keys(node).sort(), [...BROWSER, 'createChangeStreamHandler', 'openNodeSqlite', 'serveChangeStream'].sort());
  });

  it('is the binding and the OPFS pool, from @typedblite/runtime/wasm', () => {
    assert.deepEqual(Object.keys(wasm).sort(), ['initWasmSqlite', 'openWasmSqlite', 'poolInfo', 'wipeOpfsPool']);
  });
});
