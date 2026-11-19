import { mountNotebook, type NotebookData } from './notebook-page.js';
import type { KernelWorkerLike } from './kernel-client.js';

/**
 * The browser notebook's entry: finds the page, loads the notebook's cells (built from the guide, `try-data.json`, beside
 * this script), and mounts them on a kernel worker.
 */
const root = document.getElementById('nb');
if (!root) throw new Error('#nb is missing from the page');

const response = await fetch(new URL('try-data.json', import.meta.url));
if (!response.ok) throw new Error(`The notebook could not be loaded (${response.status}).`);
const data = (await response.json()) as NotebookData;

mountNotebook(root, data, () => new Worker(new URL('kernel-worker.js', import.meta.url), { type: 'module' }) as unknown as KernelWorkerLike);
