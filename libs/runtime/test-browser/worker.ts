/**
 * The worker the Chromium test drives: the real engine, through the package's public entry points
 * only — `@typedblite/runtime` under the `browser` condition, and `@typedblite/runtime/wasm`.
 */
import { TypeDBLiteInterpreter, diagnosticOf } from '@typedblite/runtime';
import { initWasmSqlite, openWasmSqlite, poolInfo } from '@typedblite/runtime/wasm';

const SCHEMA = `
  define
    entity note, owns note-id @key, owns body;
    attribute note-id, value string;
    attribute body, value string;
`;

type Request = { type: 'write'; notes: Array<[string, string]> } | { type: 'read' } | { type: 'duplicate' };

let db: TypeDBLiteInterpreter | undefined;

async function open(): Promise<TypeDBLiteInterpreter> {
  if (db) return db;
  await initWasmSqlite({
    moduleOptions: { locateFile: (file: string) => `/${file}` },
    sahPool: { name: 'typedblite-test', directory: '/typedblite-test' },
  });
  db = new TypeDBLiteInterpreter('/notes.db', undefined, { openDatabase: openWasmSqlite });
  db.define(SCHEMA); // on every open, as the product does
  return db;
}

self.onmessage = async (event: MessageEvent<Request>) => {
  try {
    const store = await open();
    const request = event.data;
    if (request.type === 'write') {
      for (const [id, body] of request.notes) store.execute(`insert $n isa note, has note-id "${id}", has body "${body}";`);
    }
    if (request.type === 'duplicate') {
      try {
        store.execute(`insert $n isa note, has note-id "n1", has body "again";`);
        self.postMessage({ ok: true, refused: false });
      } catch (error) {
        self.postMessage({ ok: true, refused: true, code: diagnosticOf(error)?.code, message: (error as Error).message });
      }
      return;
    }
    const rows = store.query(`match $n isa note, has note-id $i, has body $b; select $i, $b; sort $i;`).rows;
    self.postMessage({
      ok: true,
      notes: rows.map((row) => [row.i.asString(), row.b.asString()]),
      revisions: store.changeLog.since(0, 1000).map((record) => [record.entityId, record.rev]),
      pool: poolInfo(),
      groupBy: typeof (Object as { groupBy?: unknown }).groupBy,
    });
  } catch (error) {
    self.postMessage({ ok: false, message: String((error as Error)?.stack ?? error) });
  }
};
