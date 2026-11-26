import { NotebookSessions, notShown, plainOutput, runCell, type OutputBlock } from '@typedblite/notebook';

import { createCellEditor, type CellEditor } from './cell-editor.js';
import { WorkerKernel, type KernelWorkerLike } from './kernel-client.js';

/**
 * The browser notebook: cells you run, and the engine's answers beneath them. It draws what the shared notebook code
 * (`@typedblite/notebook`, which the VS Code extension runs too) answers from the browser's kernel, and nothing else.
 *
 * 🔴 **Everything drawn from a cell's output goes in through `textContent`, never `innerHTML`.** What a statement inserts,
 * the names it defines and the errors it provokes are whatever the reader typed, so they are text. (The Markdown cells are
 * the one exception: they are HTML built from this repository's own guide at build time, with raw HTML switched off.)
 * `test-browser/notebook.test.ts` inserts an `<img onerror>` as a value and checks it is shown as text.
 */
export interface NotebookData {
  readonly cells: readonly ({ readonly kind: 'markup'; readonly html: string } | { readonly kind: 'code'; readonly source: string })[];
}

/** A rendered block, for a test to read what a reader sees: its kind, and the plain text it shows. */
export interface ShownBlock {
  readonly kind: OutputBlock['kind'];
  readonly plain: string;
}

const NOTEBOOK_URI = 'vscode-notebook-cell:/try/try-it.tql.md';
const ENGINE_STOPPED = 'The engine stopped';

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: { class?: string; text?: string } = {}, ...children: Node[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.text !== undefined) node.textContent = props.text;
  for (const child of children) node.append(child);
  return node;
}

/** One output block as DOM. `data-kind` and `data-plain` say what it is and what it says, for a test and for assistive tools. */
export function blockView(block: OutputBlock): HTMLElement {
  let view: HTMLElement;
  switch (block.kind) {
    case 'table': {
      const table = h('table');
      table.append(h('thead', {}, h('tr', {}, ...block.columns.map((column) => h('th', { text: column })))));
      table.append(h('tbody', {}, ...block.rows.map((row) => h('tr', {}, ...row.map((value) => h('td', { text: value }))))));
      view = h('div', { class: 'nb-table' }, table);
      const cut = notShown(block);
      if (cut) view.append(h('p', { class: 'nb-omitted', text: cut }));
      break;
    }
    case 'json':
      view = h('pre', { class: 'nb-json', text: plainOutput([block]) });
      break;
    case 'facts':
      view = h('pre', { class: 'nb-facts', text: block.lines.join('\n') });
      break;
    case 'heading':
      view = h('p', { class: 'nb-heading', text: block.text });
      break;
    case 'text':
      view = h('p', { class: 'nb-text', text: block.text });
      break;
    case 'refusal': {
      const where = block.line === undefined ? '' : ` (line ${block.line}, column ${block.column})`;
      view = h('p', { class: 'nb-error' }, h('strong', { text: `${block.title}: ` }), document.createTextNode(`${block.message}${where}`));
      view.setAttribute('role', 'alert');
      break;
    }
  }
  view.dataset['kind'] = block.kind;
  view.dataset['plain'] = plainOutput([block]);
  return view;
}

interface CodeCellView {
  readonly index: number;
  readonly editor: CellEditor;
  readonly root: HTMLElement;
  readonly run: HTMLButtonElement;
  readonly label: HTMLElement;
  readonly outputs: HTMLElement;
}

