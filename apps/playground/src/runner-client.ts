import type { FromWorker, ToWorker } from './protocol.js';
import type { RunResult } from './run.js';

/** The part of a `Worker` this uses, so a test can stand a fake in its place. */
export interface WorkerLike {
  postMessage(message: ToWorker): void;
  terminate(): void;
  onmessage: ((event: { readonly data: FromWorker }) => void) | null;
  onerror: ((event: { readonly message?: string }) => void) | null;
}

export const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Runs programs in a worker, one at a time, and ends a run that does not finish.
 *
 * 🔴 A worker cannot be interrupted from inside: the engine is synchronous, so a query that never
 * returns never reads the next message. The only way to stop it is to terminate the worker, so a run
 * that passes `timeoutMs` does exactly that and the next run starts a fresh one. Without it, one
 * pathological query would leave the page waiting forever.
 */
export class Runner {
  private worker: WorkerLike | undefined;
  private pending: { readonly id: number; readonly settle: (result: RunResult) => void; readonly timer: ReturnType<typeof setTimeout> } | undefined;
  private nextId = 1;

  public constructor(
    private readonly create: () => WorkerLike,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  public get running(): boolean {
    return this.pending !== undefined;
  }

  public run(source: string): Promise<RunResult> {
    if (this.pending) return Promise.reject(new Error('A run is already in progress.'));
    const worker = (this.worker ??= this.start());
    const id = this.nextId++;
    return new Promise<RunResult>((resolve) => {
      const timer = setTimeout(
        () => this.end(id, { steps: [], error: { message: `Stopped: the run took longer than ${this.timeoutMs / 1000} s.` } }, true),
        this.timeoutMs,
      );
      this.pending = { id, settle: resolve, timer };
      worker.postMessage({ type: 'run', id, source });
    });
  }

  /** Ends the current run, if any, as the user's stop. */
  public stop(): void {
    if (this.pending) this.end(this.pending.id, { steps: [], error: { message: 'Stopped.' } }, true);
  }

  private start(): WorkerLike {
    const worker = this.create();
    worker.onmessage = ({ data }) => {
      if (data.type === 'result') this.end(data.id, data.result, false);
      else this.end(data.id ?? this.pending?.id ?? -1, { steps: [], error: { message: data.message } }, true);
    };
    worker.onerror = ({ message }) => this.end(this.pending?.id ?? -1, { steps: [], error: { message: message ?? 'The worker failed.' } }, true);
    return worker;
  }

  private end(id: number, result: RunResult, discardWorker: boolean): void {
    // A late answer from a run already ended (stopped, or timed out) is ignored.
    if (this.pending?.id !== id) return;
    clearTimeout(this.pending.timer);
    const { settle } = this.pending;
    this.pending = undefined;
    if (discardWorker) {
      this.worker?.terminate();
      this.worker = undefined;
    }
    settle(result);
  }
}
