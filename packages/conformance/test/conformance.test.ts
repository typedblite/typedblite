import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { runConformance } from '../src/conformance.js';
import { renderCard, renderFailureDigest } from '../src/report.js';

/**
 * The report card, as a test. It asserts two things of the score — ADR-055 D4: no feature's pass
 * count is below its baseline, and none is above it unraised — plus the two things that keep the
 * score honest: every
 * scenario is accounted for (the sum rule, thrown by `reportCard` itself), and every declared
 * deviation names exactly one scenario that exists (`validateDeviations`, thrown by
 * `runConformance` before anything runs).
 */
describe('TypeDBLite against typedb-behaviour query/language', () => {
  const run = runConformance();

  it('prints the report card', () => {
    console.log(`\n${renderCard(run.card)}\n\n${renderFailureDigest(run.results)}\n`);
    if (run.ownerCaveat) console.log(`⚠️  ${run.ownerCaveat}`);
    assert.ok(run.card.totals.total > 900, `ran ${run.card.totals.total} scenarios`);
  });

  it('has no feature below its baseline', () => {
    assert.deepEqual(run.regressions, []);
  });

  it('has no feature above its baseline either — the baseline is what the run measured', () => {
    // 🔴 The standard says raised in the same commit. A floor left behind by an improvement is a
    // floor a later regression falls back to unseen, so an unraised baseline fails here.
    assert.deepEqual(run.unraised, []);
  });

  it('reports a deviation that has started passing, so its entry can be removed', () => {
    const stale = run.deviationsNowPassing.map((r) => `${r.feature}: ${r.scenario.name}`);
    // Reported here, as the standard says — and since a passing deviation is scored `pass`, it also
    // raises its feature's count, which the `unraised` assertion above refuses until the baseline is
    // raised. Removing the entry and raising the baseline are the same commit.
    if (stale.length > 0) console.log(`✅ deviations now passing:\n  ${stale.join('\n  ')}`);
    assert.ok(Array.isArray(stale));
  });
});
