import { Session, splitStatements } from '@typedblite/session';

export { splitStatements };

/** What running a chunk of TypeQLite produced, in a shape both the REPL and the CLI can render. */
export type Outcome =
  | { kind: 'rows'; rows: ReadonlyArray<Record<string, string>> }
  | { kind: 'ok'; statement: 'define' | 'write' }
  | { kind: 'error'; message: string };

/**
 * A TypeQLite session for the shells: `@typedblite/session`'s `Session`, with its answers reduced to the
 * three outcomes the REPL and the CLI print.
 *
 * 🔴 The statement classifier, the transactions and the refusals live in `@typedblite/session`, which the
 * engine host shares, so neither the shells nor the host owns what a statement means. What stays here is the
 * wording only a shell can use: the hint to load a schema with `--file`.
 */
export class TypeDBLiteSession {
  private readonly session: Session;

  constructor(location = ':memory:') {
    this.session = new Session(location);
  }

  /** Asks the ENGINE, not a local flag — a file-backed database reopened in a new process
   * already has its schema, and a flag here would say otherwise. */
  get hasSchema(): boolean {
    return this.session.hasSchema;
  }

  async run(source: string): Promise<Outcome> {
    const result = await this.session.run(source);
    switch (result.kind) {
      case 'rows':
        return { kind: 'rows', rows: result.rows };
      case 'ok':
        return { kind: 'ok', statement: result.statement };
      case 'refused':
        // Returned, never thrown: a REPL that dies on a typo is unusable.
        return {
          kind: 'error',
          message: result.reason === 'no-schema' ? `${result.message}, or load one with --file` : result.message,
        };
    }
  }

  async close(): Promise<void> {
    await this.session.close();
  }
}
