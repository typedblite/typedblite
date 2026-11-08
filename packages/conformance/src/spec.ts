import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { AstBuilder, GherkinClassicTokenMatcher, Parser, compile } from '@cucumber/gherkin';
import { IdGenerator, type GherkinDocument, type Pickle, type PickleStep } from '@cucumber/messages';

/**
 * The vendored specification, parsed.
 *
 * 🔴 Pickles, not scenarios. A `Scenario Outline` is one scenario in the file and N in the run,
 * one per Examples row — and the report card counts what ran. `grep -c Scenario` says 935 for the
 * pinned `query/language/`; the pickle count is higher, and that is the total the four outcomes
 * must sum to.
 */
export interface SpecStep {
  readonly text: string;
  readonly docString?: string;
  readonly table?: ReadonlyArray<ReadonlyArray<string>>;
  /** True when the step came from the feature's `Background`, so a failure can be attributed. */
  readonly fromBackground: boolean;
  readonly line: number;
}

export interface SpecScenario {
  /** `query/language/match.feature` — relative to the spec root, forward slashes. */
  readonly feature: string;
  readonly name: string;
  readonly line: number;
  readonly steps: ReadonlyArray<SpecStep>;
}

export interface SpecFeature {
  readonly path: string;
  readonly scenarios: ReadonlyArray<SpecScenario>;
}

const newId = IdGenerator.uuid();

const parseDocument = (text: string): GherkinDocument =>
  new Parser(new AstBuilder(newId), new GherkinClassicTokenMatcher()).parse(text);

/** The AST ids of every Background step, so a pickle step can say where it came from. */
const backgroundStepIds = (document: GherkinDocument): Set<string> => {
  const ids = new Set<string>();
  for (const child of document.feature?.children ?? []) {
    for (const step of child.background?.steps ?? []) ids.add(step.id);
  }
  return ids;
};

/**
 * The line a pickle or pickle step came from. 🔴 An outline pickle's `astNodeIds` name the
 * Scenario Outline AND its Examples row; the row wins, because every row of a placeholder-free
 * outline otherwise shares one name and one line, and nothing could then name exactly one of them.
 */
const lineOf = (document: GherkinDocument, astNodeIds: readonly string[]): number => {
  const wanted = new Set(astNodeIds);
  let scenarioLine = 0;
  for (const child of document.feature?.children ?? []) {
    const holders = [child.background, child.scenario].filter((h) => h !== undefined);
    for (const holder of holders) {
      for (const step of holder.steps) if (wanted.has(step.id)) return step.location.line;
    }
    if (!child.scenario) continue;
    for (const examples of child.scenario.examples) {
      for (const row of examples.tableBody) if (wanted.has(row.id)) return row.location.line;
    }
    if (wanted.has(child.scenario.id)) scenarioLine = child.scenario.location.line;
  }
  return scenarioLine;
};

const toStep = (document: GherkinDocument, background: Set<string>, step: PickleStep): SpecStep => ({
  text: step.text,
  docString: step.argument?.docString?.content,
  table: step.argument?.dataTable?.rows.map((row) => row.cells.map((cell) => cell.value)),
  fromBackground: step.astNodeIds.some((id) => background.has(id)),
  line: lineOf(document, step.astNodeIds),
});

const toScenario = (feature: string, document: GherkinDocument, background: Set<string>) =>
  (pickle: Pickle): SpecScenario => ({
    feature,
    name: pickle.name,
    line: lineOf(document, pickle.astNodeIds),
    steps: pickle.steps.map((step) => toStep(document, background, step)),
  });

export const loadFeature = (specRoot: string, absolutePath: string): SpecFeature => {
  const path = relative(specRoot, absolutePath).split('\\').join('/');
  const document = parseDocument(readFileSync(absolutePath, 'utf8'));
  const pickles = compile(document, path, newId);
  return { path, scenarios: pickles.map(toScenario(path, document, backgroundStepIds(document))) };
};

/** Every `.feature` under `<specRoot>/query/language`, in name order. */
export const loadSpec = (specRoot: string): ReadonlyArray<SpecFeature> => {
  const directory = join(specRoot, 'query', 'language');
  return readdirSync(directory)
    .filter((name) => name.endsWith('.feature'))
    .sort()
    .map((name) => loadFeature(specRoot, join(directory, name)));
};

export const featureName = (path: string): string => basename(path, '.feature');
