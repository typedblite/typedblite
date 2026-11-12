import type { DeviceState } from '../shared/device.js';

/** What the page sends its worker. */
export type ToWorker =
  | { readonly type: 'open'; readonly device: string; readonly cursor?: DeviceState['cursor']; readonly fresh?: boolean }
  | { readonly type: 'add'; readonly title: string }
  | { readonly type: 'toggle'; readonly id: string; readonly done: boolean }
  | { readonly type: 'sync' };

/** What the worker sends its page. */
export type FromWorker =
  | ({ readonly type: 'state'; readonly syncing: boolean; readonly synced: readonly string[] } & DeviceState)
  | { readonly type: 'error'; readonly message: string };
