import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ownerCheck } from './owners.js';
import { loadBaseline, regressions, reportCard, unraised, type ReportCard } from './report.js';
import { loadDeviations, loadNotApplicable, runSpec, validateDeviations, type ScenarioResult } from './runner.js';
import { loadSpec } from './spec.js';

/** Where the vendored spec, the baseline and the declarations live — this project's root. */
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SPEC_ROOT = join(PROJECT_ROOT, 'spec');
export const REPOSITORY_ROOT = resolve(PROJECT_ROOT, '..', '..', '..', '..');

export interface ConformanceRun {
  readonly results: ReadonlyArray<ScenarioResult>;
  readonly card: ReportCard;
  readonly regressions: ReadonlyArray<string>;
  /** Features that improved past their baseline without the baseline being raised. */
  readonly unraised: ReadonlyArray<string>;
  readonly ownerCaveat: string | undefined;
  readonly deviationsNowPassing: ReadonlyArray<ScenarioResult>;
}

/** The whole thing: parse, run, score, compare. What the test and the CLI both call. */
export const runConformance = (): ConformanceRun => {
  const owners = ownerCheck(REPOSITORY_ROOT);
  const spec = loadSpec(SPEC_ROOT);
  const deviations = loadDeviations(join(PROJECT_ROOT, 'deviations.yaml'));
  validateDeviations(spec, deviations);
  const results = runSpec(spec, {
    deviations,
    notApplicable: loadNotApplicable(join(PROJECT_ROOT, 'not-applicable.yaml')),
    ownerResolves: owners.resolves,
  });
  const card = reportCard(results);
  const baseline = loadBaseline(join(PROJECT_ROOT, 'baseline.json'));
  return {
    results,
    card,
    regressions: regressions(card, baseline),
    unraised: unraised(card, baseline),
    ownerCaveat: owners.caveat,
    deviationsNowPassing: results.filter((r) => r.deviationNowPassing),
  };
};
