/**
 * SPIKE: one TypeDBLite store per Durable Object, reached over HTTP through a Worker.
 *
 * `/store/<name>/<operation>` routes to the object named `<name>`. The operations are the engine's own calls
 * (`define`, `execute`, `query`), plus what the spike needs to measure: `program` runs a whole TypeQLite program
 * through the playground's runner, `search` uses the full-text index, and `stats` reports what the binding saw.
 *
 * Over HTTP is how a CQRS app in a Container would reach it: a Container has no bindings of its own, so it calls a
 * Worker, which calls the object. Each request is one or more engine calls, each its own platform transaction.
 */
import { DurableObject } from 'cloudflare:workers';
import { TypeDBLiteInterpreter } from '@typedblite/runtime';
import { runProgram, type Engine } from '../../../apps/playground/src/run.js';
import { DurableObjectSqlite, type DurableObjectStorageLike } from './durable-object-sqlite.js';

interface Env {
  readonly STORE: {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(request: Request): Promise<Response> };
  };
}

type Message = string | { readonly value: string };
const textOf = (message: Message): string => (typeof message === 'string' ? message : message.value);

/** An answer as plain JSON: each value by its `toString()`, as the playground draws it. */
function plain(answer: {
  readonly rows?: ReadonlyArray<Record<string, { toString(): string }>>;
  readonly diagnostics?: readonly { readonly message: Message }[];
}): unknown {
  return {
    rows: (answer.rows ?? []).map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, String(v)]))),
    diagnostics: (answer.diagnostics ?? []).map((d) => textOf(d.message)),
  };
}

export class TypeDBLiteStore extends DurableObject<Env> {
  private readonly sqlite: DurableObjectSqlite;
  private readonly engine!: TypeDBLiteInterpreter;
  private readonly startupError?: unknown;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sqlite = new DurableObjectSqlite(ctx.storage as unknown as DurableObjectStorageLike);
    // Opening runs the store's migrations, which open transactions of their own.
    try {
      this.engine = this.sqlite.unitOfWork(
        () => new TypeDBLiteInterpreter('durable-object', undefined, { openDatabase: () => this.sqlite }),
      );
    } catch (error) {
      this.startupError = error;
    }
  }

  /** The engine as the playground's runner wants it, each call one unit of work. */
  private asEngine(): Engine {
    const { engine, sqlite } = this;
    return {
      get hasSchema() {
        return engine.hasSchema;
      },
      define: (text) => sqlite.unitOfWork(() => engine.define(text)) as ReturnType<Engine['define']>,
      execute: (text) => sqlite.unitOfWork(() => engine.execute(text)) as ReturnType<Engine['execute']>,
      query: (text) => sqlite.unitOfWork(() => engine.query(text)) as ReturnType<Engine['query']>,
      close: () => undefined,
    };
  }

  override async fetch(request: Request): Promise<Response> {
    const operation = new URL(request.url).pathname.split('/').pop();
    const body = request.method === 'POST' ? ((await request.json()) as { text?: string; limit?: number }) : {};
    const text = body.text ?? '';
    const before = this.sqlite.stats.statements;
    try {
      if (this.startupError) throw this.startupError;
      let result: unknown;
      switch (operation) {
        case 'define':
          result = plain(this.sqlite.unitOfWork(() => this.engine.define(text)) as never);
          break;
        case 'execute':
          result = plain(this.sqlite.unitOfWork(() => this.engine.execute(text)) as never);
          break;
        case 'query':
          result = plain(this.sqlite.unitOfWork(() => this.engine.query(text)) as never);
          break;
        case 'program':
          result = runProgram(text, () => this.asEngine());
          break;
        case 'transaction': {
          // Several writes as one platform transaction: what `SqliteEngine.transaction(work)` becomes when the
          // caller is across a network and cannot hold a transaction open between requests.
          const statements = (body as { statements?: string[] }).statements ?? [];
          result = this.sqlite.unitOfWork(() => statements.map((s) => plain(this.engine.execute(s) as never)));
          break;
        }
        case 'search':
          result = this.engine.changeLog.fullText.search(text, body.limit ?? 50);
          break;
        case 'stats':
          result = {
            ...this.sqlite.stats,
            databaseSize: this.ctx.storage.sql.databaseSize,
            changeLogRows: Number(
              this.sqlite.run('SELECT count(*) AS n FROM change_log').toArray()[0]?.['n'] ?? 0,
            ),
          };
          break;
        default:
          return Response.json({ error: `Unknown operation '${operation}'.` }, { status: 404 });
      }
      return Response.json({ ok: true, result, statements: this.sqlite.stats.statements - before });
    } catch (error) {
      const e = error as Error & { errcode?: number; code?: string; sql?: string };
      return Response.json(
        {
          ok: false,
          error: { name: e.name, message: e.message, errcode: e.errcode, code: e.code, sql: e.sql, startup: error === this.startupError },
          statements: this.sqlite.stats.statements - before,
        },
        { status: 422 },
      );
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const match = /^\/store\/([\w-]+)\/(\w+)$/.exec(new URL(request.url).pathname);
    if (!match) return new Response('Use /store/<name>/<operation>.', { status: 404 });
    return env.STORE.get(env.STORE.idFromName(match[1]!)).fetch(request);
  },
};
