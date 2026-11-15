import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FromWorker, ToWorker } from '../src/protocol';
import { Runner, type WorkerLike } from '../src/runner-client';
import type { RunResult } from '../src/run';

class FakeWorker implements WorkerLike {
  onmessage: WorkerLike['onmessage'] = null;
  onerror: WorkerLike['onerror'] = null;
  terminated = false;
  readonly received: ToWorker[] = [];
  postMessage(message: ToWorker): void {
    this.received.push(message);
  }
  terminate(): void {
    this.terminated = true;
  }
  reply(message: FromWorker): void {
    this.onmessage?.({ data: message });
  }
}

const OK: RunResult = { steps: [] };
let workers: FakeWorker[];
const runner = (timeoutMs = 1_000) =>
  new Runner(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  }, timeoutMs);

beforeEach(() => {
  workers = [];
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('the runner', () => {
  it('posts the program to a worker it starts on the first run, and resolves with its answer', async () => {
    const r = runner();
    const run = r.run('match $x isa y;');
    expect(workers).toHaveLength(1);
    expect(workers[0]!.received).toEqual([{ type: 'run', id: 1, source: 'match $x isa y;' }]);
    expect(r.running).toBe(true);
    workers[0]!.reply({ type: 'result', id: 1, result: OK });
    expect(await run).toBe(OK);
    expect(r.running).toBe(false);
  });

  it('reuses its worker for the next run', async () => {
    const r = runner();
    const first = r.run('a');
    workers[0]!.reply({ type: 'result', id: 1, result: OK });
    await first;
    const second = r.run('b');
    expect(workers).toHaveLength(1);
    expect(workers[0]!.received.map((m) => m.id)).toEqual([1, 2]);
    workers[0]!.reply({ type: 'result', id: 2, result: OK });
    await second;
  });

  it('refuses a second run while one is in progress', async () => {
    const r = runner();
    const first = r.run('a');
    await expect(r.run('b')).rejects.toThrow('already in progress');
    workers[0]!.reply({ type: 'result', id: 1, result: OK });
    await first;
  });

  it('ends a run that does not finish: terminates the worker, says so, and starts a fresh one next time', async () => {
    const r = runner(2_000);
    const run = r.run('a query that never returns');
    vi.advanceTimersByTime(2_000);
    const result = await run;
    expect(result.error?.message).toBe('Stopped: the run took longer than 2 s.');
    expect(workers[0]!.terminated).toBe(true);
    expect(r.running).toBe(false);
    const next = r.run('again');
    expect(workers).toHaveLength(2);
    workers[1]!.reply({ type: 'result', id: 2, result: OK });
    expect(await next).toBe(OK);
  });

  it('ignores a late answer from a run it already ended', async () => {
    const r = runner(500);
    const run = r.run('slow');
    vi.advanceTimersByTime(500);
    await run;
    const next = r.run('fast');
    workers[0]!.reply({ type: 'result', id: 1, result: { steps: [], error: { message: 'LATE' } } });
    expect(r.running).toBe(true);
    workers[1]!.reply({ type: 'result', id: 2, result: OK });
    expect(await next).toBe(OK);
  });

  it('stops a run on request, terminating the worker', async () => {
    const r = runner();
    const run = r.run('a');
    r.stop();
    expect((await run).error?.message).toBe('Stopped.');
    expect(workers[0]!.terminated).toBe(true);
    r.stop(); // nothing running: harmless
  });

  it("reports the worker's own failure, and discards that worker", async () => {
    const r = runner();
    const run = r.run('a');
    workers[0]!.reply({ type: 'fatal', id: 1, message: 'sqlite3.wasm failed to load' });
    expect((await run).error?.message).toBe('sqlite3.wasm failed to load');
    expect(workers[0]!.terminated).toBe(true);
  });

  it('reports a worker error event, and a fatal message with no id', async () => {
    const r = runner();
    const run = r.run('a');
    workers[0]!.onerror?.({ message: 'script error' });
    expect((await run).error?.message).toBe('script error');
    const again = r.run('b');
    workers[1]!.onerror?.({});
    expect((await again).error?.message).toBe('The worker failed.');
    const third = r.run('c');
    workers[2]!.reply({ type: 'fatal', message: 'no id on this one' });
    expect((await third).error?.message).toBe('no id on this one');
  });
});
