/** What the page asks of the kernel worker, and what comes back. Plain data, so it survives `postMessage`. */
export interface KernelRequest {
  readonly id: number;
  readonly operation: string;
  readonly input: Record<string, unknown>;
}

export type KernelReply =
  | { readonly id: number; readonly ok: true; readonly data: unknown }
  /** A refusal of the operation (an unknown session), with a `code` to branch on, or a failure of the worker itself. */
  | { readonly id: number; readonly ok: false; readonly code: string; readonly message: string };
