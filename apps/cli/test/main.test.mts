import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main } from '../src/main';

/**
 * The CLI's argument handling, in process.
 *
 * 🔴 **`--help` exits 0 and no arguments exits 0, but an *unrecognised* invocation exits 1.** That
 * asymmetry is the contract for anything scripted: printing help because the user asked is success,
 * printing it because nothing matched is not, and collapsing the two makes a typo look like a
 * working command.
 */
describe('typedblite main', () => {
  it('prints help and exits 0 when asked', async () => {
    expect(await main(['--help'])).toBe(0);
    expect(await main(['-h'])).toBe(0);
  });

  it('prints help and exits 0 for no arguments at all', async () => {
    expect(await main([])).toBe(0);
  });

  it('exits 1 for an invocation it does not recognise', async () => {
    expect(await main(['--wat'])).toBe(1);
  });

  it('executes a statement against an in-memory database', async () => {
    expect(await main(['--exec', 'define entity thing;'])).toBe(0);
  });

  it('reports a bad statement with a non-zero exit code', async () => {
    expect(await main(['--exec', 'this is not typeqlite'])).not.toBe(0);
  });

  it('runs a file of statements', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'typedblite-cli-'));
    const file = join(dir, 'schema.typeqlite');
    writeFileSync(file, 'define entity thing;\ndefine entity other;\n', 'utf8');

    try {
      expect(await main(['--file', file])).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('defaults to an in-memory database when none is named', async () => {
    // No `--database`, so nothing is written to disk — the default that makes `--exec` safe to
    // run anywhere.
    expect(await main(['--exec', 'define entity thing;'])).toBe(0);
  });
});
