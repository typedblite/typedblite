/**
 * ADR-009 D3 and D4: `@typedblite/runtime` has a browser entry point with nothing from Node in it.
 *
 * 🔴 The proof is a real browser bundle. esbuild with `platform: 'browser'` cannot resolve a `node:`
 * built-in, so a bundle that builds with no externals contains none. A re-export added to
 * `index.browser.ts` that reaches `node:sqlite`, `node:http` or `node:crypto`, however indirectly,
 * fails here rather than in someone's web app.
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

import * as browser from '../src/index.browser.js';
import * as node from '../src/index.js';
import { defaultOpener } from '../src/default-opener.js';

const SRC = (file: string): string => fileURLToPath(new URL(`../src/${file}`, import.meta.url));

describe('the browser entry point', () => {
  it('bundles for the browser with no Node built-in anywhere in its graph', async () => {
    const result = await build({
      entryPoints: [SRC('index.browser.ts')],
      bundle: true,
      platform: 'browser',
      format: 'esm',
      write: false,
      metafile: true,
      logLevel: 'silent',
      // `#default-opener` as the `default` condition selects it: the opener that refuses.
      plugins: [{ name: 'default-opener', setup: (b) => b.onResolve({ filter: /^#default-opener$/ }, () => ({ path: SRC('default-opener.ts') })) }],
    });
    const inputs = Object.keys(result.metafile.inputs);
    assert.deepEqual(inputs.filter((input) => input.startsWith('node:')), []);
    assert.ok(!inputs.some((input) => /node-sqlite|change-stream\.ts$/.test(input)), 'the Node binding and the SSE hub stay out');
    const text = new TextDecoder().decode(result.outputFiles[0]?.contents);
    for (const builtin of ['node:sqlite', 'node:http', 'node:crypto']) assert.ok(!text.includes(`"${builtin}"`), builtin);
  });

  it('has the spoke side of replication, and not the hub or the Node binding', () => {
    for (const name of ['TypeDBLiteInterpreter', 'TypeDBLiteReplicator', 'ChangeStreamClient', 'replicateOnce', 'FullTextIndex'])
      assert.ok(name in browser, name);
    for (const name of ['serveChangeStream', 'createChangeStreamHandler', 'openNodeSqlite'])
      assert.ok(!(name in browser), name);
  });

  it('is everything the Node entry has, less the Node-only modules', () => {
    const nodeOnly = new Set(['serveChangeStream', 'createChangeStreamHandler', 'openNodeSqlite']);
    assert.deepEqual(Object.keys(node).filter((name) => !nodeOnly.has(name)).sort(), Object.keys(browser).sort());
  });

  it('is what the package exports under the browser condition', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      exports: Record<string, Record<string, unknown>>;
      imports: Record<string, Record<string, string>>;
    };
    assert.deepEqual(manifest.exports['.']?.['browser'], { types: './out/index.browser.d.ts', default: './out/index.browser.js' });
    assert.equal(manifest.imports['#default-opener']?.['node'], './out/default-opener.node.js');
    assert.equal(manifest.imports['#default-opener']?.['default'], './out/default-opener.js');
  });
});

describe('the default opener outside Node', () => {
  it('refuses, and says what to pass instead', () => {
    assert.throws(() => defaultOpener(':memory:'), /openDatabase: openWasmSqlite.*@typedblite\/runtime\/wasm/);
  });
});
