import { describe, expect, it, vi } from 'vitest';

import { HostClient, HostRequestError, HostUnavailableError, type SidecarLike } from '../src/host/host-client';
import type { NodeProbe } from '../src/host/probe-node';

type Request = { operation: string; input?: Record<string, unknown> };

/** A stand-in for the host process: what it was asked, and what it answers. */
function fakeProcess(answer: (request: Request) => unknown = () => ({ status: 'success', data: {} })) {
  const state = { started: 0, stopped: 0, requests: [] as Request[], dead: false };
  const client: SidecarLike = {
    start: () => void (state.started += 1),
    stop: async () => void (state.stopped += 1),
    request: async (request) => {
      state.requests.push(request);
      if (state.dead) throw new Error('the sidecar exited');
      return answer(request) as never;
    },
  };
  return { state, client };
}

function make(options: { configured?: string; probe?: (command: string) => Promise<NodeProbe>; answer?: (r: Request) => unknown } = {}) {
  const clients: ReturnType<typeof fakeProcess>[] = [];
  const created: { command: string; args: readonly string[] }[] = [];
  const probe = vi.fn(options.probe ?? (async () => ({ ok: true, version: '24.0.0' }) as NodeProbe));
  const host = new HostClient({
    sidecarPath: '/ext/out/host/sidecar.cjs',
    configuredNode: () => options.configured,
    probe,
    createClient: (clientOptions) => {
      created.push(clientOptions);
      const made = fakeProcess(options.answer);
      clients.push(made);
      return made.client;
    },
  });
  return { host, probe, created, clients };
}

describe('starting', () => {
  it('starts nothing until the first request', async () => {
    const { host, probe, created } = make();
    expect(created).toHaveLength(0);
    expect(probe).not.toHaveBeenCalled();
    await host.request('session.list');
    expect(created).toHaveLength(1);
  });

  it('runs the bundled host with the node on PATH when none is configured', async () => {
    const { host, probe, created } = make();
    await host.request('session.list');
    expect(probe).toHaveBeenCalledWith('node');
    expect(created[0]).toEqual({ command: 'node', args: ['/ext/out/host/sidecar.cjs'] });
  });

  it('runs it with the configured node', async () => {
    const { host, probe, created } = make({ configured: '/opt/node22/bin/node' });
    await host.request('session.list');
    expect(probe).toHaveBeenCalledWith('/opt/node22/bin/node');
    expect(created[0]!.command).toBe('/opt/node22/bin/node');
  });

  it('treats a blank setting as no setting', async () => {
    const { probe, host } = make({ configured: '   ' });
    await host.request('session.list');
    expect(probe).toHaveBeenCalledWith('node');
  });

  it('starts one host for requests that arrive together, and probes once', async () => {
    const { host, probe, created } = make();
    await Promise.all([host.request('session.list'), host.request('session.list'), host.request('session.list')]);
    expect(created).toHaveLength(1);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('keeps the host between requests', async () => {
    const { host, created, clients } = make();
    await host.request('session.list');
    await host.request('session.list');
    expect(created).toHaveLength(1);
    expect(clients[0]!.state.requests).toHaveLength(2);
  });
});

describe('when there is no suitable node', () => {
  const failing = async (): Promise<NodeProbe> => ({ ok: false, reason: "'node' was not found" });

  it('says why, and to put one on PATH or set the setting, and starts no process', async () => {
    const { host, created } = make({ probe: failing });
    await expect(host.request('session.list')).rejects.toThrow(HostUnavailableError);
    await expect(host.request('session.list')).rejects.toThrow(/was not found.*22\.16 or newer.*PATH.*typedblite\.host\.node/s);
    expect(created).toHaveLength(0);
  });

  it('blames the setting when one was given, and does not quietly use another node', async () => {
    const { host, probe } = make({ configured: '/bad/node', probe: async () => ({ ok: false, reason: "'/bad/node' was not found" }) });
    await expect(host.request('session.list')).rejects.toThrow(/Fix the 'typedblite\.host\.node' setting/);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith('/bad/node');
  });

  it('tries again on the next request, so installing node needs no restart', async () => {
    let installed = false;
    const { host, created } = make({ probe: async () => (installed ? { ok: true, version: '24.0.0' } : { ok: false, reason: 'missing' }) });
    await expect(host.request('session.list')).rejects.toThrow(HostUnavailableError);
    installed = true;
    await host.request('session.list');
    expect(created).toHaveLength(1);
  });
});

describe('what a request answers', () => {
  it('returns the envelope as the host sent it, and passes the operation and input through', async () => {
    const { host, clients } = make({ answer: () => ({ status: 'success', data: { id: 's1' } }) });
    expect(await host.request('session.open', { location: ':memory:' })).toEqual({ status: 'success', data: { id: 's1' } });
    expect(clients[0]!.state.requests).toEqual([{ operation: 'session.open', input: { location: ':memory:' } }]);
  });

  it('returns an error envelope instead of throwing, because the host answered', async () => {
    const { host } = make({ answer: () => ({ status: 'error', error: { code: 'SESSION_NOT_FOUND', message: "No session 's9'." } }) });
    expect(await host.request('session.get', { session: 's9' })).toMatchObject({ status: 'error', error: { code: 'SESSION_NOT_FOUND' } });
  });

  it('call() answers the data, and throws the host\'s code on a fault', async () => {
    const ok = make({ answer: () => ({ status: 'success', data: [1, 2] }) });
    expect(await ok.host.call('session.list')).toEqual([1, 2]);

    const bad = make({ answer: () => ({ status: 'error', error: { code: 'SESSION_NOT_FOUND', message: 'No session' } }) });
    const failure = await bad.host.call('session.get', { session: 's9' }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(HostRequestError);
    expect(failure).toMatchObject({ code: 'SESSION_NOT_FOUND', operation: 'session.get', message: 'No session' });
  });
});

describe('when the host process dies', () => {
  it('rejects the request as unavailable, and the next one starts a fresh host', async () => {
    const { host, created, clients } = make();
    await host.request('session.list');
    clients[0]!.state.dead = true;
    await expect(host.request('session.list')).rejects.toThrow(/stopped answering.*sidecar exited/);
    expect(clients[0]!.state.stopped).toBe(1);

    await host.request('session.list');
    expect(created).toHaveLength(2);
    expect(clients[1]!.state.started).toBe(1);
  });
});

describe('stopping', () => {
  it('ends the host, and a later request starts another', async () => {
    const { host, created, clients } = make();
    await host.request('session.list');
    await host.stop();
    expect(clients[0]!.state.stopped).toBe(1);
    await host.request('session.list');
    expect(created).toHaveLength(2);
  });

  it('is safe when nothing was started, and when called twice', async () => {
    const { host } = make();
    await host.stop();
    await host.stop();
  });

  it('dispose ends it', async () => {
    const { host, clients } = make();
    await host.request('session.list');
    host.dispose();
    await new Promise((resolve) => setImmediate(resolve));
    expect(clients[0]!.state.stopped).toBe(1);
  });
});
