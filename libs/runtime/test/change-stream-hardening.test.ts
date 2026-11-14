/**
 * What a hub refuses, and how. Each case was first measured against a live hub as unprotected
 * behaviour (the replication guide's Security section): a stranger's POST was applied, any content
 * type was accepted, a 64 MB body was read and applied, streams were unlimited, a batch applied half,
 * and a 400 echoed internal error text.
 *
 * 🔴 The refusals matter more than the success: a hardened hub that also refused a real spoke would be
 * worse than none, so the last case syncs a real `TypeDBLiteReplicator` through the defaults.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TypeDBLiteInterpreter } from '../src/interpreter.js';
import { serveChangeStream, type ChangeStreamOptions } from '../src/change-stream.js';
import { TypeDBLiteReplicator } from '../src/typedblite-replicator.js';
import { readKeyedSkillsSchema } from './fixtures/keyed-skills-schema.js';

const SCHEMAS = fileURLToPath(new URL('../../../test-fixtures/schemas/', import.meta.url));
const schema = readKeyedSkillsSchema(join(SCHEMAS, 'skills.schema.typeqlite'));
const node = () => {
  const db = new TypeDBLiteInterpreter(':memory:');
  db.define(schema);
  return db;
};
const held = (db: TypeDBLiteInterpreter): string[] => db.changeLog.since(0).map((r) => r.entityId).sort();
const record = (id: string, rev = '1-aaaa') => ({ entityId: id, rev, deleted: true });

let closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of closers) await close();
  closers = [];
});

async function hub(options: ChangeStreamOptions = {}) {
  const db = node();
  const served = serveChangeStream(db.changeLog, { pollMs: 30, ...options });
  closers.push(served.close);
  const url = `http://127.0.0.1:${await served.port}/changes`;
  const post = (body: BodyInit, headers: Record<string, string> = { 'content-type': 'application/json' }) =>
    fetch(url, { method: 'POST', headers, body });
  return { db, url, post };
}

describe('the content type', () => {
  it('refuses anything but JSON, and applies nothing', async () => {
    const { db, post } = await hub();
    // What a web page on another origin can send with no CORS preflight.
    const plain = await post(JSON.stringify([record('probe/a')]), { 'content-type': 'text/plain' });
    expect(plain.status).toBe(415);
    const none = await post(JSON.stringify([record('probe/b')]), {});
    expect(none.status).toBe(415);
    expect(held(db)).toEqual([]);
  });

  it('accepts JSON with a charset parameter, in any case', async () => {
    const { db, post } = await hub();
    const ok = await post(JSON.stringify([record('probe/a')]), { 'content-type': 'Application/JSON; charset=utf-8' });
    expect(ok.status).toBe(200);
    expect(held(db)).toEqual(['probe/a']);
  });
});

describe('the body size', () => {
  it('refuses a body its length says is too big, before reading it, and applies nothing', async () => {
    const { db, post } = await hub({ maxBodyBytes: 1_000 });
    const refused = await post(JSON.stringify([record('probe/a')]) + ' '.repeat(2_000));
    expect(refused.status).toBe(413);
    expect((await refused.json()).error).toMatch(/larger than 1000 bytes/);
    expect(held(db)).toEqual([]);
  });

  it('refuses a body that grows past the limit without declaring its length', async () => {
    const { db, url } = await hub({ maxBodyBytes: 1_000 });
    // Chunked: no content-length, so only counting what arrives can stop it.
    const status = await new Promise<number | string>((resolve) => {
      const req = httpRequest(url, { method: 'POST', headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', (error) => resolve(`error: ${error.message}`));
      req.write('[');
      for (let i = 0; i < 10; i += 1) req.write(' '.repeat(500));
      req.end(']');
    });
    expect(status).toBe(413);
    expect(held(db)).toEqual([]);
  });

  it('applies a body just under the limit', async () => {
    const { db, post } = await hub({ maxBodyBytes: 1_000 });
    expect((await post(JSON.stringify([record('probe/a')]))).status).toBe(200);
    expect(held(db)).toEqual(['probe/a']);
  });
});

describe('a malformed batch', () => {
  it.each([
    ['not JSON', '{nope', /not valid JSON/],
    ['not an array', JSON.stringify({ entityId: 'a' }), /JSON array/],
    ['a null record', JSON.stringify([record('probe/a'), null]), /change 1 is not an object/],
    ['no entityId', JSON.stringify([{ rev: '1-a', deleted: true }]), /change 0 has an invalid entityId/],
    ['a non-string rev', JSON.stringify([{ entityId: 'x', rev: 7, deleted: true }]), /change 0 has an invalid rev/],
    ['a non-boolean deleted', JSON.stringify([{ entityId: 'x', rev: '1-a', deleted: 1 }]), /change 0 has an invalid deleted/],
    ['an array for state', JSON.stringify([{ entityId: 'x', rev: '1-a', deleted: false, state: [] }]), /change 0 has an invalid state/],
  ])('refuses %s with a 400 that names the problem, and applies none of it', async (_name, body, message) => {
    const { db, post } = await hub();
    const response = await post(body);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(message);
    expect(held(db)).toEqual([]);
  });
});

describe('a batch that fails while it is applied', () => {
  it('leaves the store as it was, answers 500 with no detail, and tells the operator', async () => {
    const onError = vi.fn();
    const { db, post } = await hub({ onError });
    const original = db.changeLog.applyRemote.bind(db.changeLog);
    let calls = 0;
    vi.spyOn(db.changeLog, 'applyRemote').mockImplementation((r) => {
      calls += 1;
      if (calls === 2) throw new Error('disk exploded: /var/lib/secret/hub.db');
      return original(r);
    });
    const response = await post(JSON.stringify([record('probe/a', '1-aaaa'), record('probe/b', '1-bbbb'), record('probe/c', '1-cccc')]));
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: 'internal error' });
    expect(text).not.toContain('disk exploded');
    // The first record had applied when the second failed; neither survives, and the third was never read.
    expect(held(db)).toEqual([]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]?.[0] as Error).message).toContain('disk exploded');
  });
});

describe('the number of open streams', () => {
  it('refuses a stream past the cap with a 503 and retry-after, and accepts one when a slot frees', async () => {
    const { url } = await hub({ maxStreams: 2 });
    const open = async () => {
      const controller = new AbortController();
      const response = await fetch(url, { signal: controller.signal });
      return { response, close: () => controller.abort() };
    };
    const first = await open();
    const second = await open();
    expect(first.response.status).toBe(200);
    expect(second.response.status).toBe(200);
    const third = await fetch(url);
    expect(third.status).toBe(503);
    expect(third.headers.get('retry-after')).toBe('5');
    first.close();
    // The server learns a stream closed from the socket, which takes a moment.
    await vi.waitFor(async () => {
      const again = await open();
      expect(again.response.status).toBe(200);
      again.close();
    });
    second.close();
  });
});

describe('a real spoke through the defaults', () => {
  it('still syncs, in both directions', async () => {
    const { db: hubDb, url } = await hub();
    const spoke = node();
    spoke.execute('insert $s isa skill, has skill-id "from-spoke", has skill-name "n";');
    hubDb.execute('insert $s isa skill, has skill-id "from-hub", has skill-name "n";');
    const replicator = new TypeDBLiteReplicator(spoke.changeLog, url.replace(/\/changes$/, ''), 100);
    await replicator.replicateOnce({ direction: 'duplex', timeoutMs: 8_000 });
    expect(held(hubDb)).toEqual(held(spoke));
    expect(held(hubDb).length).toBe(2);
  }, 20_000);
});
