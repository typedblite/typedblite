/* eslint-disable @typescript-eslint/no-non-null-assertion -- `worker` is set before any message is sent to it, and a `res` envelope always carries its reply */
/**
 * SPIKE — one database owner across many tabs.
 *
 * The OPFS SAH pool holds exclusive file handles, so only ONE worker in the whole origin can have
 * the database open. This module makes whichever tab wins a Web Lock that worker's host:
 *
 *   - every tab asks `navigator.locks` for `typedblite-owner`; exactly one is granted it and keeps
 *     it until the tab dies, which is what releases it for the next waiter;
 *   - the winner spawns `owner-worker.js` and serves requests from the other tabs;
 *   - the others send requests over a BroadcastChannel and retry until an owner answers, so a tab
 *     that closes (or crashes) is a pause, not a failure.
 *
 * Web Locks and BroadcastChannel were chosen over SharedWorker deliberately: SharedWorker support
 * in mobile WebViews is the less certain of the two. Neither is tested in a WebView here.
 *
 * 🔴 Delivery is AT LEAST ONCE. A request whose owner died after applying it but before replying is
 * retried against the next owner, so a write can be applied twice. The tests below use keyed
 * inserts and treat a repeat key violation on a retried request as "already applied"; a real
 * design needs an idempotency key stored in the same transaction as the write.
 */
const LOCK = 'typedblite-owner';
const CHANNEL = 'typedblite-rpc';
// `ping` has no key: a write with no natural key is the case at-least-once delivery cannot detect.
const SCHEMA = `define
  entity bookmark, owns bookmark-id @key, owns created-at;
  entity ping, owns created-at;
  attribute bookmark-id, value string;
  attribute created-at, value string;`;

interface Message {
  op: string;
  text?: string;
  requestId?: string;
  wipe?: boolean;
  schema?: string;
}
interface Reply {
  ok: boolean;
  error?: string;
  rows?: Array<Record<string, unknown>>;
  hadSchema?: boolean;
  attempts?: number;
  duplicate?: boolean;
}
interface Envelope {
  kind: 'req' | 'res';
  id: string;
  from?: string;
  to?: string;
  message?: Message;
  reply?: Reply;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

class Tab {
  readonly id = crypto.randomUUID().slice(0, 8);
  role: 'candidate' | 'owner' = 'candidate';
  /** Epoch ms at which this tab finished opening the database as owner. */
  ownerReadyAt?: number;
  /** How many times opening the pool had to be retried while the previous owner's handles drained. */
  initRetries = 0;
  readonly stats = { served: 0, retried: 0, maxLatencyMs: 0, requests: 0 };

  private worker?: Worker;
  private ready?: Promise<void>;
  private nextLocal = 0;
  private nextRemote = 0;
  private readonly local = new Map<number, (reply: Reply) => void>();
  private readonly remote = new Map<string, (reply: Reply) => void>();
  private readonly channel = new BroadcastChannel(CHANNEL);
  /** Resolves the lock callback, which releases the lock. Set while this tab is the owner. */
  private yieldLock?: () => void;
  private watchdog?: ReturnType<typeof setInterval>;
  /** How many times this tab gave up an owner role because its database Worker stopped answering. */
  abandoned = 0;

  constructor(
    /** A request to start from an empty database. Honoured at most once, and only by the first tab. */
    private wipe: boolean,
    private readonly watchdogMs: number,
    private readonly idempotent: boolean,
  ) {
    this.channel.onmessage = (event: MessageEvent<Envelope>) =>
      this.onChannel(event.data);
    this.queueForLock();
  }

  /**
   * Wait for the lock; when granted, own the database until the tab dies or the Worker stops
   * answering. If the role is given up the tab goes back in the queue instead of staying out.
   */
  private queueForLock(): void {
    // A wipe means "start from an empty database". That is only safe for the tab that finds no owner
    // at all, so ask for the lock only if it is free right now; if another tab already owns the
    // database, drop the request and wait in the ordinary queue instead. Without this, a tab opened
    // with ?wipe=1 would wipe a database in use whenever it later took over ownership.
    const options: LockOptions = this.wipe ? { ifAvailable: true } : {};
    navigator.locks
      .request(LOCK, options, async (lock) => {
        if (lock === null) {
          this.wipe = false;
          console.info(
            'TypeDBLite: ?wipe=1 was ignored because another tab already has the database open. ' +
              'Close the other tabs and reload with ?wipe=1 to start from an empty database.',
          );
          return;
        }
        this.role = 'owner';
        this.ownerReadyAt = undefined;
        this.ready = this.open();
        await this.ready;
        this.startWatchdog();
        await new Promise<void>((resolve) => {
          this.yieldLock = resolve;
        });
      })
      .catch(() => sleep(1000))
      .then(() => {
        this.role = 'candidate';
        this.queueForLock();
      });
  }

