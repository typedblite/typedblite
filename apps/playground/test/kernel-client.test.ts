import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createKernel } from '../src/notebook/kernel-core';
import { KernelCallError, WorkerKernel, type KernelWorkerLike } from '../src/notebook/kernel-client';
import type { KernelReply, KernelRequest } from '../src/notebook/kernel-protocol';

/** A worker that answers from a kernel in this process, as the real one does from WASM, when it is told to. */
class FakeWorker implements KernelWorkerLike {
  onmessage: KernelWorkerLike['onmessage'] = null;
  onerror: KernelWorkerLike['onerror'] = null;
  terminated = false;
  readonly received: KernelRequest[] = [];
  /** Set to hold every answer, as an engine stuck in a statement does. */
  silent = false;
  private readonly kernel = createKernel();
  postMessage(request: KernelRequest): void {
    this.received.push(request);
    if (this.silent) return;
    void this.kernel.call(request.operation, request.input).then(
      (data) => this.reply({ id: request.id, ok: true, data }),
      (error: { code?: string; message: string }) => this.reply({ id: request.id, ok: false, code: error.code ?? 'FAILED', message: error.message }),
    );
  }
  terminate(): void {
    this.terminated = true;
  }
  reply(reply: KernelReply): void {
    this.onmessage?.({ data: reply });
  }
}

let workers: FakeWorker[];
const kernel = (timeoutMs = 1_000) =>
  new WorkerKernel(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  }, timeoutMs);

beforeEach(() => {
  workers = [];
});
afterEach(() => vi.useRealTimers());

describe('the page\'s side of the kernel', () => {
  it('starts a worker on the first call and keeps it, answering each call with the kernel\'s data', async () => {
    const k = kernel();
    expect(workers).toHaveLength(0);
    const { id } = await k.call<{ id: string }>('session.open');
    await k.call('session.run', { session: id, statement: 'define entity a;' });
    expect(workers).toHaveLength(1);
    expect(workers[0]!.received.map((r) => r.operation)).toEqual(['session.open', 'session.run']);
  });

  it('turns a refusal of an operation into an error carrying the kernel\'s code', async () => {
    const failure = await kernel().call('session.run', { session: 'nope', statement: 'x' }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(KernelCallError);
    expect(failure).toMatchObject({ code: 'SESSION_NOT_FOUND' });
  });

  it('runs one call at a time', async () => {
    const k = kernel();
    workers[0]?.terminate();
    const first = k.call('session.open');
    await expect(k.call('session.open')).rejects.toMatchObject({ code: 'BUSY' });
    await first;
    expect(k.running).toBe(false);
  });

  it('ends a call that does not finish by terminating the worker, and the next call starts a fresh one', async () => {
    vi.useFakeTimers();
    const k = kernel(1_000);
    const { id } = await k.call<{ id: string }>('session.open');
    workers[0]!.silent = true;
    const stuck = k.call('session.run', { session: id, statement: 'match $x isa t;' });
    const settled = stuck.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await settled).toMatchObject({ code: 'TIMEOUT', message: expect.stringContaining('1 s') });
    expect(workers[0]!.terminated).toBe(true);

    // A fresh worker has no such session: the notebook opens a new one and says so.
    await expect(k.call('session.run', { session: id, statement: 'x' })).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
    expect(workers).toHaveLength(2);
  });

  it('ignores a late answer to a call that was already ended', async () => {
    vi.useFakeTimers();
    const k = kernel(1_000);
    await k.call('session.open');
    workers[0]!.silent = true;
    const stuck = k.call('session.run', { session: 's1', statement: 'x' }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_000);
    await stuck;
    workers[0]!.reply({ id: workers[0]!.received.at(-1)!.id, ok: true, data: 'too late' });
    await expect(k.call('session.open')).resolves.toMatchObject({ id: 's1' });
  });

  it('stops what is running, on the reader\'s say, and says the store was reset', async () => {
    const k = kernel(60_000);
    await k.call('session.open');
    workers[0]!.silent = true;
    const stuck = k.call('session.run', { session: 's1', statement: 'x' }).catch((error: unknown) => error);
    k.stop();
    expect(await stuck).toMatchObject({ code: 'STOPPED', message: expect.stringContaining('reset') });
    expect(workers[0]!.terminated).toBe(true);
  });

  it('reports the worker failing as a failed call, and starts a new worker after it', async () => {
    const k = kernel(60_000);
    await k.call('session.open');
    workers[0]!.silent = true;
    const stuck = k.call('session.run', { session: 's1', statement: 'x' }).catch((error: unknown) => error);
    workers[0]!.onerror?.({ message: 'the WASM did not load' });
    expect(await stuck).toMatchObject({ code: 'FAILED', message: 'the WASM did not load' });
    await k.call('session.open');
    expect(workers).toHaveLength(2);
  });
});
