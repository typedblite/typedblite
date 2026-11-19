import { SidecarClient, type SidecarClientOptions, type SidecarEnvelope } from '@devx-micro/app-sidecar';

import { MIN_NODE, probeNode, type NodeProbe } from './probe-node.js';

/** An envelope the host answered. A fault in the operation is an envelope with `status: 'error'`, not a throw. */
export type HostEnvelope = SidecarEnvelope & { readonly operation?: string; readonly exitCode?: number };

/** The host could not be started or reached: no suitable `node`, or the process died. Nothing was run. */
export class HostUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostUnavailableError';
  }
}

/** The host answered, and the operation failed. `code` is the host's own (`SESSION_NOT_FOUND`), to branch on. */
export class HostRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly operation: string,
  ) {
    super(message);
    this.name = 'HostRequestError';
  }
}

/** The part of {@link SidecarClient} this uses, so a spec can stand in for the process. */
export interface SidecarLike {
  start(): void;
  stop(): Promise<void>;
  request(request: { operation: string; input?: Record<string, unknown> }): Promise<SidecarEnvelope>;
}

export interface HostClientOptions {
  /** The bundled host: `out/host/sidecar.cjs` in the installed extension. */
  readonly sidecarPath: string;
  /** The `node` the user chose (`typedblite.host.node`), or nothing for the one on PATH. Read at each start. */
  readonly configuredNode: () => string | undefined;
  readonly probe?: (command: string) => Promise<NodeProbe>;
  readonly createClient?: (options: SidecarClientOptions) => SidecarLike;
}

/**
 * The editor's way to the engine host: it starts the host as a process, over the sidecar, and sends it operations.
 *
 * 🔴 **The extension never imports the host** (feature invariant 6). It runs the host's bundle with a `node` it
 * found, so a statement is run by the host and nowhere else. Starting is lazy: the host is not a cost of opening a
 * `.tql` file, only of using it.
 *
 * The host's sessions live in its process, so if the process dies they are gone. The next request starts a new one,
 * and a session id from before answers `SESSION_NOT_FOUND`: a consumer treats that as "reopen".
 */
export class HostClient {
  private client: SidecarLike | undefined;
  private starting: Promise<SidecarLike> | undefined;

  constructor(private readonly options: HostClientOptions) {}

  /** One operation. The envelope is returned whether it succeeded or failed; only an unreachable host throws. */
  async request(operation: string, input: Record<string, unknown> = {}): Promise<HostEnvelope> {
    const client = await this.ensureStarted();
    try {
      return (await client.request({ operation, input })) as HostEnvelope;
    } catch (error) {
      // The process died, or never answered. Forget it, so the next request starts a fresh one.
      await this.stop();
      throw new HostUnavailableError(`The TypeDBLite engine host stopped answering: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** One operation's data. A fault throws a {@link HostRequestError} carrying the host's code. */
  async call<T = unknown>(operation: string, input: Record<string, unknown> = {}): Promise<T> {
    const envelope = await this.request(operation, input);
    if (envelope.status !== 'success') {
      throw new HostRequestError(envelope.error?.code ?? 'HANDLER_FAILURE', envelope.error?.message ?? `${operation} did not succeed`, operation);
    }
    return envelope.data as T;
  }

  /** Ends the host process. The next request starts another. */
  async stop(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.starting = undefined;
    await client?.stop().catch(() => undefined);
  }

  dispose(): void {
    void this.stop();
  }

  private ensureStarted(): Promise<SidecarLike> {
    if (this.client) return Promise.resolve(this.client);
    // One start at a time: two requests arriving together must not spawn two hosts.
    this.starting ??= this.start().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async start(): Promise<SidecarLike> {
    const configured = this.options.configuredNode()?.trim();
    const command = configured || 'node';
    const probe = await (this.options.probe ?? probeNode)(command);
    if (!probe.ok) {
      throw new HostUnavailableError(
        `${probe.reason}. The TypeDBLite engine host needs Node ${MIN_NODE.major}.${MIN_NODE.minor} or newer with node:sqlite. ` +
          (configured ? "Fix the 'typedblite.host.node' setting, or clear it to use the node on PATH." : "Put one on PATH, or set 'typedblite.host.node' to its path."),
      );
    }
    const client = (this.options.createClient ?? ((options) => new SidecarClient(options)))({ command, args: [this.options.sidecarPath] });
    client.start();
    this.client = client;
    return client;
  }
}
