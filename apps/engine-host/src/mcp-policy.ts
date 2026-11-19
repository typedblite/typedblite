import { existsSync } from 'node:fs';

import type { CqrsToolRuntime, ToolOperationDescriptor } from '@devx-micro/app-runtime';

/**
 * Which operations an agent may call.
 *
 * 🔴 **MCP is read-only unless told otherwise** (feature invariant 8, ADR-011 D8). A host that holds real stores
 * must not let an agent write to one by default, so the `read` tier is what `--mcp` and `--mcp-http` serve, and the
 * `write` tier is opt-in with `--mcp-write`.
 */
export type McpTier = 'read' | 'write';

/**
 * The read tier's operations. Everything else changes a session or a store: `session.open` can create a file or
 * apply a schema, and begin, commit, rollback, restart and close act on a session. `session.run` is here because it
 * is the useful one, and it is restricted: see {@link checkCall}.
 */
export const READ_TIER = ['session.list', 'session.get', 'schema.get', 'statement.classify', 'statement.split', 'session.run'] as const;

/**
 * Operations that are never tools, in either tier. `session.debug` is the debugger's (ADR-014 B2): an agent has
 * `session.run`, and a recording is for a person stepping through it.
 */
export const NOT_TOOLS = ['session.debug'] as const;

/** The operations to offer as tools in a tier. Only an operation that declares an input schema can be a tool. */
export function toolsFor(tier: McpTier, operations: readonly ToolOperationDescriptor<any>[]): ToolOperationDescriptor<any>[] {
  return operations.filter(
    (operation) =>
      operation.inputSchema !== undefined &&
      !(NOT_TOOLS as readonly string[]).includes(operation.name) &&
      (tier === 'write' || (READ_TIER as readonly string[]).includes(operation.name)),
  );
}

export type CallCheck = { readonly allowed: true } | { readonly allowed: false; readonly message: string };

const refuse = (message: string): CallCheck => ({ allowed: false, message });

/**
 * Whether a call to a tool in the offered tier may go ahead.
 *
 * In the read tier, `session.run` runs only a statement the host's own classifier calls a **read**. That is the
 * classifier the execution route uses (invariant 3): a `read` is run by the interpreter's `query`, which cannot
 * write, so what is allowed here and what is run are one decision, not two that can disagree. `define`, `write`,
 * and a statement the classifier would send elsewhere are refused. Where it errs, it errs towards refusing (a
 * comment that mentions `insert` classifies as a write).
 *
 * Given a `location`, `session.run` opens the store, and opening a path that does not exist creates a file. The
 * read tier refuses one that is not already there. An existing store is left byte for byte as it was by an open
 * and a read (measured, 2026-11-19).
 *
 * Input that `validate` would refuse is let through, so the caller gets the validator's own message.
 */
export async function checkCall(tier: McpTier, runtime: CqrsToolRuntime, name: string, input: Record<string, unknown>): Promise<CallCheck> {
  if (tier === 'write' || name !== 'session.run') return { allowed: true };

  const { statement, location } = input;
  if (typeof statement === 'string') {
    const classified = await runtime.dispatch('statement.classify', { statement });
    const kind = (classified.data as { kind?: string } | undefined)?.kind;
    if (kind !== 'read') {
      return refuse(`The read tier runs reads only, and this statement is a ${kind ?? 'statement it could not classify'}. Start the host with --mcp-write to allow writes.`);
    }
  }
  if (typeof location === 'string' && location !== ':memory:' && !existsSync(location)) {
    return refuse(`The read tier does not create stores, and '${location}' does not exist. Start the host with --mcp-write to allow it.`);
  }
  return { allowed: true };
}
