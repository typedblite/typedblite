import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { featureName, type SpecFeature, type SpecScenario, type SpecStep } from './spec.js';
import { findStep, UndefinedStep } from './steps.js';
import { World } from './world.js';

/**
 * ADR-055 D3: every scenario ends as exactly one of four outcomes, and they sum to the total.
 *
 * - `pass` — every step ran and none threw.
 * - `fail` — a step threw, or had no definition, and nothing claims otherwise.
 * - `deviation` — it failed, and `deviations.yaml` names it with an owning record.
 * - `not-applicable` — a step matches a pattern `not-applicable.yaml` declares outside the
 *   engine's contract, or the scenario has no steps at all. Decided before running, so it cannot
 *   depend on how the run went.
 */
export type Outcome = 'pass' | 'fail' | 'deviation' | 'not-applicable';

export interface ScenarioResult {
  readonly feature: string;
  readonly scenario: SpecScenario;
  readonly outcome: Outcome;
  /** For a fail or deviation: the step that stopped it, and why. */
  readonly failure?: { readonly step: SpecStep; readonly reason: string; readonly undefinedStep: boolean };
  /** A deviation that passed: the departure it records has closed. */
  readonly deviationNowPassing?: boolean;
}

export interface Deviation {
  readonly feature: string;
  readonly scenario: string;
  /** Required when the name is not unique in its feature — the pin has duplicates. */
  readonly line?: number;
  readonly reason: string;
  readonly owner: string;
}

export interface NotApplicable {
  readonly pattern: string;
  readonly reason: string;
}

export const loadDeviations = (path: string): ReadonlyArray<Deviation> =>
  (parseYaml(readFileSync(path, 'utf8')) as Deviation[] | null) ?? [];

export const loadNotApplicable = (path: string): ReadonlyArray<NotApplicable> =>
  (parseYaml(readFileSync(path, 'utf8')) as NotApplicable[] | null) ?? [];

const deviationKey = (feature: string, scenario: string, line?: number): string =>
  `${feature}\u0000${scenario}\u0000${line ?? ''}`;

const scenariosNamed = (features: ReadonlyArray<SpecFeature>, entry: Deviation): SpecScenario[] =>
  features
    .filter((f) => featureName(f.path) === featureName(entry.feature))
    .flatMap((f) => f.scenarios)
    .filter((s) => s.name === entry.scenario && (entry.line === undefined || s.line === entry.line));

/**
 * Every deviation names exactly one scenario that exists. The pin has duplicate scenario names
 * (fetch, define, update, the redefine outlines), so an entry that matches two must carry a line.
 * Checked before the run, so a stale entry is a refusal, not a silent non-deviation.
 */
export const validateDeviations = (
  features: ReadonlyArray<SpecFeature>,
  deviations: ReadonlyArray<Deviation>,
): void => {
  for (const entry of deviations) {
    const named = scenariosNamed(features, entry);
    const where = `${featureName(entry.feature)}: "${entry.scenario}"${entry.line ? ` at line ${entry.line}` : ''}`;
    if (named.length === 0) throw new Error(`deviations.yaml: ${where} names no scenario in the pin`);
    if (named.length > 1) throw new Error(`deviations.yaml: ${where} names ${named.length} scenarios — add a line`);
  }
};

const runScenario = (scenario: SpecScenario): ScenarioResult['failure'] | undefined => {
  const world = new World();
  try {
    for (const step of scenario.steps) {
      try {
        const { definition, match } = findStep(step.text);
        definition.run(world, match, step);
      } catch (error) {
        const undefinedStep = error instanceof UndefinedStep;
        const reason = error instanceof Error ? error.message : String(error);
        return { step, reason, undefinedStep };
      }
    }
    return undefined;
  } finally {
    world.close();
  }
};

export interface RunOptions {
  readonly deviations: ReadonlyArray<Deviation>;
  readonly notApplicable: ReadonlyArray<NotApplicable>;
  /** Owners that resolve — a deviation whose owner is not in here counts as a fail. */
  readonly ownerResolves: (owner: string) => boolean;
}

export const runFeature = (feature: SpecFeature, options: RunOptions): ReadonlyArray<ScenarioResult> => {
  const name = featureName(feature.path);
  const notApplicable = options.notApplicable.map((entry) => new RegExp(entry.pattern));
  // Keyed with the line when the entry carries one; a scenario looks itself up both ways.
  const deviations = new Map(
    options.deviations.map((entry) => [deviationKey(featureName(entry.feature), entry.scenario, entry.line), entry]),
  );
  const deviationFor = (scenario: SpecScenario): Deviation | undefined =>
    deviations.get(deviationKey(name, scenario.name, scenario.line)) ??
    deviations.get(deviationKey(name, scenario.name));

  return feature.scenarios.map((scenario): ScenarioResult => {
    // A scenario with no steps — upstream has one, a `# TODO` — ran nothing, and a pass for nothing
    // is the hollow pass the report exists to refuse. Not-applicable, and counted as such.
    if (scenario.steps.length === 0) return { feature: name, scenario, outcome: 'not-applicable' };
    if (scenario.steps.some((step) => notApplicable.some((pattern) => pattern.test(step.text)))) {
      return { feature: name, scenario, outcome: 'not-applicable' };
    }
    const failure = runScenario(scenario);
    const deviation = deviationFor(scenario);
    if (failure === undefined) {
      return { feature: name, scenario, outcome: 'pass', deviationNowPassing: deviation !== undefined };
    }
    if (deviation !== undefined && options.ownerResolves(deviation.owner)) {
      return { feature: name, scenario, outcome: 'deviation', failure };
    }
    return { feature: name, scenario, outcome: 'fail', failure };
  });
};

export const runSpec = (
  features: ReadonlyArray<SpecFeature>,
  options: RunOptions,
): ReadonlyArray<ScenarioResult> => features.flatMap((feature) => runFeature(feature, options));
