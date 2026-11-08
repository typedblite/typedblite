/* eslint-disable @typescript-eslint/no-non-null-assertion -- the workload indexes fixed, non-empty arrays and timing maps it has just filled */
import { TypeDBLiteInterpreter } from '../../src/interpreter.js';
import {
  initWasmSqlite,
  openWasmSqlite,
  poolInfo,
  wipeOpfsPool,
} from '../wasm-sqlite.js';

/**
 * SPIKE — the real TypeDBLite interpreter in a browser Worker, persisting to OPFS.
 *
 * A Reader-shaped schema (bookmarks, highlights, notes, and tags attached to any of them through
 * one relation) and a small workload against it. `phase: 'write'` populates a database;
 * `phase: 'read'` runs in a LATER browser session and must find it exactly as left.
 */
declare const self: {
  onmessage: ((event: { data: Request }) => void) | null;
  postMessage(message: unknown): void;
};

interface Request {
  phase: 'write' | 'read' | 'info';
  items: number;
  tags: number;
  expected?: Counts;
}

interface Counts {
  bookmarks: number;
  highlights: number;
  notes: number;
  tags: number;
  taggings: number;
  taggedWithFirstTag: number;
}

const SCHEMA = [
  'define',
  'attribute bookmark-id, value string;',
  'attribute highlight-id, value string;',
  'attribute note-id, value string;',
  'attribute tag-name, value string;',
  'attribute body, value string;',
  'attribute created-at, value string;',
  'entity bookmark, owns bookmark-id @key, owns created-at, plays tagging:tagged;',
  'entity highlight, owns highlight-id @key, owns body, owns created-at, plays tagging:tagged;',
  'entity note, owns note-id @key, owns body, owns created-at, plays tagging:tagged;',
  'entity tag, owns tag-name @key, plays tagging:tag;',
  'relation tagging, relates tag, relates tagged;',
].join('\n');

const DB = '/reader.db';
const now = (): number => performance.now();
const ms = (from: number): number => Math.round((now() - from) * 10) / 10;

/** The same pseudo-random sequence every run, so write and read agree and runs are comparable. */
function lcg(seed: number): () => number {
  let state = seed;
  return () =>
    (state = (state * 1664525 + 1013904223) % 4294967296) / 4294967296;
}

function count(engine: TypeDBLiteInterpreter, query: string): number {
  return engine.query(query).rows.length;
}

function counts(engine: TypeDBLiteInterpreter): Counts {
  return {
    bookmarks: count(
      engine,
      'match $x isa bookmark, has bookmark-id $i; select $i;',
    ),
    highlights: count(
      engine,
      'match $x isa highlight, has highlight-id $i; select $i;',
    ),
    notes: count(engine, 'match $x isa note, has note-id $i; select $i;'),
    tags: count(engine, 'match $x isa tag, has tag-name $i; select $i;'),
    taggings: count(
      engine,
      'match $r isa tagging, links (tag: $t, tagged: $x); select $r;',
    ),
    taggedWithFirstTag: count(
      engine,
      'match $t isa tag, has tag-name "tag-0"; $r isa tagging, links (tag: $t, tagged: $x); select $r;',
    ),
  };
}

