/**
 * FTS5 against Nouveau, over the **real corpus**, not a fixture.
 *
 * `docker-compose.downstream-store.yaml` holds ~2,880 documents. Comparing against a handful of
 * hand-made records would prove the query syntax and nothing about recall on real prose, which is
 * where the two engines actually differ.
 *
 * 🔴 Differences are **findings to record, not failures to hide**. FTS5's `unicode61` tokenizer is
 * not Lucene's `standard` analyzer; stemming differs unless `porter` is opted into; Nouveau indexes
 * `tag` as genuinely multi-valued where an FTS5 column holds one string. This suite asserts the
 * things that must hold and *reports* the rest.
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { FullTextIndex } from '../src/full-text.js';
import type { EntityState } from '../src/canonical.js';

const HOST = process.env.DOCS_STORE_COUCHDB_HOST ?? 'http://127.0.0.1:5984';
const USER = process.env.DOCS_STORE_COUCHDB_USER ?? 'admin';
const PASSWORD = process.env.DOCS_STORE_COUCHDB_PASSWORD ?? 'password';
const AUTH = `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString('base64')}`;

/** Credentials in a header — Node's `fetch` refuses a URL that carries them. */
const couch = (path: string) =>
  fetch(`${HOST}${path}`, { headers: { Authorization: AUTH } });

async function corpusAvailable(): Promise<boolean> {
  try {
    const response = await couch('/docs');
    if (!response.ok) return false;
    const info = (await response.json()) as { doc_count: number };
    return info.doc_count > 100;
  } catch {
    return false;
  }
}

const available = await corpusAvailable();

interface CorpusDoc {
  _id: string;
  docType?: string;
  status?: string;
  title?: string;
  body?: string;
  tags?: string[];
}

/** Nouveau's answer for a query, as document ids. */
async function nouveau(query: string, limit = 200): Promise<string[]> {
  const response = await couch(
    `/docs/_design/search/_nouveau/docs?q=${encodeURIComponent(query)}&limit=${limit}`,
  );
  const body = (await response.json()) as { hits?: Array<{ id: string }> };
  return (body.hits ?? []).map((hit) => hit.id).sort();
}

