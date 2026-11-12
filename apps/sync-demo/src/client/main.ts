/**
 * The device's page: the task list, the add box, and what the sync is doing. The engine runs in the
 * worker; this only renders what it publishes, and saves the sync cursor (a worker has no
 * `localStorage`) so a reloaded or restarted device resumes where it stopped.
 *
 * `?device=pwa|electron|android` names the device; `?fresh` wipes its store first. The driver reads
 * `window.typedbliteDemo`.
 */
import type { FromWorker, ToWorker } from './protocol.js';

type State = Extract<FromWorker, { type: 'state' }>;

const params = new URLSearchParams(location.search);
const device = params.get('device') ?? 'pwa';
const LABELS: Record<string, string> = { pwa: 'Browser', electron: 'Desktop', android: 'Phone' };
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

const worker = new Worker('/worker.js', { type: 'module' });
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
  const flash = new Set(state.synced);
  const list = $('tasks');
  list.replaceChildren(
    ...state.tasks.map((task) => {
      const item = document.createElement('li');
      item.dataset['id'] = task.id;
      if (flash.has(task.id)) item.classList.add('flash');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = task.done;
      box.setAttribute('aria-label', task.title);
      box.onchange = () => send({ type: 'toggle', id: task.id, done: box.checked });
      const title = document.createElement('span');
      title.className = 'title';
      title.textContent = task.title;
      const origin = document.createElement('span');
      origin.className = 'origin';
      origin.textContent = LABELS[task.origin] ?? task.origin;
      const row = document.createElement('label');
      row.append(box, title, origin);
      item.append(row);
      item.classList.toggle('done', task.done);
      return item;
    }),
  );
  $('empty').hidden = state.tasks.length > 0;
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

if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
