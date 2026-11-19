/**
 * One embedded device's page: the task list, the add box, what the sync is doing, and this device's own
 * Disconnect / Reconnect switch. A copy of `../client/main.ts` (the shipped device page) with three differences: its
 * engine reaches the hub through a `MessagePort` the embedding page hands it (`window.parent.browserHub`) instead of
 * `fetch` through the switchboard, it has the switch, and it follows the embedding page's light/dark theme.
 *
 * `?device=a|b|c` names the device; `?fresh` wipes its store first. Tests read `window.typedbliteDemo`.
 */
import type { FromWorker, ToWorker } from '../client/protocol.js';

type State = Extract<FromWorker, { type: 'state' }>;

const params = new URLSearchParams(location.search);
const control = new BroadcastChannel('typedblite-browser-hub');
const device = params.get('device') ?? 'pwa';
const LABELS: Record<string, string> = { a: 'Device A', b: 'Device B', c: 'Device C' };
const label = LABELS[device] ?? device;
const cursorKey = `typedblite-browser-hub-cursor-${device}`;

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

/**
 * Follow the embedding page's `data-theme` (Starlight's light/dark switch), which a `prefers-color-scheme` media query
 * inside an iframe cannot see. With no embedding page, or one that sets none, the media query decides.
 */
function followParentTheme(): void {
  if (window.parent === window) return;
  try {
    const root = window.parent.document.documentElement;
    const apply = (): void => {
      const theme = root.dataset['theme'];
      if (theme === 'light' || theme === 'dark') document.documentElement.dataset['theme'] = theme;
      else delete document.documentElement.dataset['theme'];
    };
    apply();
    new MutationObserver(apply).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
  } catch {
    // A cross-origin parent: the media query decides.
  }
}
followParentTheme();

const worker = new Worker(new URL('./device-worker.js', import.meta.url), { type: 'module' });

/**
 * Ask the embedding page for a MessagePort to the hub (a dedicated Worker it owns, which holds the store in
 * OPFS) and give this device's engine the other end. Called again when the hub is brought back: a
 * terminated hub's port is dead, and the page starts a fresh worker.
 */
type HubHost = { connect(): MessagePort };
let disconnected = false;
function connectHub(): void {
  if (disconnected) return;
  const host = (window.parent as unknown as { browserHub?: HubHost }).browserHub;
  const port = host?.connect() ?? null;
  worker.postMessage({ type: 'hub-port', port }, port ? [port] : []);
}
control.onmessage = (event: MessageEvent<{ type: 'up' | 'down' }>) => {
  if (event.data.type === 'down') worker.postMessage({ type: 'hub-port', port: null });
  else connectHub();
};

/**
 * This device's own switch: cut its line to the hub (it keeps working locally and queues its changes)
 * and restore it. A device the user disconnected stays disconnected when the hub comes back up.
 */
$<HTMLButtonElement>('link').onclick = () => {
  disconnected = !disconnected;
  const button = $<HTMLButtonElement>('link');
  button.textContent = disconnected ? 'Reconnect' : 'Disconnect';
  button.setAttribute('aria-pressed', String(disconnected));
  if (disconnected) worker.postMessage({ type: 'hub-port', port: null });
  else connectHub();
  send({ type: 'sync' }); // so the status line follows at once, not on the next 1.5 s tick
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
      item.dataset['origin'] = task.origin; // devices.css: the highlight that fades takes the colour of the device that made the task
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.onchange = () => send({ type: 'toggle', id: task.id, done: box.checked });
      const title = document.createElement('span');
      title.className = 'title';
      const origin = document.createElement('span');
      origin.className = 'origin';
      origin.textContent = LABELS[task.origin] ?? task.origin;
      origin.dataset['origin'] = task.origin; // devices.css colours it by the device that made the task
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


