import type { RunResult } from './run.js';

/** What the page asks of the worker, and what comes back. Plain data, so it survives `postMessage`. */
export type ToWorker = { readonly type: 'run'; readonly id: number; readonly source: string };

export type FromWorker =
  | { readonly type: 'result'; readonly id: number; readonly result: RunResult }
  /** The worker could not run at all, such as SQLite's WASM failing to load. */
  | { readonly type: 'fatal'; readonly id?: number; readonly message: string };
