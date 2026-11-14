import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The CLI runs however it is launched, not only as `node apps/cli/out/main.js` on a POSIX path.
 *
 * 🔴 The entry check once compared the script's FILE NAME, split on `/`, with the module's URL. That
 * name is never `main.js` when the CLI is launched through npm's `bin` link (`typedblite`), and on
 * Windows the path has no `/` to split on. Either way `main()` never ran, and the process exited 0
 * having printed nothing: the REPL tests saw empty output on the Windows CI runner.
 */
const MAIN = fileURLToPath(new URL('../out/main.js', import.meta.url));

describe('the CLI entry point', () => {
  it('runs when launched through a link with another name, as npm’s bin link launches it', (context) => {
    const dir = mkdtempSync(join(tmpdir(), 'typedblite-bin-'));
    const link = join(dir, 'typedblite');
    try {
      try {
        symlinkSync(MAIN, link);
      } catch (error) {
        // Windows refuses symlinks without Developer Mode or elevation; there, the REPL tests cover
        // the path check instead, since a Windows path has no `/` either.
        if ((error as NodeJS.ErrnoException).code === 'EPERM') return context.skip();
        throw error;
      }
      const run = spawnSync(process.execPath, [link, '--help'], { encoding: 'utf8', timeout: 20_000 });
      assert.match(run.stdout, /a shell for the TypeDBLite engine/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('starts with a shebang, so the bin link runs it with Node and not with the shell', () => {
    // Without it, a POSIX shell runs `import { createInterface } …` as a command: ImageMagick's
    // `import`, which waits for a click on the display. npm's Windows shim reads the line too.
    assert.equal(readFileSync(MAIN, 'utf8').split('\n')[0], '#!/usr/bin/env node');
  });
});
