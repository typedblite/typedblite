import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * The REPL, driven as a real process over stdin.
 *
 * 🔴 Deliberately not refactored into something easier to test. The interactive loop *is* the
 * thing — line buffering across a multi-line pipeline, meta-commands, and surviving an error are
 * behaviours of the loop, not of anything underneath it. Extracting a "testable core" would leave
 * exactly the part that can break untested, which is how Phase 02 shipped an atomicity test that
 * could not fail.
 */

const MAIN = fileURLToPath(new URL('../out/main.js', import.meta.url));

/** Feed lines to a REPL and collect everything it wrote. */
function repl(lines: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MAIN, '--repl'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += String(chunk)));
    child.stderr.on('data', (chunk) => (output += String(chunk)));
    child.on('error', reject);
    child.on('close', () => resolve(output));
    child.stdin.write(lines.join('\n') + '\n');
    child.stdin.end();
  });
}

const SCHEMA =
  'define attribute project-id, value string; attribute project-name, value string; entity project, owns project-id @key, owns project-name;';

describe('the REPL', () => {
  it('applies a schema, writes and reads back', async () => {
    const output = await repl([
      SCHEMA,
      'insert $s isa project, has project-id "website-relaunch", has project-name "Website relaunch";',
      'match $s isa project, has project-id "website-relaunch", has project-name $n;',
      'select $n;',
      '.exit',
    ]);
    assert.match(output, /schema applied/);
    assert.match(output, /n=Website relaunch/);
    assert.match(output, /\(1 row\)/);
  });

  // The behaviour that makes the loop non-trivial: a pipeline spans lines, so `match …;` alone
  // must NOT be executed — it binds and projects nothing.
  //
  // ⚠️ This projected `$s` — the *entity* — until 2026-09-10, and had to change because `select`
  // now refuses a thing variable. It is only the projection that changed: the case was already
  // discriminating, because `Pipeline` makes `match` mandatory, so a `select …;` reaching the
  // engine on its own is a **parse** error and trips the same `doesNotMatch(/error/i)`.
  it('waits for the rest of a pipeline instead of running a bare match', async () => {
    const output = await repl([
      SCHEMA,
      'insert $s isa project, has project-id "s", has project-name "n";',
      'match $s isa project, has project-id "s", has project-name $n;',
      'select $n;',
      '.exit',
    ]);
    assert.doesNotMatch(
      output,
      /error/i,
      'a bare `match …;` must not have been executed on its own',
    );
  });

  // 🔴 A REPL that exits on a typo is unusable.
  it('survives an error and keeps accepting input', async () => {
    const output = await repl([
      SCHEMA,
      'insert $x isa nonexistent-type;',
      'insert $s isa project, has project-id "after", has project-name "n";',
      'match $s isa project, has project-id "after", has project-name $n;',
      'select $n;',
      '.exit',
    ]);
    assert.match(output, /error:.*nonexistent-type/);
    assert.match(output, /n=n/, 'the session must still work after the error');
  });

  it('answers .schema honestly before and after a define', async () => {
    const before = await repl(['.schema', '.exit']);
    assert.match(before, /no schema applied/);
    const after = await repl([SCHEMA, '.schema', '.exit']);
    assert.match(after, /a schema has been applied/);
  });

  it('reports an unknown meta-command rather than trying to run it as TypeQLite', async () => {
    const output = await repl(['.nonsense', '.exit']);
    assert.match(output, /unknown command '\.nonsense'/);
  });

  it('says an in-memory session keeps nothing', async () => {
    const output = await repl(['.exit']);
    assert.match(output, /nothing is kept when this session ends/);
  });

  it('leaves cleanly on end-of-input, without .exit', async () => {
    const output = await repl([SCHEMA]);
    assert.match(output, /schema applied/);
  });
});