describe(
  'FTS5 parity with Nouveau over the real corpus',
  {
    skip:
      !available &&
      'downstream-store corpus unavailable — start docker-compose.downstream-store.yaml and run downstream-store:sync',
  },
  () => {
    let index: FullTextIndex;
    let indexed = 0;

    const build = async () => {
      if (index) return;
      const db = new DatabaseSync(':memory:');
      index = new FullTextIndex(db);
      index.ensureSchema();

      const response = await couch('/docs/_all_docs?include_docs=true&limit=5000');
      const body = (await response.json()) as {
        rows: Array<{ id: string; doc: CorpusDoc | null }>;
      };
      for (const row of body.rows) {
        const doc = row.doc;
        if (!doc || row.id.startsWith('_design/')) continue;
        const state: EntityState = {
          type: doc.docType ?? 'doc',
          attributes: [
            ...(doc.status ? [{ type: 'status', value: doc.status }] : []),
            ...(doc.title ? [{ type: 'title', value: doc.title }] : []),
            ...(doc.body ? [{ type: 'body', value: doc.body }] : []),
            ...(doc.tags ?? []).map((tag) => ({ type: 'tag', value: tag })),
          ],
          roles: [],
        };
        index.index(row.id, state);
        indexed += 1;
      }
    };

    it('indexes the whole corpus', async () => {
      await build();
      assert.ok(indexed > 1000, `expected a real corpus, indexed ${indexed}`);
      assert.equal(index.count(), indexed);
    });

    it('🔴 a doctype filter returns the same set as Nouveau', async () => {
      await build();
      const theirs = await nouveau('docType:adr', 500);
      const ours = index
        .search('doctype:adr', 500)
        .map((hit) => hit.entityId)
        .sort();

      // This is the strongest parity claim available: an exact field match on a stored keyword is
      // tokenizer-independent, so the sets must agree exactly rather than approximately.
      assert.deepEqual(
        ours,
        theirs,
        `doctype:adr diverged — ours ${ours.length}, Nouveau ${theirs.length}`,
      );
    });

    it('a text query finds substantially the same documents', async () => {
      await build();
      const theirs = new Set(await nouveau('text:typedblite', 500));
      const ours = new Set(index.search('text:typedblite', 500).map((hit) => hit.entityId));

      const shared = [...ours].filter((id) => theirs.has(id)).length;
      const union = new Set([...ours, ...theirs]).size;
      const overlap = shared / union;

      // Not asserted as identity, and the reason is recorded rather than hidden: `unicode61` is not
      // Lucene's `standard` analyzer, so recall on real prose differs at the margins. A high
      // overlap is the honest claim; an exact match would be a claim about two tokenizers being the
      // same, which they are not.
      assert.ok(
        overlap > 0.8,
        `overlap ${(overlap * 100).toFixed(1)}% — ours ${ours.size}, Nouveau ${theirs.size}`,
      );
    });

    it('prefix search works and is a superset of the exact term', async () => {
      await build();
      const exact = new Set(index.search('text:typedblite', 500).map((h) => h.entityId));
      const prefix = new Set(index.search('text:typed*', 500).map((h) => h.entityId));
      for (const id of exact) {
        assert.ok(prefix.has(id), `prefix search lost ${id}`);
      }
    });

    it('ranks by bm25, best first', async () => {
      await build();
      const hits = index.search('text:replication', 50);
      const ranks = hits.map((hit) => hit.rank);
      assert.deepEqual(
        ranks,
        [...ranks].sort((a, b) => a - b),
        'results must come back in rank order',
      );
    });

    it('🔴 a status filter finds what Nouveau cannot — a live defect the oracle exposed', async () => {
      await build();

      // Ground truth from Mango, which does an exact field comparison and has no analyzer.
      const response = await fetch(`${HOST}/docs/_find`, {
        method: 'POST',
        headers: { Authorization: AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({
          selector: { docType: 'adr', status: 'Accepted' },
          fields: ['_id'],
          limit: 500,
        }),
      });
      const exact = ((await response.json()) as { docs: Array<{ _id: string }> }).docs.map(
        (doc) => doc._id,
      );

      const theirs = (await nouveau('status:Accepted', 500)).length;
      const ours = index
        .search('doctype:adr AND status:Accepted', 500)
        .map((hit) => hit.entityId);

      // 🔴 The finding, asserted so it cannot quietly change:
      //
      // Nouveau's query analyzer lowercases the search term, but `index('string', …)` stores an
      // *unanalyzed* keyword that preserves case. Only already-lowercase values are findable, which
      // is why `docType:adr` works (the value is 'adr') and `status:Accepted` does not (the value
      // is 'Accepted'). Measured against this corpus: Mango finds 81, Nouveau finds 0, and
      // `status:Proposed` finds exactly the 2 documents whose value happens to be lowercase.
      //
      // This is a real defect in downstream-store's search, not a quirk of ours. FTS5 tokenizes the
      // column, so it matches regardless of case — better here, not merely equivalent.
      assert.equal(theirs, 0, 'if Nouveau starts finding these, the defect has been fixed upstream');
      assert.ok(exact.length > 50, `expected a substantial corpus, got ${exact.length}`);

      // FTS5 must find every exact match…
      const found = new Set(ours);
      for (const id of exact) {
        assert.ok(found.has(id), `FTS5 missed ${id}, which Mango matches exactly`);
      }

      // …and its extras are explainable rather than noise: FTS5 tokenizes the column, so a status
      // of "Accepted — **amended 2026-08-01**" contains the token and matches, where Mango's
      // whole-value equality does not. That is a different question, not a wrong answer, and the
      // difference is asserted so it cannot drift into something unexplained.
      const extras = ours.filter((id) => !exact.includes(id));
      for (const id of extras) {
        const doc = await (await couch(`/docs/${encodeURIComponent(id)}`)).json();
        assert.match(
          String((doc as { status?: string }).status ?? ''),
          /Accepted/,
          `unexpected extra hit ${id} — its status does not contain the term`,
        );
      }
    });
  },
);
