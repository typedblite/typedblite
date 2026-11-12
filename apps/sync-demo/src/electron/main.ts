/**
 * The desktop device: an Electron window on the demo server's page, as `?device=electron`.
 *
 * 🔴 Its own profile directory is what makes it its own device. OPFS, the service worker and
 * `localStorage` all live in the profile, so a window that shared the browser's profile would share
 * its store. `--profile <dir>` sets it (default: `.data/electron-profile`); `--url` points at the
 * demo server (default `http://localhost:4300`); `--fresh` wipes the device's store on open.
 */
import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';

const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] : undefined;
};

const base = argument('url') ?? process.env['DEMO_URL'] ?? 'http://localhost:4300';
const profile = argument('profile') ?? join(process.cwd(), '.data', 'electron-profile');
app.setPath('userData', profile);

void app.whenReady().then(() => {
  const window = new BrowserWindow({
    width: 420,
    height: 760,
    title: 'Tasks · Desktop',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  const fresh = process.argv.includes('--fresh') ? '&fresh' : '';
  void window.loadURL(`${base}/?device=electron${fresh}`);
});

app.on('window-all-closed', () => app.quit());
