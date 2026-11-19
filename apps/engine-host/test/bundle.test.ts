import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SidecarClient } from '@devx-micro/app-sidecar';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The bundle the editor runs: `dist/sidecar.cjs`, one file with no `node_modules`. esbuild does not emit the
 * decorator metadata Nest reads for constructor injection, so a parameter left without `@Inject` is `undefined` in
 * the bundle and in nothing else this suite runs. This is the spec that sees it. `nx run engine-host:test` bundles first.
 */
const BUNDLE = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'sidecar.cjs');

const clients: SidecarClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.stop();
});
const start = () => {
  const client = new SidecarClient({ command: process.execPath, args: [BUNDLE] });
  client.start();
  clients.push(client);
  return client;
};

describe('the host bundle', () => {
  it('exists', () => {
    expect(existsSync(BUNDLE)).toBe(true);
  });

  it('answers every operation that needs an injected dependency: open, run, begin, rollback, list, schema, close', async () => {
    const client = start();
    const ask = async (operation: string, input: Record<string, unknown> = {}) => (await client.request({ operation, input })) as { status: string; data: any; error?: { code: string; message: string } };

    const opened = await ask('session.open', { schema: 'define attribute name, value string; entity person, owns name;' });
    expect(opened).toMatchObject({ status: 'success', data: { id: 's1', hasSchema: true } });
    await ask('session.begin', { session: 's1' });
    await ask('session.run', { session: 's1', statement: 'insert $p isa person, has name "Ada";' });
    expect((await ask('session.run', { session: 's1', statement: 'match $p isa person, has name $n; select $n;' })).data.rows).toEqual([{ n: 'Ada' }]);
    await ask('session.rollback', { session: 's1' });
    expect((await ask('session.run', { session: 's1', statement: 'match $p isa person; select $p;' })).data.rows).toEqual([]);
    expect((await ask('session.list')).data).toHaveLength(1);
    expect((await ask('schema.get', { session: 's1' })).data.types).toEqual(['person']);
    expect((await ask('session.restart', { session: 's1' })).data).toEqual({ kind: 'ok' });
    expect((await ask('session.close', { session: 's1' })).data.closed).toBe(true);
    expect((await ask('statement.classify', { statement: 'insert $a isa a;' })).data).toEqual({ kind: 'write' });
  });

  it('answers a fault with its code, and carries on', async () => {
    const client = start();
    expect(await client.request({ operation: 'session.get', input: { session: 's9' } })).toMatchObject({ status: 'error', error: { code: 'SESSION_NOT_FOUND' } });
    expect(await client.request({ operation: 'session.list', input: {} })).toMatchObject({ status: 'success', data: [] });
  });

  it('writes nothing to stdout but envelopes: stdout is the protocol', async () => {
    const child = spawn(process.execPath, [BUNDLE], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stdin.write(`${JSON.stringify({ operation: 'session.list', input: {} })}\n`);
    child.stdin.end();
    await new Promise((resolve) => child.once('exit', resolve));
    for (const line of out.split('\n').filter(Boolean)) expect(JSON.parse(line)).toHaveProperty('status');
  });
});
