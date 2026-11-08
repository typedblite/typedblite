# @typedblite/content-revision

Canonical state encoding and CouchDB-style `generation-digest` revision identifiers for TypeDBLite.

This package is shared between the runtime's change log and any external consumer that needs the same revision semantics (e.g. a prompt versioning system).

## What this package provides

- **`computeRevision(input)`** — derives a deterministic `generation-digest` revision from content and parent.
- **`canonical(state)`** — length-prefixed canonical encoding of an entity's state; the input to the revision hash.
- **`generationOf(rev)`** / **`digestOf(rev)`** — parse the two parts of a revision string.

## Revision format

```
generation-digest
```

Example: `2-9f86d081884c7d659a2feaa0c55ad015`

- `generation` — an integer starting at 1, incremented by 1 for each revision of the entity.
- `digest` — first 32 hex characters of a SHA-256 hash over the canonical state, the parent revision, and the deleted flag, separated by `\0`.

The digest is **derived from content**, not randomised. The same edit applied to the same parent on two independent nodes produces the same revision string. Independent identical edits converge instead of manufacturing a conflict.

This is CouchDB's revision model (Decision 3 of ADR-003). Parity with CouchDB 3.4.3 was proven empirically and is guarded by the parity oracle (`nx run typedblite-runtime:test-oracle`).

## Usage

```ts
import { computeRevision, canonical, generationOf, digestOf } from '@typedblite/content-revision';

// First write
const rev1 = computeRevision({ state: { attributes: { name: 'Alice' } } });
// => '1-<32 hex chars>'

// Second write, building on the first
const rev2 = computeRevision({
  state: { attributes: { name: 'Alice', age: 30 } },
  parent: rev1,
});
// => '2-<32 hex chars>'

// Tombstone (deleted)
const tombstone = computeRevision({ deleted: true, parent: rev2 });
// => '3-<32 hex chars>'

generationOf(rev2); // => 2
digestOf(rev2);     // => '<32 hex chars>'
```

## Canonical encoding

`canonical(state)` produces a stable, length-prefixed byte string for the entity's key-value attributes. It is not a human-readable format — it exists solely to make the SHA-256 hash unforgeable: a crafted attribute value cannot shift the boundary between state and parent.

## Invariants

- **Do not change the revision algorithm** without running the parity oracle. The oracle is not part of the routine test suite (it requires a live CouchDB instance) and will not catch a regression automatically on CI.
- **The separator between state, parent, and deleted flag is `\0`** — it cannot appear in a revision string, so injection is structurally impossible.
- **`parent` absent → generation 1.** There is no generation 0.

## Tests

```bash
nx run @typedblite/content-revision:test
```

Test files live in `src/lib/revision.spec.ts`.
