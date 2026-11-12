import { Worker } from 'node:worker_threads';
import { DiagnosticCode, TypeDBLiteValue, attachDiagnostic, type GivenRows, type JsonValue } from '@typedblite/runtime';
import type { AnswerRow, Engine, EngineAnswers } from './world.js';

/**
 * A live TypeDB as an `Engine` — so the SAME steps, World and spec that score TypeDBLite are run
 * against TypeDB itself (ADR-005's differential oracle). A scenario TypeDB fails is not evidence
 * against TypeDBLite; one TypeDB passes and TypeDBLite fails is a real gap.
 *
 * Driven over TypeDB's HTTP API (`/v1/…`, TypeDB 3.x). ⚠️ The harness is synchronous and HTTP is
 * not, so each request runs in a worker and this thread waits on it with `Atomics.wait` — slow, and
 * only ever for an oracle run, never the routine suite.
 *
 * What it cannot do, and so fails honestly rather than guesses: given rows (the HTTP API takes
 * none), and TypeDB's own numbering of a given row's iid cell.
 */

const WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const signal = new Int32Array(workerData.signal);
const data = new Uint8Array(workerData.data);
parentPort.on('message', async ({ url, method, headers, body }) => {
  let out;
  try {
    const response = await fetch(url, { method, headers, body });
    out = JSON.stringify({ status: response.status, text: await response.text() });
  } catch (error) {
    out = JSON.stringify({ status: 0, text: String(error) });
  }
  let bytes = Buffer.from(out);
  if (bytes.length > data.length) bytes = Buffer.from(JSON.stringify({ status: 0, text: 'response too large for the oracle buffer' }));
  data.set(bytes);
  Atomics.store(signal, 1, bytes.length);
  Atomics.store(signal, 0, 1);
  Atomics.notify(signal, 0);
});
`;

/** Synchronous HTTP: one worker, one shared buffer, one request at a time. */
class SyncHttp {
  private readonly signal = new Int32Array(new SharedArrayBuffer(8));
  private readonly data = new Uint8Array(new SharedArrayBuffer(64 * 1024 * 1024));
  private readonly worker: Worker;

  constructor() {
    this.worker = new Worker(WORKER, { eval: true, workerData: { signal: this.signal.buffer, data: this.data.buffer } });
    this.worker.unref();
  }

  /**
   * ⚠️ TypeDB 3.10.4 PANICS on some spec queries and exits (`executor/instruction/checker.rs:1168`,
   * "Check variables without an extractor must have been recorded in the row"). Run the container with
   * `--restart always`: an unreachable server is waited for, up to a minute, and the request that
   * crashed it fails its scenario rather than the rest of the run.
   */
  request(method: string, url: string, headers: Record<string, string>, body?: unknown): { status: number; json: unknown } {
    const deadline = Date.now() + 60_000;
    for (;;) {
      try {
        return this.once(method, url, headers, body);
      } catch (error) {
        if (!String(error).includes('TypeDB unreachable') || Date.now() > deadline) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
      }
    }
  }

  private once(method: string, url: string, headers: Record<string, string>, body?: unknown): { status: number; json: unknown } {
    Atomics.store(this.signal, 0, 0);
    this.worker.postMessage({ url, method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (Atomics.wait(this.signal, 0, 0, 120_000) === 'timed-out') throw new Error(`TypeDB did not answer ${method} ${url} in 120 s`);
    const length = Atomics.load(this.signal, 1);
    const { status, text } = JSON.parse(Buffer.from(this.data.subarray(0, length)).toString('utf8')) as { status: number; text: string };
    if (status === 0) throw new Error(`TypeDB unreachable: ${text}`);
    return { status, json: text === '' ? undefined : JSON.parse(text) };
  }

  terminate(): void {
    void this.worker.terminate();
  }
}

export interface OracleOptions {
  readonly url?: string;
  readonly username?: string;
  readonly password?: string;
}

/** One HTTP client and token for a whole run, shared by every database it opens. */
export class TypeDBServer {
  private readonly http = new SyncHttp();
  private token: string;
  private counter = 0;
  readonly url: string;

  constructor(private readonly options: OracleOptions = {}) {
    this.url = options.url ?? 'http://localhost:8000';
    this.token = this.signIn();
  }

  private signIn(): string {
    const { status, json } = this.http.request('POST', `${this.url}/v1/signin`, { 'content-type': 'application/json' }, {
      username: this.options.username ?? 'admin',
      password: this.options.password ?? 'password',
    });
    if (status !== 200) throw new Error(`TypeDB sign-in failed (${status}): ${JSON.stringify(json)}`);
    return (json as { token: string }).token;
  }

  /** A request; a 401 signs in again once (tokens expire during a long run). */
  call(method: string, path: string, body?: unknown): unknown {
    for (let attempt = 0; ; attempt += 1) {
      const { status, json } = this.http.request(method, `${this.url}${path}`, { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' }, body);
      if (status === 401 && attempt === 0) {
        this.token = this.signIn();
        continue;
      }
      if (status >= 200 && status < 300) return json;
      const failure = (json ?? {}) as { code?: string; message?: string };
      const message = failure.message ?? `HTTP ${status}`;
      // TypeDB's parse failures are `TQL…` — what `; parsing fails` reads as `parseFailed`.
      const code = failure.code?.startsWith('TQL') ? DiagnosticCode.parseFailed : `typedb.${failure.code ?? status}`;
      throw attachDiagnostic(new Error(message), { code, message, severity: 1, source: 'typedb' } as never);
    }
  }

  open(): Engine {
    this.counter += 1;
    return new TypeDBEngine(this, `oracle_${process.pid}_${this.counter}`);
  }

  close(): void {
    this.http.terminate();
  }
}

interface Concept {
  readonly kind: string;
  readonly iid?: string;
  readonly label?: string;
  readonly type?: { readonly label: string; readonly valueType?: string };
  readonly value?: unknown;
  readonly valueType?: string;
}

interface QueryAnswer {
  readonly answerType: 'ok' | 'conceptRows' | 'conceptDocuments';
  readonly answers: ReadonlyArray<unknown> | null;
}

class TypeDBEngine implements Engine {
  private transaction: string | undefined;
  /** TypeDB's hex iids, numbered for the harness's cells — and back, for `has` and templates. */
  private readonly numbers = new Map<string, number>();
  private readonly iids = new Map<number, string>();

  constructor(private readonly server: TypeDBServer, private readonly name: string) {
    server.call('POST', `/v1/databases/${name}`);
  }

  private run(text: string, kind: 'schema' | 'write' | 'read'): QueryAnswer {
    if (this.transaction !== undefined) return this.server.call('POST', `/v1/transactions/${this.transaction}/query`, { query: text }) as QueryAnswer;
    // No transaction of the harness's open — a read transaction, which reads what is committed.
    return this.server.call('POST', '/v1/query', { databaseName: this.name, transactionType: kind, query: text, commit: kind !== 'read' }) as QueryAnswer;
  }

  private numberOf(iid: string): number {
    let n = this.numbers.get(iid);
    if (n === undefined) {
      n = this.numbers.size + 1;
      this.numbers.set(iid, n);
      this.iids.set(n, iid);
    }
    return n;
  }

  private text(value: unknown): string {
    return typeof value === 'string' ? value : JSON.stringify(value);
  }

  private cell(concept: Concept): TypeDBLiteValue {
    switch (concept.kind) {
      case 'entity':
        return TypeDBLiteValue.entity(this.numberOf(concept.iid ?? ''), concept.type?.label ?? '');
      case 'relation':
        return TypeDBLiteValue.relation(this.numberOf(concept.iid ?? ''), concept.type?.label ?? '');
      case 'attribute':
        return TypeDBLiteValue.attribute(concept.type?.label ?? '', this.text(concept.value));
      case 'value':
        return TypeDBLiteValue.value(concept.valueType ?? 'string', this.text(concept.value));
      default:
        return TypeDBLiteValue.type(concept.label ?? '');
    }
  }

  private answers(result: QueryAnswer, fact: string): EngineAnswers {
    const diagnostics = [{ code: fact, message: 'ran on TypeDB', severity: 3, source: 'typedb' }] as never;
    if (result.answerType === 'conceptDocuments') return { rows: [], documents: (result.answers ?? []) as JsonValue[], diagnostics };
    const rows = ((result.answers ?? []) as Array<{ data: Record<string, Concept | null> }>).map((answer) => {
      const row: AnswerRow = {};
      for (const [variable, concept] of Object.entries(answer.data)) if (concept) row[variable] = this.cell(concept);
      return row;
    });
    return { rows, diagnostics };
  }

  define(text: string): unknown {
    return this.run(text, 'schema');
  }

  execute(text: string, given?: GivenRows): EngineAnswers {
    if (given !== undefined) throw new Error('the TypeDB oracle cannot pass given rows over HTTP');
    return this.answers(this.run(text, 'write'), DiagnosticCode.wrote);
  }

  query(text: string, given?: GivenRows): EngineAnswers {
    if (given !== undefined) throw new Error('the TypeDB oracle cannot pass given rows over HTTP');
    return this.answers(this.run(text, 'read'), DiagnosticCode.projected);
  }

  beginTransaction(kind: 'schema' | 'write' = 'write'): void {
    this.rollbackTransaction();
    const opened = this.server.call('POST', '/v1/transactions/open', { databaseName: this.name, transactionType: kind }) as { transactionId: string };
    this.transaction = opened.transactionId;
  }

  commitTransaction(): void {
    const id = this.transaction;
    this.transaction = undefined;
    if (id !== undefined) this.server.call('POST', `/v1/transactions/${id}/commit`);
  }

  rollbackTransaction(): void {
    const id = this.transaction;
    this.transaction = undefined;
    if (id === undefined) return;
    try {
      this.server.call('POST', `/v1/transactions/${id}/close`);
    } catch {
      // Already closed by the server, after a failed query.
    }
  }

  close(): void {
    this.rollbackTransaction();
    try {
      this.server.call('DELETE', `/v1/databases/${this.name}`);
    } catch {
      // Gone already.
    }
  }

  attributeValueType(attribute: string): string | undefined {
    const result = this.run(`match attribute $t; $t label ${attribute};`, 'read');
    const first = (result.answers?.[0] as { data?: { t?: { valueType?: string } } } | undefined)?.data?.t;
    return first?.valueType;
  }

  attributesOf(iid: number, attribute: string): ReadonlyArray<TypeDBLiteValue> {
    const hex = this.iids.get(iid);
    if (hex === undefined) return [];
    return this.query(`match $x iid ${hex}; $x has ${attribute} $a; select $a;`).rows.map((row) => row.a);
  }

  thingNumbered(): number | undefined {
    return undefined;
  }

  iidText(cell: TypeDBLiteValue): string {
    return (cell.isThing() ? this.iids.get(cell.iid) : undefined) ?? cell.iidHex;
  }
}
