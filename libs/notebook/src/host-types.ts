/**
 * The engine host's wire protocol, as the notebook reads it: the answer of `session.run` and the diagnostics in it.
 *
 * 🔴 These are **shapes, not definitions**. The extension never imports the host, the runtime or the session package
 * (feature invariant 5; `manifest.test.ts` checks), so what the host sends is described here, and the notebook shows
 * it without interpreting TypeQLite.
 */
export interface Diagnostic {
  readonly range: { readonly start: { readonly line: number; readonly character: number }; readonly end: { readonly line: number; readonly character: number } };
  /** 1 error, 2 warning, 3 information, 4 hint: LSP's. A run's execution facts (ADR-004) are information. */
  readonly severity?: number;
  readonly code?: string;
  readonly message: string;
}

export type Row = Readonly<Record<string, string>>;

export type RunResult =
  | { readonly kind: 'rows'; readonly rows: readonly Row[]; readonly documents?: readonly unknown[]; readonly diagnostics: readonly Diagnostic[] }
  | { readonly kind: 'ok'; readonly statement: 'define' | 'write'; readonly rows: readonly Row[]; readonly documents?: readonly unknown[]; readonly diagnostics: readonly Diagnostic[] }
  | { readonly kind: 'refused'; readonly reason: string; readonly message: string; readonly diagnostics: readonly Diagnostic[] };

/** What the notebook needs of the host: one operation, answered with its data, or thrown with the host's `code`. */
export interface HostCaller {
  call<T = unknown>(operation: string, input?: Record<string, unknown>): Promise<T>;
}

export const hasCode = (error: unknown, code: string): boolean => (error as { code?: unknown } | null)?.code === code;
