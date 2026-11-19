import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SidecarClient } from '@devx-micro/app-sidecar';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The built host, run as a process: what a user and the editor actually start. `nx run engine-host:test` builds
 * first. These cover what an in-process spec cannot: the entry point, the exit code, and stdio.
 */
const MAIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'out', 'main.js');
const host = (...args: string[]) => spawnSync(process.execPath, [MAIN, ...args], { encoding: 'utf8', timeout: 20_000 });

describe('the host as a process', () => {
  it('refuses an unrecognised mode flag by name, exit 2, and does not wait for anything', () => {
    const result = host('--repel');
    expect(result.status).toBe(2);
    expect(`${result.stdout}${result.stderr}`).toContain('--repel');
    expect(result.signal).toBeNull();
  });

  it('refuses a short flag the same way', () => {
    const result = host('-x');
    expect(result.status).toBe(2);
    expect(`${result.stdout}${result.stderr}`).toContain('-x');
  });

  it('with no arguments prints its operations and starts nothing (there is no HTTP mode yet)', () => {
    const result = host();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('session.run');
  });

  it('runs one operation and exits with the envelope\'s exit code', () => {
    const ok = host('statement.classify', '--statement', 'insert $a isa a;');
    expect(ok.status).toBe(0);
    expect(JSON.parse(ok.stdout)).toMatchObject({ operation: 'statement.classify', status: 'success', data: { kind: 'write' } });

    const missing = host('session.get', '--session', 's9');
    expect(missing.status).toBe(5);
    expect(JSON.parse(missing.stdout)).toMatchObject({ status: 'error', error: { code: 'SESSION_NOT_FOUND' } });

    expect(host('session.run', '--statement', 'x').status).toBe(2);
    expect(host('no.such.operation').status).not.toBe(0);
  });

  it('a stray argument after a typo is an unknown operation, not a started server', () => {
    const result = host('session.opn');
    expect(result.status).not.toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'error', error: { code: 'UNKNOWN_OPERATION' } });
  });
});

describe('the sidecar, through the client the editor will use', () => {
  const clients: SidecarClient[] = [];
  afterEach(async () => {
    for (const client of clients.splice(0)) await client.stop();
  });
  const start = () => {
    const client = new SidecarClient({ command: process.execPath, args: [MAIN, '--sidecar'] });
    client.start();
    clients.push(client);
    return client;
  };

  it('keeps a session across requests, in order, and answers each with an envelope', async () => {
    const client = start();
    const opened = await client.request({ operation: 'session.open', input: { schema: 'define attribute name, value string; entity person, owns name;' } });
    expect(opened).toMatchObject({ status: 'success', data: { id: 's1', hasSchema: true } });

    await client.request({ operation: 'session.begin', input: { session: 's1' } });
    await client.request({ operation: 'session.run', input: { session: 's1', statement: 'insert $p isa person, has name "Ada";' } });
    await client.request({ operation: 'session.rollback', input: { session: 's1' } });
    const read = await client.request({ operation: 'session.run', input: { session: 's1', statement: 'match $p isa person, has name $n; select $n;' } });
    expect(read).toMatchObject({ data: { kind: 'rows', rows: [] } });

    const listed = await client.request({ operation: 'session.list', input: {} });
    expect(listed).toMatchObject({ data: [{ id: 's1', mode: 'auto' }] });
  });

  it('answers an operation it does not know with an error envelope, and carries on', async () => {
    const client = start();
    expect(await client.request({ operation: 'no.such', input: {} })).toMatchObject({ status: 'error', error: { code: 'UNKNOWN_OPERATION' } });
    expect(await client.request({ operation: 'session.list', input: {} })).toMatchObject({ status: 'success', data: [] });
  });
});
