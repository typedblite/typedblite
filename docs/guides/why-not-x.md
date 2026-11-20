# When to use TypeDBLite, and when not

> **Draft, for the maintainer's review.** The tone, and the section on TypeDB, need a person's eye before this is
> linked from the README. TypeDB Ltd may want to read that section too.

TypeDBLite runs TypeDB's data model and a dialect of its query language inside your own process, over SQLite. That
is a narrow niche, and for many projects something else is the better choice. This page says which, as plainly as
it can. Where it describes TypeDBLite, the [known limitations](known-limitations.md) page has the evidence. It does
not compare speed with the other tools: nothing here has measured them side by side.

- [Why not TypeDB itself?](#why-not-typedb-itself)
- [Why not plain SQLite?](#why-not-plain-sqlite)
- [Why not a graph library?](#why-not-a-graph-library)
- [Why not a document database with sync?](#why-not-a-document-database-with-sync)
- [In short](#in-short)

## Why not TypeDB itself?

**If you can run a server, start with TypeDB.** It is the original: the data model and TypeQL are its design, and
TypeDBLite is measured against it ([CONFORMANCE.md](../../CONFORMANCE.md)), not the other way round. It is built to
be shared over a network by many clients, and it is where the language is defined and where it grows.

TypeDBLite is for where a server is not an option:

- **In a browser, a desktop app, a phone, a CLI, or a test**, where there is no server to reach, or you do not want
  one. TypeDBLite is a library: `npm install`, open a file, query it. In a browser it runs on WASM SQLite in a worker.
- **Offline-first.** Every write goes into a change log, and stores replicate through a hub, converge when two of
  them make the same edit, and keep both sides of a conflict for you to resolve
  ([Replication and search](replication-and-search.md)).

What you give up, compared with TypeDB:

- **It is a dialect.** On TypeDB's own behavior specification it passes 1,742 of 1,756 scenarios, and it refuses by
  name what it does not support, but a query that runs on TypeDB may not run here, and some annotations are accepted without being enforced on writes
  ([The language](known-limitations.md#the-language)). Do not assume a schema or a query moves between the two
  unchanged; check it against the [language guide](typeqlite-language.md).
- **One writer at a time,** because SQLite allows one. Writes do not get faster with more processes.
- **A simpler query planner,** with no cost model ([Performance and scale](known-limitations.md#performance-and-scale)).
- **No server features:** no network protocol of its own beyond the replication hub, no users, no authentication
  (you add your own in front of the hub).
- **A young, independent project,** with no company behind it. It is not affiliated with or endorsed by TypeDB Ltd.

## Why not plain SQLite?

**If your data fits tables and your queries fit SQL, use SQLite directly.** It is simpler, faster, and you need
nothing in between. TypeDBLite is built on SQLite, and every query becomes SQL, with a cost per query that plain SQL
does not pay.

TypeDBLite adds a layer for when the data is a graph of typed things, and you want the database to know the types:

- **A type system:** entities, relations and attributes, with inheritance, so a query for `person` also finds
  `employee`.
- **Relations as first-class things,** with named roles and any number of players, and attributes that belong to the
  data rather than to one table's columns.
- **The schema is enforced on write.** A duplicate `@key`, an attribute a type does not own, or a role player that
  does not exist is refused, with a diagnostic code you can branch on.
- **Pattern queries** in TypeQL, rather than joins you write by hand.
- **A change log with revisions, replication and full-text search**, which plain SQLite leaves to you.

The cost is a layer to learn, the query cost above, and the [limitations](known-limitations.md) of a young engine.
The store is an ordinary SQLite file, but its tables are TypeDBLite's own: read them with TypeQLite, not SQL.

## Why not a graph library?

**If you need graph algorithms over data you hold in memory, use a graph library.** Shortest paths, centrality,
community detection and layouts are what those are for, and TypeDBLite has none of them.

TypeDBLite is a database, not an algorithm toolkit: a schema, persistence in a file, a query language, transactions,
and replication. **If you need a persistent graph database with a property-graph model and a query language such as
Cypher,** that is a different model from TypeDB's: TypeDB's relations are n-ary and its attributes are first-class,
where a property graph has binary edges and properties on nodes. Choose by the model that fits your data. Choose
TypeDBLite when TypeDB's model is the one you want and it has to run in your process.

## Why not a document database with sync?

**If you need offline-first sync and your data is documents, a document database with sync is mature and proven.**
TypeDBLite's replication follows CouchDB's model on purpose: revision trees, revisions derived from content, and
conflicts kept rather than discarded ([ADR-003](../architecture/adr-003-typedblite-change-log-and-sync-as-a-port.md)).
It does not speak CouchDB's protocol, and cannot replicate with CouchDB.

Choose TypeDBLite when the data is a typed graph, with relations between things and a schema that should be enforced
on every node, and you also want it to sync.

## In short

| You need | Start with |
| --- | --- |
| A database shared over a network, many writers, the full TypeQL language | TypeDB |
| Tables and SQL, in your process | SQLite |
| Graph algorithms over data in memory | A graph library |
| A property graph with Cypher | A property-graph database |
| Documents that sync offline | A document database with sync |
| **TypeDB's model, in your process or a browser, with offline sync** | **TypeDBLite** |
