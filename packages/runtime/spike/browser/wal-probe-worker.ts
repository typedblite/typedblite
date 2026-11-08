/* eslint-disable @typescript-eslint/no-explicit-any -- a probe: the sqlite-wasm typings do not cover the VFS installers */
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

/**
 * SPIKE — which SQLite WASM storage options accept `PRAGMA journal_mode=WAL`, and what each needs.
 * Reports facts only; `run-wal.mjs` runs it with and without cross-origin isolation.
 */
declare const self: {
  postMessage(m: unknown): void;
  crossOriginIsolated: boolean;
};
declare const SharedArrayBuffer: unknown;

const attempt = async (
  label: string,
  body: () => Promise<unknown> | unknown,
) => {
  try {
    return { label, ...((await body()) as object) };
  } catch (error) {
    return {
      label,
      error: `${(error as Error).name}: ${(error as Error).message}`
        .split('\n')[0]
        ?.slice(0, 160),
    };
  }
};

const walResult = (db: any) => {
  const before = db.selectValue('PRAGMA journal_mode');
  const asked = db.selectValue('PRAGMA journal_mode=WAL');
  return {
    journalModeBefore: before,
    afterAskingForWal: asked,
    walAccepted: String(asked).toLowerCase() === 'wal',
  };
};

const init = sqlite3InitModule as unknown as (o: object) => Promise<any>;
const sqlite3 = await init({
  print: () => undefined,
  printErr: () => undefined,
  locateFile: (f: string) => `/${f}`,
});

const facts = {
  crossOriginIsolated: self.crossOriginIsolated,
  sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
  atomicsWaitAsync: typeof (Atomics as any).waitAsync === 'function',
  sqlite3Opfs: !!sqlite3.opfs,
  installers: Object.keys(sqlite3).filter((k) => /opfs/i.test(k)),
};

const results = [];
results.push(
  await attempt('in-memory database', () => {
    const db = new sqlite3.oo1.DB(':memory:', 'c');
    const r = walResult(db);
    db.close();
    return r;
  }),
);
results.push(
  await attempt('OPFS SAH-pool VFS (what the spike uses)', async () => {
    const pool = await sqlite3.installOpfsSAHPoolVfs({
      name: 'wal-probe-sah',
      directory: '/wal-probe-sah',
      clearOnInit: true,
    });
    const db = new pool.OpfsSAHPoolDb('/wal-sah.db');
    const r = walResult(db);
    db.close();
    return r;
  }),
);
results.push(
  await attempt("OPFS 'opfs' VFS (async proxy)", () => {
    if (!sqlite3.oo1.OpfsDb)
      throw new Error(
        'oo1.OpfsDb is not available (needs cross-origin isolation)',
      );
    const db = new sqlite3.oo1.OpfsDb('/wal-opfs.db', 'c');
    const r = walResult(db);
    db.close();
    return r;
  }),
);
results.push(
  await attempt("OPFS 'opfs-wl' VFS (Web Locks)", async () => {
    // The module installs this VFS itself during init when the 'opfs' layer is present, so look it up by name.
    if (!sqlite3.capi.sqlite3_vfs_find('opfs-wl'))
      throw new Error("no VFS named 'opfs-wl' is registered");
    const db = new sqlite3.oo1.DB('/wal-wl.db', 'c', 'opfs-wl');
    const r = walResult(db);
    db.close();
    return r;
  }),
);

self.postMessage({ facts, results });