async function write(request: Request): Promise<Record<string, unknown>> {
  const timings: Record<string, number> = {};
  const clear = now();
  await wipeOpfsPool();
  timings['wipe'] = ms(clear);

  const open = now();
  const engine = new TypeDBLiteInterpreter(DB, 5000, {
    openDatabase: openWasmSqlite,
  });
  timings['openMs'] = ms(open);
  engine.define(SCHEMA);

  const rand = lcg(42);
  const tagStart = now();
  for (let t = 0; t < request.tags; t++)
    engine.execute(`insert $t isa tag, has tag-name "tag-${t}";`);
  timings['insertTagsMs'] = ms(tagStart);

  // One transaction per `execute` — the cost a Reader pays for a single "add highlight" gesture.
  const single = Math.min(200, request.items);
  const singleStart = now();
  const kinds = ['bookmark', 'highlight', 'note'] as const;
  const add = (index: number): void => {
    const kind = kinds[index % 3]!;
    const id = `${kind}-${index}`;
    const extra =
      kind === 'bookmark'
        ? ''
        : `, has body "Passage ${index}: ${'lorem ipsum '.repeat(8)}"`;
    engine.execute(
      `insert $x isa ${kind}, has ${kind}-id "${id}", has created-at "2026-10-22T10:00:00Z"${extra};`,
    );
    const tag = Math.floor(rand() * request.tags);
    engine.execute(
      `match $t isa tag, has tag-name "tag-${tag}"; $x isa ${kind}, has ${kind}-id "${id}";` +
        ' insert $r isa tagging, links (tag: $t, tagged: $x);',
    );
  };
  for (let i = 0; i < single; i++) add(i);
  timings['singleGestureMs'] = ms(singleStart);
  timings['singleGestureEach'] =
    Math.round((timings['singleGestureMs']! / single) * 100) / 100;

  // The rest inside one caller-held transaction — an import, or a sync catching up.
  const batchStart = now();
  engine.beginTransaction();
  for (let i = single; i < request.items; i++) add(i);
  engine.commitTransaction();
  timings['batchMs'] = ms(batchStart);
  timings['batchItems'] = request.items - single;

  let duplicate = 'no error';
  try {
    engine.execute(
      'insert $x isa bookmark, has bookmark-id "bookmark-0", has created-at "dup";',
    );
  } catch (error) {
    duplicate = String((error as Error).message)
      .split('\n')[0]!
      .slice(0, 160);
  }

  const queryStart = now();
  const written = counts(engine);
  timings['queryAllCountsMs'] = ms(queryStart);

  const journal = (
    engine as unknown as {
      db: { prepare(s: string): { get(): Record<string, unknown> } };
    }
  ).db
    .prepare('PRAGMA journal_mode')
    .get();
  engine.close();
  return {
    phase: 'write',
    timings,
    counts: written,
    duplicateKeyRefusal: duplicate,
    journalMode: journal,
  };
}

async function read(request: Request): Promise<Record<string, unknown>> {
  const timings: Record<string, number> = {};
  const open = now();
  const engine = new TypeDBLiteInterpreter(DB, 5000, {
    openDatabase: openWasmSqlite,
  });
  timings['coldOpenMs'] = ms(open);
  const hasSchema = engine.hasSchema;
  const queryStart = now();
  const found = counts(engine);
  timings['queryAllCountsMs'] = ms(queryStart);
  engine.close();
  const expected = request.expected;
  const matches =
    expected !== undefined &&
    JSON.stringify(expected) === JSON.stringify(found);
  return {
    phase: 'read',
    hasSchema,
    timings,
    counts: found,
    matchesWhatWasWritten: matches,
  };
}

self.onmessage = async (event) => {
  try {
    await initWasmSqlite({
      moduleOptions: { locateFile: (file: string) => `/${file}` },
      sahPool: {
        name: 'typedblite-spike',
        directory: '/typedblite-spike',
        clearOnInit: false,
      },
    });
    const request = event.data;
    const result =
      request.phase === 'write' ? await write(request) : await read(request);
    const storage = await navigator.storage.estimate();
    self.postMessage({
      ok: true,
      result,
      pool: poolInfo(),
      storageUsage: storage.usage,
      isolated: crossOriginIsolated,
    });
  } catch (error) {
    const e = error as Error;
    self.postMessage({
      ok: false,
      error: `${e.name}: ${e.message}`,
      stack: String(e.stack).slice(0, 1200),
    });
  }
};

declare const navigator: {
  storage: { estimate(): Promise<{ usage?: number }> };
};
declare const crossOriginIsolated: boolean;
