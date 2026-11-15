import { EXAMPLES } from './examples.js';
import { Runner, type WorkerLike } from './runner-client.js';
import type { ProgramError, RunResult, Step } from './run.js';
import { decodeShare, encodeShare, LONG_LINK } from './share.js';

/**
 * The page. It draws what the worker answers, and nothing else.
 *
 * 🔴 **Everything drawn from a program's output goes in through `textContent`, never `innerHTML`.** A
 * shared link carries a whole program, so the values it inserts, the names it defines and the errors it
 * provokes are a stranger's text. `test-browser/playground.test.ts` inserts an `<img onerror>` as a
 * value and checks it is shown as text and never becomes an element.
 */
const el = <T extends HTMLElement>(id: string): T => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`#${id} is missing from the page`);
  return found as T;
};
const editor = el<HTMLTextAreaElement>('editor');
const output = el('output');
const examples = el<HTMLSelectElement>('examples');
const runButton = el<HTMLButtonElement>('run');
const stopButton = el<HTMLButtonElement>('stop');
const shareButton = el<HTMLButtonElement>('share');
const status = el('status');

const runner = new Runner(() => new Worker(new URL('worker.js', document.baseURI), { type: 'module' }) as unknown as WorkerLike);

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: { class?: string; text?: string } = {}, ...children: Node[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.text !== undefined) node.textContent = props.text;
  for (const child of children) node.append(child);
  return node;
}

function goToLine(line: number): void {
  const lines = editor.value.split('\n');
  const start = lines.slice(0, line - 1).reduce((offset, text) => offset + text.length + 1, 0);
  editor.focus();
  editor.setSelectionRange(start, start + (lines[line - 1]?.length ?? 0));
}

function errorBox(error: ProgramError): HTMLElement {
  const box = h('p', { class: 'error', text: error.line === undefined ? error.message : `Line ${error.line}: ${error.message}` });
  box.setAttribute('role', 'alert');
  if (error.line !== undefined) {
    const line = error.line;
    const go = h('button', { text: 'Go to line' });
    go.type = 'button';
    go.addEventListener('click', () => goToLine(line));
    box.append(go);
  }
  return box;
}

const KIND = { define: 'Schema', write: 'Write', read: 'Read' } as const;

function stepView(step: Step): HTMLElement {
  const section = h('section', { class: step.error ? 'step has-error' : 'step' });
  section.dataset['kind'] = step.kind;
  section.append(h('header', {}, h('strong', { text: KIND[step.kind] }), h('span', { text: `line ${step.line}` })));
  const body = h('div', { class: 'body' });
  if (step.error) body.append(errorBox(step.error));
  if (step.columns.length > 0) {
    const table = h('table');
    table.append(h('thead', {}, h('tr', {}, ...step.columns.map((column) => h('th', { text: column })))));
    table.append(h('tbody', {}, ...step.rows.map((row) => h('tr', {}, ...row.map((cell) => h('td', { text: cell }))))));
    body.append(table);
    body.append(h('p', { class: 'omitted', text: `${step.rows.length + step.omitted} row${step.rows.length + step.omitted === 1 ? '' : 's'}${step.omitted > 0 ? `, the first ${step.rows.length} shown` : ''}` }));
  }
  for (const document of step.documents) body.append(h('pre', { class: 'documents', text: document }));
  if (step.notes.length > 0) body.append(h('ul', { class: 'notes' }, ...step.notes.map((note) => h('li', { text: note }))));
  section.append(body);
  return section;
}

function draw(result: RunResult): void {
  output.replaceChildren();
  if (result.error) output.append(errorBox(result.error));
  for (const step of result.steps) output.append(stepView(step));
  if (!result.error && result.steps.length === 0) output.append(h('p', { class: 'empty', text: 'Nothing to run.' }));
}

function busy(isBusy: boolean): void {
  runButton.disabled = isBusy;
  stopButton.hidden = !isBusy;
  examples.disabled = isBusy;
}

async function run(): Promise<void> {
  if (runner.running) return;
  busy(true);
  status.textContent = 'Running…';
  const started = performance.now();
  const result = await runner.run(editor.value);
  draw(result);
  busy(false);
  status.textContent = result.error || result.steps.some((step) => step.error) ? 'Stopped at an error.' : `Ran in ${Math.round(performance.now() - started)} ms.`;
}

async function share(): Promise<void> {
  const hash = encodeShare(editor.value);
  history.replaceState(null, '', hash);
  const long = location.href.length > LONG_LINK ? ' It is long: some tools cut long links.' : '';
  try {
    await navigator.clipboard.writeText(location.href);
    status.textContent = `Link copied.${long}`;
  } catch {
    status.textContent = `The link is in the address bar.${long}`;
  }
}

function load(source: string, selected: string): void {
  editor.value = source;
  examples.value = selected;
}

for (const example of EXAMPLES) examples.append(Object.assign(document.createElement('option'), { value: example.id, textContent: example.title }));
examples.append(Object.assign(document.createElement('option'), { value: '', textContent: 'Your program' }));

examples.addEventListener('change', () => {
  const example = EXAMPLES.find((candidate) => candidate.id === examples.value);
  if (example) {
    load(example.source, example.id);
    history.replaceState(null, '', location.pathname + location.search);
    void run();
  }
});
editor.addEventListener('input', () => (examples.value = ''));
editor.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    void run();
  }
});
runButton.addEventListener('click', () => void run());
stopButton.addEventListener('click', () => runner.stop());
shareButton.addEventListener('click', () => void share());

const shared = decodeShare(location.hash);
if (shared !== undefined) {
  load(shared, '');
} else {
  load(EXAMPLES[0]!.source, EXAMPLES[0]!.id);
  if (location.hash.startsWith('#code=')) status.textContent = 'That link could not be read, so here is an example.';
}
void run();
