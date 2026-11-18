/**
 * The spike page: the hub's panel (its store, who is connected, a stop/start switch) above three
 * embedded device pages. All of it is one origin, so the browser gives every page the same hub.
 */
import type { FromHub, HubInfo, ToHub } from './wire.js';

const control = new BroadcastChannel('typedblite-spike-hub');
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

let hubWorker: Worker | undefined;
let port: MessagePort | undefined;
let up = false;
let info: HubInfo | undefined;
let tasks: Array<{ id: string; title: string; done: boolean; origin: string }> = [];
let lastAnswer = 0;

/** A fresh port to the running hub, for a device iframe or for this panel. */
function portToHub(): MessagePort {
  const channel = new MessageChannel();
  hubWorker!.postMessage({ type: 'connect' }, [channel.port2]);
  return channel.port1;
}

function connect(): void {
  hubWorker = new Worker('/spike-hub.js', { type: 'module' });
  hubWorker.onerror = (event) => ($('log').textContent = `hub worker error: ${event.message}`);
  port = portToHub();
  port.onmessage = (event: MessageEvent<FromHub>) => {
    lastAnswer = Date.now();
    if (event.data.type === 'tasks') tasks = event.data.tasks as typeof tasks;
    if (event.data.type === 'info') info = event.data.info;
    render();
  };
  port.start();
  up = true;
}

// The device iframes are same-origin children, so they call this directly.
(window as unknown as { spikeHub: unknown }).spikeHub = { connect: portToHub };

const ask = (message: ToHub): void => port?.postMessage(message);

function render(): void {
  $('hub-state').textContent = up ? 'Hub up' : 'Hub down';
  $('hub-state').dataset['tone'] = up ? 'on' : 'off';
  $('toggle').textContent = up ? 'Take the hub down' : 'Bring the hub up';
  $('hub-info').textContent = info
    ? `${info.opfs ? 'store open in a dedicated Worker (OPFS)' : 'store NOT open: ' + info.lastOpenError} · ${info.peers} port(s) · ${info.requests} requests · ${info.openStreams} open stream(s) · opened ${info.openedAt} after ${info.openAttempts} attempt(s)`
    : up ? 'opening the store…' : 'the hub process is gone; its store is still in OPFS';
  const list = $('hub-tasks');
  list.replaceChildren(
    ...(up ? tasks : []).map((task) => {
      const li = document.createElement('li');
      li.textContent = `${task.done ? '✓' : '○'} ${task.title} — ${task.origin}`;
      return li;
    }),
  );
  $('hub-count').textContent = up ? String(tasks.length) : '–';
}

$('toggle').onclick = () => {
  if (up) {
    // The hub process dies: nothing is flushed or closed. What it wrote is in OPFS, or it is lost.
    hubWorker?.terminate();
    hubWorker = undefined;
    up = false;
    info = undefined;
    tasks = [];
    port = undefined;
    control.postMessage({ type: 'down' });
  } else {
    connect();
    control.postMessage({ type: 'up' });
  }
  render();
};

setInterval(() => {
  if (!up) return;
  ask({ type: 'tasks' });
  ask({ type: 'info' });
}, 500);
setInterval(() => $('hub-state').toggleAttribute('data-stale', up && Date.now() - lastAnswer > 3000), 1000);

(window as unknown as { spike: unknown }).spike = {
  state: () => ({ up, info, tasks }),
  down: () => $('toggle').click(),
};
connect();
render();
