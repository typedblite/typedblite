# Replication and search

Every TypeDBLite store keeps a **change log** of what it wrote. Two stores can exchange their change
logs and converge, either once on demand or continuously over HTTP. The same log keeps a
**full-text index** current. This guide covers both.

The design is [ADR-003](../architecture/adr-003-typedblite-change-log-and-sync-as-a-port.md). The
model is CouchDB's (revision trees, deterministic revisions, and conflicts kept rather than
discarded), and it was checked against a real CouchDB 3.4.3 when it was built. The wire protocol is
TypeDBLite's own, so TypeDBLite does not replicate with CouchDB itself.

- [What gets replicated](#what-gets-replicated)
- [The change log](#the-change-log)
- [Revisions and conflicts](#revisions-and-conflicts)
- [Replicating once](#replicating-once)
- [Hub and spoke over HTTP](#hub-and-spoke-over-http)
- [Security](#security)
- [Compaction](#compaction)
- [Full-text search](#full-text-search)

To see all of this working across a browser, a desktop app and a phone, run the
[sync demo](../../apps/sync-demo/README.md).

## What gets replicated

**A thing replicates when its type has a `@key`.** Its identity across stores is `type/key-value`,
such as `person/Alice`. That is what lets two stores agree they are describing the same person.

The internal `iid` is never used, because two stores both call their first thing `1`. A thing whose
type has no key is logged under a `local:` identity, such as `local:employment/4`, and **is not
replicated**. Replication refuses to guess that two keyless things are the same one.

So, for a type you want replicated, declare a key:

```typeql
define
  entity note, owns note-id @key, owns body;
  attribute note-id, value string;
  attribute body, value string;
```

What a revision carries is the thing's whole state: its type, its attributes, and the roles it
plays. A relation that names a player the receiving store has not seen yet is held back, and is
drawn once that player arrives.

## The change log

Every write appends to the log **in the same SQLite transaction as the data**. A crash can never
leave a write that the log does not know about. A write that bypasses your application, from the
CLI or a migration script for example, is logged too.

```ts
import { TypeDBLiteInterpreter } from '@typedblite/runtime';

const db = new TypeDBLiteInterpreter('./notes.db');
db.execute(`insert $n isa note, has note-id "n1", has body "first draft";`);

for (const record of db.changeLog.since(0, 100)) {
  record.seq;       // 1: the cursor, strictly increasing and never reused
  record.entityId;  // 'note/n1'
  record.rev;       // '1-…': generation and digest
  record.parentRev; // null for a first revision
  record.deleted;   // true for a tombstone
  record.state;     // { type, attributes, roles }, absent for a tombstone
}
```

`since(cursor, limit)` returns the records after `cursor`, in commit order. Keep the last `seq` you
processed, and you can resume from exactly that point.

## Revisions and conflicts

A revision looks like `2-9f86d081884c7d659a2feaa0c55ad015`: a generation number, then a digest of
the state, the parent revision and the deleted flag
([`@typedblite/content-revision`](../../libs/content-revision/README.md)).

**The digest comes from the content, not from chance.** The same edit made independently on two
stores produces the same revision, so they converge with no conflict.

**Different edits to the same thing are a conflict, and both are kept.** Every store picks the same
winner without talking to the others:
1. a live revision beats a tombstone;
2. then the highest generation wins;
3. then the greatest digest wins.

The winner is what queries see. The losing revisions stay, and you can list them:

```ts
db.changeLog.winnerOf('note/n1');    // the winning leaf
db.changeLog.conflictsOf('note/n1'); // the losing leaves, for your application to resolve
db.changeLog.leavesOf('note/n1');    // every leaf
```

Nothing is discarded silently: which losing revision matters, if any, is your application's
decision.

## Replicating once

`replicateOnce` exchanges records between two change logs in one direction or both:

```ts
import { TypeDBLiteInterpreter, replicateOnce } from '@typedblite/runtime';

const a = new TypeDBLiteInterpreter('./a.db');
const b = new TypeDBLiteInterpreter('./b.db');

const outcome = replicateOnce(a.changeLog, b.changeLog, { direction: 'duplex' });
// { cursor: { pull: 1, push: 2 }, applied: 2, conflicts: 0 }
```

| Option | Meaning |
| ------ | ------- |
| `direction` | `'push'` (local to remote), `'pull'` (remote to local), or `'duplex'` (both) |
| `from` | The cursor returned last time, `{ pull, push }`, to resume instead of starting over |
| `limit` | Records per batch. Default 500 |

Both stores need the same schema. Replication moves data, not schema.

`replicateOnce` accepts anything that implements `ReplicationEndpoint` (`since`, `applyRemote` and
`conflictsOf`). A `ChangeLog` is one.

## Hub and spoke over HTTP

For stores in different processes or on different machines, one store is the **hub** and the others
are **spokes**. The hub streams its changes to each spoke over Server-Sent Events, and each spoke
POSTs its own changes to the hub.

**The hub:**

```ts
import { TypeDBLiteInterpreter, serveChangeStream } from '@typedblite/runtime';

const hub = new TypeDBLiteInterpreter('./hub.db');
const served = serveChangeStream(hub.changeLog, { pollMs: 250, port: 4001 });
await served.port; // 4001
// GET  /changes          an SSE stream of changes, resumable with Last-Event-ID or ?since=
// POST /changes          a spoke's changes
await served.close();
```

`serveChangeStream` listens on `127.0.0.1` only. To serve the stream to other machines, put it
behind your own server, with your own authentication. `createChangeStreamHandler(log, options)`
gives you a plain `(request, response)` handler to mount:

```ts
import { createServer } from 'node:http';
import { createChangeStreamHandler } from '@typedblite/runtime';

const changes = createChangeStreamHandler(hub.changeLog, { path: '/changes' });
createServer((request, response) => {
  if (!isAuthorized(request)) return void response.writeHead(401).end();
  changes.handle(request, response);
}).listen(4001);
```

**A spoke:**

```ts
import { TypeDBLiteInterpreter, TypeDBLiteReplicator } from '@typedblite/runtime';

const spoke = new TypeDBLiteInterpreter('./spoke.db');
const replicator = new TypeDBLiteReplicator(
  spoke.changeLog,
  'https://hub.example.com',
  100,                                           // push interval, in milliseconds
  async () => ({ authorization: `Bearer ${token}` }), // headers for each request
);

// Catch up once, giving up if the hub has not answered within 8 seconds…
await replicator.replicateOnce({ direction: 'duplex', timeoutMs: 8_000 });

// …or keep replicating until canceled.
const session = replicator.replicateContinuously(
  { direction: 'duplex' },
  {
    onChange: (applied) => console.log(`applied ${applied} change(s)`),
    onPaused: () => console.log('caught up'),
    onFailed: (error, classification) => console.error(classification, error),
  },
);
session.status; // 'syncing' | 'ready' | 'idle' | 'failed'
await session.cancel();
```

**A sync that did not happen fails; it never reports success.** `replicateOnce` rejects when:
- the hub refuses the spoke (401 or 403);
- the hub answers with any other error status, such as a 503 from a proxy whose hub is down;
- the stream ends before the hub says it is caught up;
- or, with `timeoutMs`, the hub accepts the connection and then says nothing.

An offline-first app should treat any of these as "offline", keep its cursor, and try again
later. The next successful sync sends everything after the push cursor, and pulls everything after
the pull cursor.

A continuous session reconnects after a network failure, and resumes from the last change it
applied. Catching up does not end it: it reports `onPaused` and keeps listening. `onFailed`
classifies an error as `'transient'`, such as a network failure that a retry may cure, or
`'terminal'`: a received change this store could not apply, which would fail the same way again.

## Security

**The hub trusts everything that can reach it.** `serveChangeStream` and `createChangeStreamHandler` have
no authentication and no encryption, by design: the handler is a piece you mount in your own server, and
the guide above shows where your authentication goes. Reviewed on 2026-11-14 by reading `change-stream.ts`
and `change-log.ts` and running each case against a live hub. The review found eight problems. Five are
now handled by the handler itself; three are yours to handle, or open.

| What the review found | Now |
| --- | --- |
| **Any content type was accepted.** A `text/plain` POST was applied, and a web page can send exactly that cross-origin with **no CORS preflight**, so a page open on the same machine could write to a hub on `127.0.0.1` | **Handled.** Anything but `application/json` is refused with 415 |
| **No body size limit.** A POST of about 64 MB was read into memory and applied | **Handled.** `maxBodyBytes` (default 64 MiB). A body whose length is declared too big is refused with 413 before it is read, and one that grows past it is stopped as it arrives |
| **No cap on open streams.** Each `GET /changes` holds a connection and a timer that queries the log every `pollMs` | **Handled.** `maxStreams` (default 256). One more gets 503 with `retry-after: 5` |
| **A batch was not atomic.** `[good, null, good]` applied the first record, then answered 400 | **Handled.** A batch is checked field by field first, and applied all or none (`ChangeLog.applyRemoteBatch`) |
| **Errors were echoed.** A 400 carried internal text, such as `no such table: attribute` | **Handled.** A malformed batch gets a 400 that names the problem (`change 1 has an invalid rev`). An internal failure gets a 500 and `internal error`. The real error goes to your `onError` callback |
| **No authentication.** Anyone who can connect can read every change and POST new ones, and a pushed change is projected into the hub's store | **Yours.** Mount the handler behind your own check (below) |
| **No TLS.** | **Yours.** Anything beyond loopback needs a TLS-terminating proxy, or the token travels in the clear |
| **Revisions were not checked against their content.** `applyRemote` stored the `rev` it was given, so a peer could claim `999999-deadbeef`, or send a revision another store holds with different content, which splits the two stores for good | **Checked** (ADR-003, amended 2026-11-15). A revision must equal what its state, parent and deleted flag give, and a live one must carry its state. Otherwise `applyRemote` throws (`typedblite.revision-not-derived`), and the hub answers 400 naming the change. ⚠️ **A peer that may write can still make its write win**: it can write a child of the winner, or claim any parent (compaction deletes ancestors, so an unknown parent is allowed). Only authentication decides who may write |

**What is safe by default.** `serveChangeStream` binds `127.0.0.1` only, so nothing outside the machine can
reach it unless you mount the handler yourself. That is not protection from the machine's own users or
programs. A browser page on it is stopped from sending `application/json` cross-origin, because that needs
a CORS preflight and the handler gives none (an `OPTIONS` gets a 404, or a 401 behind authentication).

**Mount the handler behind authentication.** The limits above are built in. Authentication is not:

```ts
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createChangeStreamHandler } from '@typedblite/runtime';

const changes = createChangeStreamHandler(hub.changeLog, {
  path: '/changes',
  maxBodyBytes: 8 * 1024 * 1024, // tighten what your spokes really send
  maxStreams: 64,
  onError: (error) => console.error('hub failed to apply a batch', error),
});
const expected = Buffer.from(`Bearer ${process.env.HUB_TOKEN}`); // a long random value, never in source

createServer((request, response) => {
  // Compared without a timing difference. A browser cannot add this header cross-origin without a
  // preflight, so this also closes the cross-origin hole for good.
  const given = Buffer.from(request.headers.authorization ?? '');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return void response.writeHead(401).end();
  }
  changes.handle(request, response);
}).listen(4001, '127.0.0.1'); // and terminate TLS in front of it
```

Give a hub only spokes you trust, because of the last row.

**The sync demo's hub is not a model.** It uses a fixed token, `DEMO_TOKEN`, written in the source and
compared with `!==`, and its `/tasks` and `/health` routes need none. It is bound to `127.0.0.1` and exists
to show convergence on one machine.

## Compaction

Revision history grows with every edit. Compaction drops the states of revisions that are no longer
leaves:

```ts
const report = db.changeLog.compact({ keepAncestors: 0 });
// { entities, revisionsBefore, revisionsAfter, removed, bytesReclaimed }
db.changeLog.vacuum(); // return the freed pages to the file system
```

`keepAncestors` keeps that many non-leaf revisions behind each leaf. Compaction never removes a
leaf, so conflicts survive it.

## Full-text search

Every thing the change log records, keyed or not, is indexed for full-text search with SQLite's
FTS5. The index is updated in the same transaction as the write, whether the write was local or
replicated:

```ts
db.changeLog.fullText.search('text:draft', 20);
// [{ entityId: 'note/n1', rank: -0.000001 }]
```

The index has four columns you can search:

| Column | Holds |
| ------ | ----- |
| `doctype` | The thing's type |
| `status` | The value of an attribute named `status`, if it has one |
| `tags` | Every attribute named `tag` or ending in `-tag`, joined by spaces |
| `text` | Every attribute value |

The query string is [FTS5 query syntax](https://www.sqlite.org/fts5.html#full_text_query_syntax), so
`text:replication AND doctype:note` and `"exact phrase"` work. Results come back best match first;
`rank` is BM25, where lower is better.

Full-text search is not part of TypeQLite. TypeQL has no full-text construct, and TypeDBLite does
not add one ([ADR-002](../architecture/adr-002-typeql-engine-as-a-port.md), Decision 6).
