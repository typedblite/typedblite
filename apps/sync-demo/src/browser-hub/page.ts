/**
 * The page that owns the hub: its panel (what it holds, who is connected, a switch to kill and restart it, a reset)
 * above three embedded device pages. The hub is a dedicated Worker on WASM SQLite and OPFS (`hub-worker.ts`), and
 * the page hands each device a `MessagePort` to it (`window.browserHub.connect`, which the same-origin device
 * iframes call). Every URL is relative to this script, so the page can be served from any path.
 */
import type { FromHub, HubInfo, ToHub } from './wire.js';

type HubTask = { id: string; title: string; done: boolean; origin: string };

const control = new BroadcastChannel('typedblite-browser-hub');
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const LABELS: Record<string, string> = { a: 'Device A', b: 'Device B', c: 'Device C' };

let hubWorker: Worker | undefined;
let port: MessagePort | undefined;
let info: HubInfo | undefined;
let tasks: HubTask[] = [];
let poll: ReturnType<typeof setInterval> | undefined;

/** A fresh port to the running hub, for a device iframe or for this panel; `null` while there is no hub. */
function portToHub(): MessagePort | null {
  if (!hubWorker) return null;
  const channel = new MessageChannel();
  hubWorker.postMessage({ type: 'connect' }, [channel.port2]);
  return channel.port1;
}

function startHub(fresh = false): void {
  hubWorker = new Worker(new URL(`./hub.js${fresh ? '?fresh' : ''}`, import.meta.url), { type: 'module' });
  const own = portToHub()!;
  port = own;
  own.onmessage = (event: MessageEvent<FromHub>) => {
    if (event.data.type === 'tasks') tasks = event.data.tasks as HubTask[];
    if (event.data.type === 'info') info = event.data.info;
    render();
  };
  own.start();
  poll = setInterval(() => {
    ask({ type: 'tasks' });
    ask({ type: 'info' });
  }, 500);
}

/** The hub process dies: nothing is flushed or closed. What it wrote is in OPFS, or it is lost. */
function killHub(): void {
  hubWorker?.terminate();
  hubWorker = undefined;
  port?.close();
  port = undefined;
  clearInterval(poll);
  info = undefined;
  tasks = [];
}

const ask = (message: ToHub): void => port?.postMessage(message);
const up = (): boolean => hubWorker !== undefined;

const HELD = /access handle|NoModification/i;

function render(): void {
  const state = up() ? (info?.state ?? 'opening') : 'down';
  $('bh-state').textContent = { down: 'Hub down', opening: 'Hub starting…', open: 'Hub up', failed: 'Hub cannot open its store' }[state];
  $('bh-state').dataset['tone'] = { down: 'off', opening: 'wait', open: 'on', failed: 'off' }[state];
  $('bh-toggle').textContent = up() ? 'Take the hub down' : 'Bring the hub back up';
  $('bh-count').textContent = state === 'open' ? String(tasks.length) : '–';

  const detail = {
    down: 'The hub process is gone. Its store is still in this browser (OPFS), so when it is back it carries on from what it held.',
    opening: info?.openError ? 'Waiting for the store: another page may still hold it…' : 'Opening the hub’s store…',
    open: `Store open on OPFS, in a dedicated Worker · ${info?.peers ?? 0} connections · ${info?.requests ?? 0} requests · ${info?.openStreams ?? 0} open streams`,
    failed: '',
  }[state];
  $('bh-info').textContent = detail;

  const alert = $('bh-alert');
  alert.hidden = state !== 'failed';
  if (state === 'failed') {
    alert.textContent = HELD.test(info?.openError ?? '')
      ? 'Another tab of this page has the hub’s store open, and only one page can own it. Close the other tab, then reload this one.'
      : `The hub could not open its store: ${info?.openError ?? 'unknown error'}`;
  }

  $('bh-tasks').replaceChildren(
    ...(state === 'open' ? tasks : []).map((task) => {
      const item = document.createElement('li');
      const origin = document.createElement('span');
      origin.className = 'bh-origin';
      origin.dataset['origin'] = task.origin; // app.css colors it with the device's color (devices.css)
      origin.textContent = LABELS[task.origin] ?? task.origin;
      item.append(`${task.done ? '✓' : '○'} ${task.title} — `, origin);
      return item;
    }),
  );
}

$('bh-toggle').onclick = () => {
  if (up()) {
    killHub();
    control.postMessage({ type: 'down' });
  } else {
    startHub();
    control.postMessage({ type: 'up' });
  }
  render();
};

/** Wipe the hub's store and every device's, and start again: the hub is restarted fresh, and each device page reloaded fresh. */
$('bh-reset').onclick = () => {
  killHub();
  startHub(true);
  for (const frame of document.querySelectorAll<HTMLIFrameElement>('.bh-devices iframe')) {
    const url = new URL(frame.getAttribute('src') ?? '', document.baseURI);
    url.searchParams.set('fresh', String(Date.now()));
    frame.src = url.href;
  }
  render();
};

// The device iframes are same-origin children, so they call this directly.
(window as unknown as { browserHub: unknown }).browserHub = {
  connect: portToHub,
  state: () => ({ up: up(), info, tasks }),
};
startHub();
render();
