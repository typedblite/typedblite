import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * A deviation's `owner` must resolve (TypeDBLite Conformance Standard): an ADR that exists in the
 * index, or a defect record. An owner that does not resolve makes the deviation a fail.
 *
 * ⚠️ Defect records live in `.mvp/defects/defects.db`, which is machine-local and gitignored. Where
 * the store is present a `d-` owner must be a record in it; where it is absent — CI — a `d-` owner
 * is accepted on its format alone, and the report says so. That is the third outcome named rather
 * than hidden. The store is a TypeDBLite file, read here through its `attr` table read-only rather
 * than by spawning the defects CLI from a test.
 */
export interface OwnerCheck {
  readonly resolves: (owner: string) => boolean;
  readonly caveat: string | undefined;
}

/**
 * The record ids in the store, or `undefined` when the file is there and could not be read —
 * zero bytes from an interrupted first run, a database `define` never reached (no `attr` table),
 * or a store busy under a `defect.*` write. ⚠️ The catch is that wide on purpose: every one of
 * those is the same third outcome as an absent store, not a crash before any scenario runs. The
 * run degrades to "accepted on format alone", and the caveat says the store was present.
 */
const defectIds = (storePath: string): ReadonlySet<string> | undefined => {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(storePath, { readOnly: true });
  } catch {
    return undefined;
  }
  try {
    const rows = db.prepare("SELECT value FROM attr WHERE type = 'defect-id'").all() as { value: string }[];
    return new Set(rows.map((r) => String(r.value)));
  } catch {
    return undefined;
  } finally {
    db.close();
  }
};

export const ownerCheck = (repositoryRoot: string): OwnerCheck => {
  const adrs = new Set(
    readdirSync(join(repositoryRoot, 'docs', 'architecture'))
      .map((name) => /^adr-(\d{3})-/.exec(name)?.[1])
      .filter((n): n is string => n !== undefined),
  );
  const storePath = join(repositoryRoot, '.mvp', 'defects', 'defects.db');
  const present = existsSync(storePath);
  const defects = present ? defectIds(storePath) : undefined;
  return {
    resolves: (owner) => {
      const adr = /^adr-(\d{3})$/.exec(owner);
      if (adr) return adrs.has(adr[1]);
      if (!/^d-\d{8}-[a-z0-9-]+$/.test(owner)) return false;
      return defects === undefined ? true : defects.has(owner);
    },
    caveat:
      defects === undefined
        ? present
          ? 'the defect store on this machine is present and could not be read (empty, no schema yet, or busy): d-… owners accepted on format alone'
          : 'no defect store on this machine: d-… owners accepted on format alone'
        : undefined,
  };
};
