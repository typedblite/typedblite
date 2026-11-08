import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

/**
 * Every Background in the vendored TypeDB behaviour spec parses — the grammar's acceptance test
 * for TypeDBLite Conformance Phase 01.
 *
 * 🔴 The grammar's own rule is that a construct is added when a caller needs it. The caller is
 * `typedb/typedb-behaviour` at the pin (ADR-055): 1,632 of 1,756 scenarios stopped in their
 * Background on 2026-09-11, every one at a construct this grammar lacked — an annotation on an
 * `attribute` definition, `@independent`, a trait list with no comma after the label, a double or
 * a date literal in an insert. Parsing is the whole claim here; what the annotations *mean* is
 * the interpreter's, and the conformance report card measures that scenario by scenario.
 *
 * Read from the conformance project's vendored copy rather than duplicated: the files are
 * byte-checked against upstream there, and a copy here would be a second thing to keep pinned.
 */
const SPEC = join(
  process.cwd(),
  '..',
  'conformance',
  'spec',
  'query',
  'language',
);

interface BackgroundQuery {
  readonly feature: string;
  readonly kind: 'schema' | 'write';
  readonly text: string;
}

/** The doc strings of `typeql schema query` and `typeql write query` steps inside a Background. */
const backgroundQueries = (
  feature: string,
  source: string,
): BackgroundQuery[] => {
  const lines = source.split('\n');
  const queries: BackgroundQuery[] = [];
  let inBackground = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (/^Background:/.test(line)) inBackground = true;
    else if (/^(Scenario|Scenario Outline|@)/.test(line)) inBackground = false;
    if (!inBackground) continue;
    const step = /^(?:Given|When|And) typeql (schema|write) query$/.exec(line);
    if (!step || lines[i + 1]?.trim() !== '"""') continue;
    const body: string[] = [];
    for (let j = i + 2; j < lines.length && lines[j].trim() !== '"""'; j += 1)
      body.push(lines[j]);
    queries.push({
      feature,
      kind: step[1] as 'schema' | 'write',
      text: body.join('\n'),
    });
  }
  return queries;
};

const features = readdirSync(SPEC)
  .filter((name) => name.endsWith('.feature'))
  .sort()
  .map((name) => ({
    name,
    queries: backgroundQueries(name, readFileSync(join(SPEC, name), 'utf8')),
  }));

describe('every Background in typedb-behaviour query/language parses', () => {
  it('found the Backgrounds', () => {
    expect(features).toHaveLength(19);
    expect(features.flatMap((f) => f.queries).length).toBeGreaterThan(19);
  });

  it.each(features.map((f) => [f.name, f.queries] as const))(
    '%s',
    (_name, queries) => {
      const problems = queries.flatMap(({ kind, text }) => {
        const result = parse(text);
        return [...result.lexerErrors, ...result.parserErrors].map(
          (e) => `${kind}: ${e.message}`,
        );
      });
      expect(problems).toEqual([]);
    },
  );
});
