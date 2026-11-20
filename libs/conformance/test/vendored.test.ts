import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SPEC_ROOT } from '../src/conformance.js';

/**
 * 🔴 The vendored spec is byte-identical to upstream at the pin — checked, not noted.
 *
 * `spec/MANIFEST` holds the git blob id of every vendored file as upstream's tree reports it at
 * the pinned commit. A blob id is `sha1("blob <length>\0" + content)`, so it is recomputable here
 * with no network and no git. An edited feature file — the standard forbids it — shows up as a
 * hash mismatch, and so does a pin move that forgot to re-vendor.
 */
const blobId = (content: Buffer): string =>
  createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');

describe('the vendored specification', () => {
  const manifest = readFileSync(join(SPEC_ROOT, 'MANIFEST'), 'utf8')
    .split('\n')
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.split(/\s+/) as [string, string]);

  it('lists every file the pin covers', () => {
    assert.ok(manifest.length >= 20, `manifest has ${manifest.length} entries`);
    assert.ok(manifest.some(([, path]) => path === 'LICENSE'), 'the MPL-2.0 license is vendored');
  });

  it('is byte-identical to upstream at the pinned commit', () => {
    const wrong = manifest
      .filter(([sha, path]) => blobId(readFileSync(join(SPEC_ROOT, path))) !== sha)
      .map(([, path]) => path);
    assert.deepEqual(wrong, [], 'these vendored files differ from upstream at the pin');
  });

  it('records the pin', () => {
    const pin = readFileSync(join(SPEC_ROOT, 'PIN'), 'utf8');
    assert.match(pin, /^commit: [0-9a-f]{40}$/m);
    assert.match(pin, /^surveyed-against: typedb\/typedb:\d+\.\d+\.\d+/m);
  });
});