export function mountNotebook(root: HTMLElement, data: NotebookData, createWorker: () => KernelWorkerLike): void {
  const kernel = new WorkerKernel(createWorker);
  const sessions = new NotebookSessions(kernel);
  const runner = sessions.runnerFor('try');
  const status = root.querySelector<HTMLElement>('#nb-status')!;
  const runAll = root.querySelector<HTMLButtonElement>('#nb-run-all')!;
  const stop = root.querySelector<HTMLButtonElement>('#nb-stop')!;
  const restart = root.querySelector<HTMLButtonElement>('#nb-restart')!;
  const cellsHost = root.querySelector<HTMLElement>('#nb-cells')!;

  const cells: CodeCellView[] = [];
  let executions = 0;
  let busy = false;

  const setBusy = (value: boolean): void => {
    busy = value;
    runAll.disabled = value;
    restart.disabled = value;
    stop.hidden = !value;
    for (const cell of cells) cell.run.disabled = value;
  };

  /** Runs one cell: its statements in order against the notebook's one store, stopping at the first refusal. */
  async function runOne(index: number): Promise<boolean> {
    const cell = cells[index]!;
    cell.root.dataset['state'] = 'running';
    cell.label.textContent = '[*]';
    cell.outputs.replaceChildren();
    const result = await runCell(cell.editor.getValue(), kernel, runner, { maxRows: 1000, unavailableTitle: ENGINE_STOPPED });
    executions += 1;
    cell.outputs.replaceChildren(...result.outputs.map(blockView));
    cell.label.textContent = `[${executions}]`;
    cell.root.dataset['state'] = result.failed ? 'failed' : 'done';
    return !result.failed;
  }

  async function runCells(indexes: number[]): Promise<void> {
    if (busy) return;
    setBusy(true);
    let failedAt: number | undefined;
    try {
      for (const index of indexes) {
        status.textContent = `Running cell ${index + 1}…`;
        if (!(await runOne(index))) {
          failedAt = index;
          break;
        }
      }
    } finally {
      setBusy(false);
    }
    status.textContent = failedAt === undefined ? 'Done.' : `Stopped at cell ${failedAt + 1}: it was refused.`;
  }

  const runFrom = (index: number, andNext: boolean): void => {
    void runCells([index]).then(() => {
      if (andNext) cells[index + 1]?.editor.focus();
    });
  };

  data.cells.forEach((cell) => {
    if (cell.kind === 'markup') {
      const prose = h('div', { class: 'nb-markup' });
      prose.innerHTML = cell.html;
      cellsHost.append(prose);
      return;
    }
    const index = cells.length;
    const label = h('span', { class: 'nb-label', text: '[ ]' });
    label.setAttribute('aria-hidden', 'true');
    const run = h('button', { class: 'nb-play', text: '▶' });
    run.type = 'button';
    run.setAttribute('aria-label', `Run cell ${index + 1}`);
    const editorHost = h('div', { class: 'nb-editor' });
    const outputs = h('div', { class: 'nb-outputs' });
    outputs.setAttribute('aria-live', 'polite');
    const section = h('section', { class: 'nb-cell' }, h('div', { class: 'nb-gutter' }, run, label), h('div', { class: 'nb-body' }, editorHost, outputs));
    section.dataset['state'] = 'idle';
    section.dataset['cell'] = String(index);
    cellsHost.append(section);
    const editor = createCellEditor(editorHost, `${NOTEBOOK_URI}#cell${index}`, cell.source, `Cell ${index + 1}`, {
      onRun: () => runFrom(index, false),
      onRunAndNext: () => runFrom(index, true),
    });
    run.addEventListener('click', () => runFrom(index, false));
    cells.push({ index, editor, root: section, run, label, outputs });
  });

  /** The cells as the page opened them: no answers, no run numbers. What the reader typed in them stays. */
  const clearResults = (): void => {
    executions = 0;
    for (const cell of cells) {
      cell.outputs.replaceChildren();
      cell.label.textContent = '[ ]';
      cell.root.dataset['state'] = 'idle';
    }
  };

  runAll.addEventListener('click', () => void runCells(cells.map((cell) => cell.index)));
  stop.addEventListener('click', () => kernel.stop());
  restart.addEventListener('click', () => {
    void sessions.restart('try').then((done) => {
      clearResults();
      status.textContent = done === 'restarted' ? 'Restarted: the notebook has an empty store.' : 'Nothing to restart yet: no cell has run.';
    });
  });

  /** For the browser test, which drives the page as a person does, but cannot type quickly. */
  (window as unknown as { typedbliteNotebook: object }).typedbliteNotebook = {
    cellCount: () => cells.length,
    source: (index: number) => cells[index]!.editor.getValue(),
    setSource: (index: number, text: string) => cells[index]!.editor.setValue(text),
    markers: (index: number) => cells[index]!.editor.markers(),
    shown: (index: number): ShownBlock[] =>
      [...cells[index]!.outputs.children].map((node) => ({ kind: (node as HTMLElement).dataset['kind'] as OutputBlock['kind'], plain: (node as HTMLElement).dataset['plain'] ?? '' })),
    state: (index: number) => cells[index]!.root.dataset['state'],
    status: () => status.textContent,
  };
}
