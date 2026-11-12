/**
 * The desktop device: an Electron window on the demo server's page, as `?device=electron`.
 *
 * 🔴 Its own profile directory is what makes it its own device. OPFS, the service worker and
 * `localStorage` all live in the profile, so a window that shared the browser's profile would share
 * its store. `--profile <dir>` sets it (default: `apps/sync-demo/.data/electron-profile`); `--url` points at the
 * demo server (default `http://localhost:4300`); `--fresh` wipes the device's store on open;
 * `--hidden` keeps the window off screen. `--x`, `--y` place it.
 */
import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';

const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] : undefined;
};

const base = argument('url') ?? process.env['DEMO_URL'] ?? 'http://localhost:4300';
// Beside the build (`.build/../.data`), wherever it is started from.
const profile = argument('profile') ?? join(__dirname, '..', '.data', 'electron-profile');
app.setPath('userData', profile);

void app.whenReady().then(() => {
  const place = (name: string): number | undefined => (argument(name) === undefined ? undefined : Number(argument(name)));
  const window = new BrowserWindow({
    width: 420,
    height: 760,
    x: place('x'),
    y: place('y'),
    title: 'Tasks · Desktop',
    autoHideMenuBar: true,
    // `--hidden`: the driver's headless runs, so a verification does not open windows on a desktop.
    show: !process.argv.includes('--hidden'),
    // 🔴 `backgroundThrottling: false`: a device keeps syncing at full rate when its window is behind
    // others or hidden. Throttled, an idle hidden window stopped painting, and a click on it waited
    // forever for the frame that proves the element stable — found by pausing a headless story run.
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  const fresh = process.argv.includes('--fresh') ? '&fresh' : '';
  void window.loadURL(`${base}/?device=electron${fresh}`);
});

app.on('window-all-closed', () => app.quit());
