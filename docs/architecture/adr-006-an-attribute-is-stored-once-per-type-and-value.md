---
kind: adr
status: accepted
date: 2026-11-11
decision-owners: [TypeDBLite maintainers]
extends: [adr-002, adr-005]
constrained-by: [adr-003]
---

# ADR-006: An attribute is stored once per type and value

- **Status:** Accepted by the founder (Dave Jackson) on 2026-11-11, with the implementation merged
  (PR #3) and both acceptance checks met. See Measurements.
- **Date:** 2026-11-11
- **Decision owners:** Founder; TypeDBLite maintainers
- **Extends:** [ADR-002](adr-002-typeql-engine-as-a-port.md), whose SQLite adapter this reshapes;
  [ADR-005](adr-005-typedb-s-behaviour-specification-is-typedblite-s-conformance-oracle.md), whose
  report card names the gap
- **Constrained by:** [ADR-003](adr-003-typedblite-change-log-and-sync-as-a-port.md). The change log's
  documents, revision digests and wire format must not change.

> ✅ **Accepted 2026-11-11 by the founder.** It was held at Proposed until the migration had run
> against real file-backed stores and the performance check had passed. Both were measured before
> acceptance: identical answers on 18 migrated downstream-app stores, and an engine faster than the
> one it replaced. The card rose from 1,306 to 1,439 of 1,756.

---

## Context

TypeDBLite stores an attribute as a value attached to its owner:

```sql
CREATE TABLE attr (
  owner INTEGER NOT NULL REFERENCES thing(iid) ON DELETE CASCADE,
  type  TEXT NOT NULL,
  value TEXT NOT NULL
);
```

In TypeDB an attribute is an instance in its own right:

- **There is one instance per type and value.** Every owner of `name "John"` owns the same
  instance (`insert.feature`, "inserting two attributes with the same type and value creates only
  one concept"; "after inserting two instances that own the same attribute, the attribute has two
  owners").
- **It can exist without an owner.** `insert $n isa name "John";` creates the attribute and
  nothing else, and `match $n isa name;` finds it if `name` is `@independent`.
- **It has its own lifecycle.** `delete $n;` removes the attribute and every ownership of it
  (`delete.feature` L162, L1019). An attribute whose type is not `@independent` stops existing when
  its last owner goes.

The `attr` table can express none of this. `owner` is `NOT NULL`, so an ownerless attribute cannot
be written. Two Johns are two rows, so there is no single instance to bind, count or delete.
**About 140 scenarios on the report card fail here**, counted on 2026-11-11 with the card at 1,306
of 1,756. It is the largest group blocked on storage.

Four facts about the current engine shape the decision:

1. **Stored values are already canonical per value type.** `canonicalValue` in the interpreter
   writes `2` on a `double` attribute as `2.0`, a date on a `datetime` as midnight, and `PT90M` as
   `PT1H30M`. A uniqueness constraint on `(type, value)` therefore gives TypeDB's identity rule,
   including `insert.feature` L1426 and L1493 (`2` and `2.0` are one concept).
2. **The interpreter already binds an attribute by value, not by row.** A bound attribute is a
   `ValueBinding` of kind `attribute` carrying its type and canonical value, which is exactly
   TypeDB's identity for an attribute. No query needs an attribute's row id.
3. **A `thing` row is a change-log document.** `ChangeLog.identify(iid)` turns every `thing` row
   into a replicated document, and the full-text index follows the same rows. An owner's document
   lists its attributes as `{ type, value }` pairs.
4. **`@key` and `@unique` are partial unique indexes on `attr(value)`**, one per attribute type,
   so they apply across all owners (sqlite-generator.ts, schema-mutation.ts). Scoping them per owner
   type is a separate gap of about 26 scenarios that this ADR does not close.

## Decision

### 1. Attribute instances get their own table, unique by type and value

```sql
CREATE TABLE attribute (
  id    INTEGER PRIMARY KEY,
  type  TEXT NOT NULL,
  value TEXT NOT NULL,          -- the canonical text canonicalValue produces
  UNIQUE (type, value)
);
```

An attribute's identity is its type and canonical value. The `id` is a local join key: it never
appears in an answer, a change-log document or a replicated revision. So the rowid reuse that
ADR-003 warns about for `thing` does no harm here.

**A zoned datetime's zone is part of its identity**, as it is in TypeDB. The same instant written in
two zones is two attributes: `…T01:00:00+01:00` and `…T00:00:00Z`, or `Europe/London` and `+00:00`.
Canonical `datetime-tz` text already keeps the zone, so `UNIQUE (type, value)` gives this with no
extra rule. In TypeDB 3.10.4 the stored form of a `datetime-tz` is the UTC instant followed by a
4-byte zone code: an IANA zone id, or a fixed offset (`encoding/value/date_time_tz_bytes.rs`,
`timezone.rs`). An attribute's vertex key is its type followed by those bytes, unhashed and not
normalised to UTC (`encoding/graph/thing/vertex_attribute.rs`).

⚠️ **Identity and comparison differ for zoned datetimes.** TypeDB's in-memory `Value` takes its
equality, ordering and hashing from chrono's `DateTime`, which compares instants and ignores the
zone (`encoding/value/value.rs`). So `==` between the two values above can be true even though they
are two attributes. The implementation must keep the two apart: `UNIQUE (type, value)` for identity,
instant order for comparison. Today the runtime refuses `==` and `<` on zoned datetimes by name
(`compare` in `expressions.ts`). Only `min` and `max` compare them by instant, and only for a fixed
offset (`compareOperands` in `reduce.ts`). Comparing zoned datetimes is separate work outside this
ADR, and that work must not borrow attribute identity for equality.

### 2. Ownership is an edge between a thing and an attribute

```sql
CREATE TABLE has (
  owner     INTEGER NOT NULL REFERENCES thing(iid)    ON DELETE CASCADE,
  attribute INTEGER NOT NULL REFERENCES attribute(id) ON DELETE CASCADE,
  type      TEXT    NOT NULL,   -- the attribute's type, copied
  PRIMARY KEY (owner, attribute)
);
CREATE INDEX has_owner     ON has(owner);
CREATE INDEX has_attribute ON has(attribute);
```

`has` replaces `attr`. The primary key makes ownership a set: inserting `has name "John"` twice is
one ownership.

The copied `type` column serves two purposes:

- **`@key` and `@unique` keep today's enforcement unchanged.** Each becomes
  `CREATE UNIQUE INDEX … ON has(attribute) WHERE type = '<attr>'`: an attribute instance owned at
  most once across all owners, which is what `ON attr(value) WHERE type = …` enforces today.
  Scoping by owner type stays a separate decision.
- **"Does this owner have a T"** reads `has` alone, with no join.

The index is on `owner` alone, not `(owner, type)`, because an owner's attributes are read in the
order they were written, and only an index on `owner` alone gives rowid order without a sort. The
first implementation indexed `(owner, type)` and paid for the sort on every query (see
Measurements). A lookup by value starts from the value instead: `attribute(type, value)` finds the
one instance, and `has(attribute)` finds its owners.

### 3. 🔴 Attributes are not rows in `thing`

`thing` keeps holding only entities and relations, the things that are change-log documents.
`match $a isa age` reads `attribute`, walking `type_parent` for subtypes exactly as it does for
`thing`. A type variable (`$x isa $t`) reads both tables.

### 4. An attribute whose type is not independent goes when its last owner goes, at the end of the statement

At the end of every statement that writes, the engine deletes each attribute that:

- the statement created, or removed an ownership of, and
- now has no `has` rows, and
- has a type that is not `@independent`, either declared or inherited through `sub`
  (`match.feature` L4214: `dog-age sub age` with `age @independent`).

The same sweep runs after a replicated revision is projected and after a schema change that removes
`@independent` or an `owns`.

**Removing `@independent` takes the ownerless attributes with it; it is not refused.** In
`delete.feature` L1329, `undefine @independent from email;` runs in a schema transaction while two
ownerless `encrypted-email` attributes exist. The schema change succeeds. The next
`match $e isa email; delete has $e of $p;` in the **same transaction** answers only the email
inserted after the undefine, so the two ownerless ones are already gone. L2005's title states the
rule: "not independent attributes are always hidden after queries if owners are lost".

⚠️ **The sweep runs at the end of the statement, not at commit.** `match.feature` L4214 inserts a
non-independent `birth-date` with no owner. The insert answers the new concept, but a `match` later
**in the same transaction** finds nothing. A commit-time sweep would answer it.

The insert still answers the concept, because the sweep runs after the statement's answers are
built.

`delete $a` on an attribute removes it and, through the foreign key, every ownership of it. It is
refused when any of those ownerships is a `@key`. TypeDB accepts the delete and then fails the
commit, because the owner is left without its key (`delete.feature` L2755). TypeDBLite validates
nothing at commit, so it refuses at the `delete`, the one point that still keeps every owner keyed.
That scenario fails either way until commit-time validation exists.

### 5. The change log does not change

An owner's document still lists its attributes as `{ type, value }` pairs, now read through a join
of `has` and `attribute`. Canonical encoding, revision digests, the wire format and
`@typedblite/content-revision` are all unchanged, and the CouchDB oracle suites must pass without
edits. That is the test of this decision.

An `@independent` attribute with no owner belongs to no document, so **it does not replicate under
this ADR.** No schema in this repository or in its known consumers uses `@independent` today
(searched 2026-11-11). If one ever needs to replicate, its identity, type plus value, is already the
same on every node, so it can have a document of its own without the iid problem ADR-003
Decision 10 solved for things.

### 6. Existing stores are migrated when they are next opened

When a store has an `attr` table and no `attribute` table, opening it runs one transaction that:

1. creates `attribute` and `has`,
2. inserts each distinct `(type, value)` from `attr` into `attribute`,
3. inserts one `has` row per `attr` row, collapsing duplicates,
4. recreates every `key_*` and `unique_*` index on `has`, and
5. drops `attr`.

Every attribute in an existing store has an owner, so the migration sweeps nothing. It is
**one-way**: an engine build from before this ADR cannot read a migrated store.

## Consequences

### Positive

- **The largest storage-blocked group (about 140 scenarios) becomes reachable:** ownerless
  attributes, `@independent`, attribute deletion, one concept per value, and `isa` on attribute
  types.
- **A value is stored once.** A store where many owners share a value (a status, a tag) gets
  smaller, and a value lookup hits one row of `attribute(type, value)` before following
  `has(attribute)`.
- **Replication is untouched.** Documents, digests and the oracle suites are what ADR-003 and the
  revision parity invariant protect, and none of them change.
- **The interpreter's model of an attribute does not change.** Bindings were already by type and
  value. Only the SQL beneath them moves.

### Negative / Constraints

- **Every read of an owned value is a two-table join** (`has` then `attribute`) where it was one.
  Both sides are indexed, and the measurements below show no slowdown.
- **About 26 SQL sites change:** `interpreter.ts` (23 references), `change-log.ts`,
  `schema-mutation.ts` (renaming an attribute type now updates `attribute.type` and `has.type`),
  the generated DDL, one runtime test, and `libs/conformance/src/owners.ts`, which reads `attr`
  directly from a store file.
- **The migration is one-way.** A consumer that pins an older engine build cannot open a store a
  newer build has opened. Consumers that link through `file:` upgrade together.
- **`@independent` attributes with no owner stay on the node that wrote them** until a later
  decision gives them documents (Decision 5).
- **The sweep is extra work on each write statement.** It is limited to the attributes that
  statement touched, never the whole table.

### What was rejected

- **Making `attr.owner` nullable and adding ownerless rows.** Two Johns would still be two rows,
  so there is still no single instance, `UNIQUE (type, value)` cannot hold, and the
  "one concept" scenarios still fail. It moves the gap without closing it.
- **Storing attributes as rows in `thing`.** It would give every concept one iid space, but
  `thing` would stop meaning "a change-log document". `identify`, `recordWrite`, the full-text
  index and every entity scan would each need to exclude attributes, and a missed exclusion would
  replicate an attribute as a document. The interpreter gains nothing from it, because it binds
  attributes by value.
- **Removing ownerless attributes at commit**, as TypeDB's documentation phrases it. The spec
  (`match.feature` L4214) shows them gone within the transaction, after the statement.
- **Typed value columns** (`INTEGER`, `REAL`) in place of canonical text. That is a separate
  question about comparison and sort pushdown. Canonical text is what identity, the change log and
  the digest already use, and changing it here would put the revision parity invariant at risk for
  no conformance gain.

## Questions settled while drafting (2026-11-11)

1. **Undefining `@independent`** removes the ownerless attributes immediately and is not refused.
   The spec settles it (`delete.feature` L1329 and L2005), and Decision 4 records it.
2. **A zoned datetime's zone is part of its identity.** The spec has no scenario that inserts one
   instant under two zones. It leans that way, because a stored attribute reads back in the zone it
   was written in (`fetch.feature` L821–L822). The TypeDB 3.10.4 server source settles it, under
   ADR-005's rule that the server's implementation decides what the spec leaves open. Decision 1
   records it.

**Left for the implementation to confirm.** The server reading covered the value encoding and the
attribute key. It did not trace three paths:

- the insert path that reuses an existing attribute vertex;
- whether a value match (`$a isa T <value>`) looks up the key, which is zone-sensitive, or
  compares values, which is instant-based;
- whether the parser reads `Z` as a fixed offset of zero, the same as `+00:00`, or as the IANA
  zone `UTC`.

The engine's canonical text folds `Z`, `+00:00` and `-00:00` into one spelling. If TypeDB reads
`Z` as `UTC`, then `Z` and `+00:00` are two attributes there, and the canonical text must keep
them apart. The conformance card is the check for all three.

## Measurements (2026-11-11, implementation on `feat/attribute-instances`)

**Migration on real stores.** 18 TypeDBLite stores from the downstream-app workspace were copied
through SQLite's backup API, with the originals opened read-only. Each copy was queried by the old
engine and by the new engine after migrating it. Per thing type, the queries listed every ownership
(`match $x isa! T, has $a;`) and looked up one string value per owned attribute type. **Every
answer was identical on all 18 stores**: about 225,000 ownerships and 232 lookups. Migration took
0.6 s on the largest store (275,594 ownerships).

One query failed with "Maximum call stack size exceeded" on both engines alike: `scm/ladder`'s
`workflow-history-entry`, at 194,244 ownerships. That is an existing limit on very large answers,
not part of this change.

**Performance.** The old engine's build was compared with this one's, both compiled, on the four
largest stores, taking the median of five alternating runs:

| Store | Listing ownerships | Lookups by value |
| --- | --- | --- |
| `scm/ladder` | −7% | −82% |
| `observability` | −2% | −41% |
| `document-store` | −7% | −77% |
| `skills/graph` | −11% | −51% |

The first implementation was slower: +8% to +10% on listings and +14% to +57% on lookups. It
indexed `has(owner, type)`, which forced a sort per owner, and it found owners of a value by probing
every candidate thing. Decision 2's index and value-first lookups replaced both.

**Conformance.** 1,306 → 1,439 of 1,756, with no scenario lost. The storage swap alone left the card
unchanged at 1,306. The new behaviour added 133: attribute inserts, matches, deletes, `isa $t` over
attributes, and values matched across numeric kinds.

## Amendment — `@key` and `@unique` are scoped per owner type (2026-11-11)

Decision 2 kept today's enforcement: one partial unique index per attribute type, so a value could
be owned once across ALL owners. Scoping by owner type was left as a separate decision. This
amendment takes it, because the spec is unambiguous (`insert.feature` L1662–L1729):

- A `@key` or `@unique` holds among the instances of the type that declares it **and its
  subtypes**. A `base` and a `derived` may not share `ref 0` (L1671), and nor may two siblings
  (L1704).
- Two owner types that each declare the ownership are separate: a person and a friendship may each
  have `ref 0`. The global index refused that, and about 26 scenarios with it.

**What changed.** `has` gains a `scope` column: for a key or unique ownership, the top-most type in
the owner's ancestry that declares it (on the attribute or a supertype of it), and NULL otherwise.
One partial unique index, `has_unique_in_scope ON has(attribute, scope) WHERE scope IS NOT NULL`,
replaces every per-attribute `key_*`/`unique_*` index. A single SQL function computes the scope,
used by local writes and by the change log's replication path, so the two cannot disagree. Every
schema transaction rescopes the stored ownerships before it commits, so data that does not conform
fails the index and the change rolls back. A store from earlier in ADR-006's implementation gets the
column on open and loses the old indexes.

**What did not change.** Identity (ADR-003 Decision 10) still reads `key_attribute`, and the change
log's documents are untouched. The 18 real stores still answer identically after migration.
Migration on the largest takes 0.8 s, up from 0.6 s, because it also scopes every ownership.

## References

- `libs/conformance/spec/query/language/insert.feature`: L349, L364, L388, L1407, L1426, L1493
- `libs/conformance/spec/query/language/match.feature`: L4214 (independence and visibility within
  a transaction)
- `libs/conformance/spec/query/language/delete.feature`: L162, L1019, L1119, L1329 and L2005
  (undefining `@independent`), L2755
- `libs/conformance/spec/query/language/fetch.feature`: L821–L822 (a zoned datetime reads back in
  the zone it was written in)
- [`typedb/typedb` at 3.10.4](https://github.com/typedb/typedb/tree/3.10.4), the server version the
  spec pin was surveyed against: `encoding/value/date_time_tz_bytes.rs`, `timezone.rs`,
  `primitive_encoding.rs` and `value.rs`, and `encoding/graph/thing/vertex_attribute.rs` (read
  2026-11-11)
- [ADR-003](adr-003-typedblite-change-log-and-sync-as-a-port.md): documents, identity (Decision 10)
  and the revision parity this must preserve
- [ADR-005](adr-005-typedb-s-behaviour-specification-is-typedblite-s-conformance-oracle.md): the
  report card and the baseline rule the implementation is measured against
