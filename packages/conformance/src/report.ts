import { readFileSync } from 'node:fs';
import type { Outcome, ScenarioResult } from './runner.js';

export interface FeatureCounts {
  readonly feature: string;
  readonly pass: number;
  readonly fail: number;
  readonly deviation: number;
  readonly notApplicable: number;
  readonly total: number;
}

export interface ReportCard {
  readonly features: ReadonlyArray<FeatureCounts>;
  readonly totals: FeatureCounts;
}

const count = (results: ReadonlyArray<ScenarioResult>, outcome: Outcome): number =>
  results.filter((r) => r.outcome === outcome).length;

const countsOf = (feature: string, results: ReadonlyArray<ScenarioResult>): FeatureCounts => ({
  feature,
  pass: count(results, 'pass'),
  fail: count(results, 'fail'),
  deviation: count(results, 'deviation'),
  notApplicable: count(results, 'not-applicable'),
  total: results.length,
});

/**
 * 🔴 The sum rule (ADR-055 D3). Four counts that do not sum to the total mean a scenario was lost —
 * and a lost scenario is the one that would have failed. The report refuses rather than scoring.
 */
export const checkSums = (card: ReportCard): void => {
  for (const f of [...card.features, card.totals]) {
    const sum = f.pass + f.fail + f.deviation + f.notApplicable;
    if (sum !== f.total) {
      throw new Error(`${f.feature}: outcomes sum to ${sum}, scenario count is ${f.total} — no score reported`);
    }
  }
};

export const reportCard = (results: ReadonlyArray<ScenarioResult>): ReportCard => {
  const byFeature = new Map<string, ScenarioResult[]>();
  for (const result of results) {
    byFeature.set(result.feature, [...(byFeature.get(result.feature) ?? []), result]);
  }
  const features = [...byFeature.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([feature, rs]) => countsOf(feature, rs));
  const card = { features, totals: countsOf('total', results) };
  checkSums(card);
  return card;
};

export type Baseline = Readonly<Record<string, number>>;

export const loadBaseline = (path: string): Baseline => JSON.parse(readFileSync(path, 'utf8')) as Baseline;

/**
 * ADR-055 D4: red when any feature's pass count is below its baseline — and when the baseline has
 * no entry for a feature that ran, because an absent entry is a zero nobody wrote down.
 */
export const regressions = (card: ReportCard, baseline: Baseline): ReadonlyArray<string> => {
  const problems: string[] = [];
  for (const f of card.features) {
    const expected = baseline[f.feature];
    if (expected === undefined) problems.push(`${f.feature}: no baseline entry`);
    else if (f.pass < expected) problems.push(`${f.feature}: ${f.pass} pass, baseline ${expected}`);
  }
  for (const feature of Object.keys(baseline)) {
    if (!card.features.some((f) => f.feature === feature)) {
      problems.push(`${feature}: in the baseline, but no such feature ran`);
    }
  }
  return problems;
};

/**
 * Features above their baseline — an improvement that landed without the raise the standard
 * requires in the same commit. 🔴 A floor that is not raised is a floor a later regression can
 * fall back to unseen: 122 → 130 → 124 is green throughout on the floor alone. Reported beside
 * `regressions`, and the routine test refuses both, so the baseline is what the run measured.
 */
export const unraised = (card: ReportCard, baseline: Baseline): ReadonlyArray<string> => {
  const lines: string[] = [];
  for (const f of card.features) {
    const expected = baseline[f.feature];
    if (expected !== undefined && f.pass > expected) {
      lines.push(`${f.feature}: ${f.pass} pass, baseline ${expected} — raise it`);
    }
  }
  return lines;
};

const line = (f: FeatureCounts): string =>
  `${f.feature.padEnd(12)} ${String(f.pass).padStart(4)} pass · ${String(f.fail).padStart(4)} fail · ` +
  `${String(f.deviation).padStart(3)} deviation · ${String(f.notApplicable).padStart(3)} n/a · ${String(f.total).padStart(4)} total`;

export const renderCard = (card: ReportCard): string =>
  [...card.features.map(line), '-'.repeat(78), line(card.totals)].join('\n');

/** The failures, grouped by what stopped them — the raw material of the next phase's checklist. */
export const renderFailureDigest = (results: ReadonlyArray<ScenarioResult>, top = 15): string => {
  const undefinedSteps = new Map<string, number>();
  const backgroundReasons = new Map<string, number>();
  const stepReasons = new Map<string, number>();
  for (const r of results) {
    if (!r.failure) continue;
    if (r.failure.undefinedStep) {
      undefinedSteps.set(r.failure.step.text, (undefinedSteps.get(r.failure.step.text) ?? 0) + 1);
      continue;
    }
    const bucket = r.failure.step.fromBackground ? backgroundReasons : stepReasons;
    // Offsets and character positions vary per scenario; the reason does not. Grouped without them.
    const reason = r.failure.reason.split('\n')[0].replace(/ at offset: \d+/g, '').replace(/skipped \d+ characters?\.?/g, '').slice(0, 110);
    const key = `${r.failure.step.text} — ${reason}`;
    bucket.set(key, (bucket.get(key) ?? 0) + 1);
  }
  const render = (title: string, map: Map<string, number>): string[] => [
    `${title} (${[...map.values()].reduce((a, b) => a + b, 0)} scenario(s))`,
    ...[...map.entries()]
      .sort(([, a], [, b]) => b - a)
      .slice(0, top)
      .map(([k, n]) => `  ${String(n).padStart(4)}  ${k}`),
  ];
  return [
    ...render('Stopped in a Background step', backgroundReasons),
    '',
    ...render('Stopped in a scenario step', stepReasons),
    '',
    ...render('Undefined steps', undefinedSteps),
  ].join('\n');
};
