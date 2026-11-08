import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadFeature } from '../src/spec.js';
import { validateDeviations } from '../src/runner.js';

/**
 * A Scenario Outline is one scenario in the file and one pickle per Examples row in the run. Each
 * pickle must carry its OWN line — the Examples row's — or every row of a placeholder-free outline
 * has the same name and the same line, and a deviation can never name one of them. The pin has 16
 * such outlines (`define.feature:1474` among them).
 */
const FEATURE = `Feature: outline lines
  Scenario Outline: the same name for every row
    Given typedb starts
    Given connection has <n> databases
    Examples:
      | n |
      | 0 |
      | 1 |
`;

describe('outline pickles', () => {
  it('carry the line of their Examples row, so a deviation can name exactly one', () => {
    const root = mkdtempSync(join(tmpdir(), 'conformance-spec-'));
    try {
      mkdirSync(join(root, 'query', 'language'), { recursive: true });
      const path = join(root, 'query', 'language', 'outline.feature');
      writeFileSync(path, FEATURE);
      const feature = loadFeature(root, path);
      assert.equal(feature.scenarios.length, 2);
      const lines = feature.scenarios.map((s) => s.line);
      assert.notEqual(lines[0], lines[1], `both pickles carry line ${lines[0]}`);
      const entry = { feature: 'query/language/outline.feature', scenario: 'the same name for every row', reason: 'r', owner: 'adr-018' };
      assert.throws(() => validateDeviations([feature], [entry]), /names 2 scenarios/);
      assert.doesNotThrow(() => validateDeviations([feature], [{ ...entry, line: lines[0] }]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
