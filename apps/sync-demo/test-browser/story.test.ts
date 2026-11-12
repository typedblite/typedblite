/**
 * The whole story, as `nx run sync-demo:demo -- --headless --fresh --no-android` runs it: the PWA and
 * the Electron device through all nine steps, each passing only when every store and the hub agree.
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cleanEnvironment } from '../src/driver/environment.js';

const DRIVER = fileURLToPath(new URL('../out/driver/demo.js', import.meta.url));

describe('the story driver', () => {
  it('runs all nine steps to convergence, headless', () => {
    const data = mkdtempSync(join(tmpdir(), 'typedblite-sync-story-'));
    try {
      const run = spawnSync(process.execPath, [DRIVER, '--headless', '--fresh', '--no-android'], {
        encoding: 'utf8',
        env: { ...cleanEnvironment(), DEMO_PORT: '4391', HUB_PORT: '4392', DEMO_DATA: data },
        timeout: 240_000,
      });
      const output = `${run.stdout}\n${run.stderr}`;
      assert.equal(run.status, 0, output);
      assert.equal(output.match(/ {2}✓ /g)?.length, 9, output);
      assert.match(output, /The story is complete: every step converged/);
      assert.match(output, /the desktop: offline, 3 changes waiting to sync/);
    } finally {
      rmSync(data, { recursive: true, force: true });
    }
  }, 300_000);
});