  /**
   * The owner tab pings its own Worker. A Worker that is dead, or stuck in one statement for longer
   * than `watchdogMs`, never answers; the tab then terminates it (which frees the OPFS handles — a
   * crash mid-transaction rolls back, see run-crash.mjs) and releases the lock for another tab.
   * 🔴 A legitimate operation longer than `watchdogMs` is indistinguishable from a hang and is killed.
   */
  private startWatchdog(): void {
    let lastAnswer = Date.now();
    let inFlight = false;
    this.watchdog = setInterval(() => {
      if (!inFlight) {
        inFlight = true;
        void this.toWorker({ op: 'info' }).then((reply) => {
          inFlight = false;
          if (reply.ok) lastAnswer = Date.now();
        });
      }
      if (Date.now() - lastAnswer > this.watchdogMs) this.abandon();
    }, 500);
  }

  private abandon(): void {
    clearInterval(this.watchdog);
    this.abandoned++;
    this.worker?.terminate();
    for (const done of this.local.values())
      done({ ok: false, error: 'ABANDONED' });
    this.local.clear();
    this.yieldLock?.();
  }

  private async open(): Promise<void> {
    // The previous owner's worker is torn down with its tab; its file handles can outlive the lock
    // by a moment, so a refused open is retried. 🔴 Each retry needs a FRESH Worker: after a failed
    // open the SAH-pool module inside a Worker keeps returning the same rejected promise.
    const wipeNow = this.wipe;
    this.wipe = false; // once only: a later takeover, or a re-queue, must never wipe
    for (let attempt = 0; ; attempt++) {
      this.worker?.terminate();
      this.worker = new Worker('/owner-worker.js', { type: 'module' });
      this.worker.onmessage = (event: MessageEvent<Reply & { id: number }>) => {
        const done = this.local.get(event.data.id);
        this.local.delete(event.data.id);
        done?.(event.data);
      };
      const reply = await this.toWorker({
        op: 'init',
        wipe: wipeNow && attempt === 0,
        schema: SCHEMA,
      });
      if (reply.ok) break;
      if (attempt >= 300)
        throw new Error(`owner could not open the database: ${reply.error}`);
      this.initRetries++;
      await sleep(100);
    }
    this.ownerReadyAt = Date.now();
  }

  private toWorker(message: Message): Promise<Reply> {
    return new Promise((resolve) => {
      const id = ++this.nextLocal;
      this.local.set(id, resolve);
      this.worker!.postMessage({ id, ...message });
    });
  }

  private onChannel(envelope: Envelope): void {
    if (
      envelope.kind === 'req' &&
      this.role === 'owner' &&
      envelope.message !== undefined
    ) {
      void (async () => {
        await this.ready;
        const reply = await this.toWorker(envelope.message!);
        if (reply.error === 'ABANDONED') return; // no answer: the sender times out and finds the next owner
        this.stats.served++;
        this.channel.postMessage({
          kind: 'res',
          id: envelope.id,
          to: envelope.from,
          reply,
        } satisfies Envelope);
      })();
    } else if (envelope.kind === 'res' && envelope.to === this.id) {
      const done = this.remote.get(envelope.id);
      this.remote.delete(envelope.id);
      done?.(envelope.reply!);
    }
  }

