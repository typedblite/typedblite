import { describe, expect, it } from 'vitest';

import { atLeastMinimum, probeNode, type ProbeRun } from '../src/host/probe-node';

const run = (result: Partial<ProbeRun>) => async (): Promise<ProbeRun> => ({ status: 0, stdout: '', stderr: '', ...result });
const report = (version: string, sqlite: boolean) => JSON.stringify({ version, sqlite });

describe('atLeastMinimum', () => {
  it.each([
    ['22.16.0', true],
    ['22.16.9', true],
    ['22.17.0', true],
    ['24.22.1', true],
    ['23.0.0', true],
    ['22.15.9', false],
    ['22.5.0', false],
    ['20.19.0', false],
    ['', false],
    ['not a version', false],
  ])('%j is %s', (version, expected) => {
    expect(atLeastMinimum(version)).toBe(expected);
  });
});

describe('probeNode', () => {
  it('accepts a Node that is new enough and has node:sqlite', async () => {
    expect(await probeNode('node', run({ stdout: report('24.22.1', true) }))).toEqual({ ok: true, version: '24.22.1' });
  });

  it('says a node that is not there was not found, naming it', async () => {
    expect(await probeNode('nodee', run({ spawnError: 'ENOENT', status: null }))).toEqual({ ok: false, reason: "'nodee' was not found" });
  });

  it('says why another start failure happened', async () => {
    expect(await probeNode('/x/node', run({ spawnError: 'EACCES', status: null }))).toMatchObject({ ok: false, reason: expect.stringContaining('EACCES') });
  });

  it('refuses something that does not run as Node, with the first line of what it said', async () => {
    const result = await probeNode('/bin/ls', run({ status: 2, stderr: 'ls: bad option\nusage: ls' }));
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('ls: bad option') });
    expect(JSON.stringify(result)).not.toContain('usage');
  });

  it('refuses something that exits 0 and is not Node', async () => {
    expect(await probeNode('echo', run({ stdout: 'hello\n' }))).toMatchObject({ ok: false, reason: expect.stringContaining('is not Node') });
  });

  it('refuses a Node that is too old, saying which version and what is needed', async () => {
    const result = await probeNode('node', run({ stdout: report('20.19.0', false) }));
    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/Node 20\.19\.0.*22\.16/) });
  });

  it('refuses a Node that is new enough but has no node:sqlite', async () => {
    expect(await probeNode('node', run({ stdout: report('22.16.0', false) }))).toMatchObject({ ok: false, reason: expect.stringContaining('no node:sqlite') });
  });

  it('runs the real thing: this process\'s own node can run the host', async () => {
    expect(await probeNode(process.execPath)).toMatchObject({ ok: true });
  });

  it('runs the real thing: a command that does not exist is not found', async () => {
    expect(await probeNode('/no/such/node-binary')).toMatchObject({ ok: false, reason: expect.stringContaining('was not found') });
  });
});
