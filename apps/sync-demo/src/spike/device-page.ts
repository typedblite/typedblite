/**
 * The device's page: the task list, the add box, and what the sync is doing. The engine runs in the
 * worker; this only renders what it publishes, and saves the sync cursor (a worker has no
 * `localStorage`) so a reloaded or restarted device resumes where it stopped.
 *
 * `?device=pwa|electron|android` names the device; `?fresh` wipes its store first. The driver reads
 * `window.typedbliteDemo`.
 */
import type { FromWorker, ToWorker } from '../client/protocol.js';

type State = Extract<FromWorker, { type: 'state' }>;

const params = new URLSearchParams(location.search);
const control = new BroadcastChannel('typedblite-spike-hub');
const device = params.get('device') ?? 'pwa';
const LABELS: Record<string, string> = { a: 'Device A', b: 'Device B', c: 'Device C' };
const label = LABELS[device] ?? device;
const cursorKey = `typedblite-demo-cursor-${device}`;

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode or blocked storage: the device still works, it just re-reads more on restart.
  }
};

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
document.title = `Tasks · ${label}`;
$('device').textContent = label;
document.documentElement.dataset['device'] = device;

const worker = new Worker('/spike-device-worker.js', { type: 'module' });

/**
 * Ask the embedding page for a MessagePort to the hub (a dedicated Worker it owns, which holds the store in
 * OPFS) and give this device's engine the other end. Called again when the hub is brought back: a
 * terminated hub's port is dead, and the page starts a fresh worker.
 */
type HubHost = { connect(): MessagePort };
function connectHub(): void {
  const host = (window.parent as unknown as { spikeHub?: HubHost }).spikeHub;
  const port = host?.connect() ?? null;
  worker.postMessage({ type: 'hub-port', port }, port ? [port] : []);
}
control.onmessage = (event: MessageEvent<{ type: 'up' | 'down' }>) => {
  if (event.data.type === 'down') worker.postMessage({ type: 'hub-port', port: null });
  else connectHub();
};
connectHub();
const send = (message: ToWorker): void => worker.postMessage(message);
let latest: State | undefined;
let lastError: string | undefined;

function status(state: State): { text: string; tone: string } {
  if (state.online === undefined) return { text: 'Connecting…', tone: 'wait' };
  if (state.online === false) return { text: 'Offline — working locally', tone: 'off' };
  return { text: state.syncing ? 'Syncing…' : 'Online · in sync', tone: 'on' };
}

function render(state: State): void {
  const { text, tone } = status(state);
  $('status').textContent = text;
  $('status').dataset['tone'] = tone;
  $('pending').textContent = state.pending === 0 ? '' : `${state.pending} change${state.pending === 1 ? '' : 's'} waiting to sync`;
  renderTasks(state.tasks, new Set(state.synced));
  $('empty').hidden = state.tasks.length > 0;
}

/**
 * Update the list in place, keyed by task id.
 *
 * 🔴 Not `replaceChildren` on every state: the worker publishes on every sync, twice a cycle, and
 * rebuilding the rows detached the very checkbox a user was clicking — the click was lost. Found by
 * the story driver, whose click on a desktop row timed out once the rebuilds lined up with it. A row
 * is created once, changed in place, and moved only when the order changes.
 */
const rows = new Map<string, { item: HTMLLIElement; box: HTMLInputElement; title: HTMLSpanElement; done: boolean }>();

function renderTasks(tasks: State['tasks'], flash: ReadonlySet<string>): void {
  const list = $('tasks');
  const current = new Set(tasks.map((task) => task.id));
  for (const [id, row] of rows) {
    if (!current.has(id)) {
      row.item.remove();
      rows.delete(id);
    }
  }
  tasks.forEach((task, index) => {
    let row = rows.get(task.id);
    if (!row) {
      const item = document.createElement('li');
      item.dataset['id'] = task.id;
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.onchange = () => send({ type: 'toggle', id: task.id, done: box.checked });
      const title = document.createElement('span');
      title.className = 'title';
      const origin = document.createElement('span');
      origin.className = 'origin';
      origin.textContent = LABELS[task.origin] ?? task.origin;
      const label = document.createElement('label');
      label.append(box, title, origin);
      item.append(label);
      row = { item, box, title, done: !task.done };
      rows.set(task.id, row);
    }
    if (row.title.textContent !== task.title) {
      row.title.textContent = task.title;
      row.box.setAttribute('aria-label', task.title);
    }
    if (row.done !== task.done) {
      row.done = task.done;
      row.box.checked = task.done;
      row.item.classList.toggle('done', task.done);
    }
    if (flash.has(task.id)) {
      row.item.classList.add('flash');
      requestAnimationFrame(() => requestAnimationFrame(() => row?.item.classList.remove('flash')));
    }
    if (list.children[index] !== row.item) list.insertBefore(row.item, list.children[index] ?? null);
  });
}

worker.onmessage = (event: MessageEvent<FromWorker>) => {
  const message = event.data;
  if (message.type === 'error') {
    lastError = message.message;
    $('error').textContent = message.message;
    $('error').hidden = false;
    return;
  }
  latest = message;
  write(cursorKey, JSON.stringify(message.cursor));
  render(message);
};

$<HTMLFormElement>('add').onsubmit = (event) => {
  event.preventDefault();
  const input = $<HTMLInputElement>('title');
  if (input.value.trim()) send({ type: 'add', title: input.value });
  input.value = '';
};

const saved = read(cursorKey);
send({ type: 'open', device, cursor: saved ? (JSON.parse(saved) as State['cursor']) : undefined, fresh: params.has('fresh') });
if (params.has('fresh')) history.replaceState(null, '', `?device=${encodeURIComponent(device)}`);

// The driver's handle: read what the page shows, and act as a user would.
(window as unknown as { typedbliteDemo: unknown }).typedbliteDemo = {
  device,
  state: () => latest,
  error: () => lastError,
  add: (title: string) => send({ type: 'add', title }),
  toggle: (id: string, done: boolean) => send({ type: 'toggle', id, done }),
  sync: () => send({ type: 'sync' }),
};