  private askOwner(
    message: Message,
    timeoutMs: number,
  ): Promise<Reply | undefined> {
    const id = `${this.id}-${++this.nextRemote}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.remote.delete(id);
        resolve(undefined);
      }, timeoutMs);
      this.remote.set(id, (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
      this.channel.postMessage({
        kind: 'req',
        id,
        from: this.id,
        message,
      } satisfies Envelope);
    });
  }

  /** Run `message` on whichever tab owns the database, retrying across an ownership change. */
  async request(
    message: Message,
    options: { attempts?: number; timeoutMs?: number } = {},
  ): Promise<Reply> {
    const attempts = options.attempts ?? 60;
    const timeoutMs = options.timeoutMs ?? 1000;
    const started = performance.now();
    this.stats.requests++;
    // One id for every retry of this logical request, so the owner can apply it at most once.
    const stamped: Message =
      this.idempotent &&
      message.op === 'execute' &&
      message.requestId === undefined
        ? { ...message, requestId: crypto.randomUUID() }
        : message;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      let reply: Reply | undefined;
      if (this.role === 'owner') {
        await this.ready;
        reply = await this.toWorker(stamped);
        if (reply.error === 'ABANDONED') reply = undefined;
      } else {
        reply = await this.askOwner(stamped, timeoutMs);
      }
      if (reply !== undefined) {
        this.stats.maxLatencyMs = Math.max(
          this.stats.maxLatencyMs,
          performance.now() - started,
        );
        return { ...reply, attempts: attempt };
      }
      this.stats.retried++;
    }
    throw new Error(`no owner answered after ${attempts} attempts`);
  }

  /** TEST HOOK: make this tab's Worker exit right after it applies its next write, before replying. */
  armDie(): void {
    void this.toWorker({ op: 'armDie' });
  }

  /** TEST HOOK: kill this tab's database Worker while the tab itself stays alive and keeps the lock. */
  killWorker(): void {
    this.worker?.terminate();
  }

  /** Insert `count` keyed bookmarks. A repeat key violation on a retried request counts as applied. */
  async insertMany(prefix: string, count: number, pauseMs = 0) {
    const out = { applied: 0, alreadyApplied: 0, failed: [] as string[] };
    for (let i = 0; i < count; i++) {
      const reply = await this.request({
        op: 'execute',
        text: `insert $b isa bookmark, has bookmark-id "${prefix}-${i}", has created-at "t";`,
      });
      if (reply.ok) out.applied++;
      else if ((reply.attempts ?? 1) > 1 && /CNT9/.test(reply.error ?? ''))
        out.alreadyApplied++;
      else out.failed.push(`${prefix}-${i}: ${reply.error}`);
      if (pauseMs > 0) await sleep(pauseMs);
    }
    return out;
  }

  /** Insert `count` UNKEYED pings, each with a distinct value so a repeated application is countable. */
  async insertPings(prefix: string, count: number, pauseMs = 0) {
    const out = { applied: 0, duplicateReplies: 0, failed: [] as string[] };
    for (let i = 0; i < count; i++) {
      const reply = await this.request({
        op: 'execute',
        text: `insert $p isa ping, has created-at "${prefix}-${i}";`,
      });
      if (!reply.ok) out.failed.push(`${prefix}-${i}: ${reply.error}`);
      else if (reply.duplicate) out.duplicateReplies++;
      else out.applied++;
      if (pauseMs > 0) await sleep(pauseMs);
    }
    return out;
  }

  /** Every ping's value, one entry per ping ENTITY (so a double application shows as a repeat). */
  async pingValues(): Promise<string[]> {
    const reply = await this.request({
      op: 'query',
      text: 'match $p isa ping, has created-at $c; select $c;',
    });
    if (!reply.ok) throw new Error(reply.error);
    return (reply.rows ?? []).map((row) => String(row['c'])).sort();
  }

  async ids(): Promise<string[]> {
    const reply = await this.request({
      op: 'query',
      text: 'match $b isa bookmark, has bookmark-id $i; select $i;',
    });
    if (!reply.ok) throw new Error(reply.error);
    return (reply.rows ?? []).map((row) => String(row['i'])).sort();
  }

  status() {
    return {
      id: this.id,
      role: this.role,
      ownerReadyAt: this.ownerReadyAt,
      initRetries: this.initRetries,
      abandoned: this.abandoned,
      stats: { ...this.stats },
    };
  }
}

// Checked here, before any `Tab` exists: a class-field initializer (`crypto.randomUUID()`) runs ahead
// of a constructor body, and it is missing in an insecure context too, so a check inside the
// constructor would never be reached.
if (!('locks' in navigator))
  throw new Error(
    'navigator.locks is unavailable: serve this page over HTTPS or from localhost',
  );
const params = new URLSearchParams(location.search);
const wipeRequested = params.has('wipe');
if (wipeRequested) {
  // Remove it from the address bar, so reloading this page cannot wipe the database again.
  params.delete('wipe');
  const rest = params.toString();
  history.replaceState(
    null,
    '',
    location.pathname + (rest ? `?${rest}` : '') + location.hash,
  );
}
const tab = new Tab(
  wipeRequested,
  Number(params.get('watchdog') ?? 8000),
  params.get('idempotent') !== '0',
);
(window as unknown as { tab: Tab }).tab = tab;

/**
 * Typed into a DevTools console on this page. Each call goes through the same owner election as any
 * tab, so it works from several tabs at once and shares one database. Everything is `await`-able.
 */
const run = async (message: Message): Promise<Reply> => {
  const reply = await tab.request(message);
  if (!reply.ok) throw new Error(reply.error);
  return reply;
};
const typedblite = {
  help(): string {
    return [
      'typedblite.query(text)    run a match ... select ...;  -> rows',
      'typedblite.table(text)    the same, printed with console.table',
      'typedblite.execute(text)  run an insert / delete / put   (applied at most once)',
      'typedblite.define(text)   define a schema',
      "typedblite.status()       which tab owns the database, and this tab's counters",
      "Example: await typedblite.query('match $b isa bookmark, has bookmark-id $i; select $i;')",
    ].join('\n');
  },
  async query(text: string) {
    return (await run({ op: 'query', text })).rows;
  },
  async table(text: string) {
    const rows = (await run({ op: 'query', text })).rows ?? [];
    console.table(rows);
    return rows.length;
  },
  async execute(text: string) {
    const reply = await run({ op: 'execute', text });
    return reply.duplicate
      ? 'already applied (duplicate request ignored)'
      : 'ok';
  },
  async define(text: string) {
    await run({ op: 'define', text });
    return 'ok';
  },
  status: () => tab.status(),
};
(window as unknown as { typedblite: typeof typedblite }).typedblite =
  typedblite;
console.info('TypeDBLite is ready in this tab. Type typedblite.help()');
