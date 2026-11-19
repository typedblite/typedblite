/**
 * The in-browser hub's build output (`.build-browser/`, from `build-browser-hub.mjs`). These are the properties the
 * website depends on and a browser would only show as a blank page: the files are all there, nothing is addressed
 * from `/`, so the page works at any URL; nothing in the browser bundles reaches for Node; the device page is the
 * shipped one with the three differences and no more; and the page's styles stay inside the page.
 *
 * Needs the build: `nx run sync-demo:build-browser` (the `test` target depends on it).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUILD = fileURLToPath(new URL('../.build-browser', import.meta.url));
const CLIENT = fileURLToPath(new URL('../src/client/index.html', import.meta.url));
const read = (name: string): string => readFileSync(join(BUILD, name), 'utf8');
const FILES = ['index.html', 'app.html', 'app.css', 'devices.css', 'device.html', 'page.js', 'hub.js', 'device-worker.js', 'device.js', 'sqlite3.wasm'];

beforeAll(() => {
  if (!existsSync(join(BUILD, 'index.html'))) throw new Error(`No build at ${BUILD}. Run: npm exec nx -- run sync-demo:build-browser`);
});

describe('the files', () => {
  it.each(FILES)('has %s, and it is not empty', (name) => {
    expect(existsSync(join(BUILD, name))).toBe(true);
    expect(readFileSync(join(BUILD, name)).length).toBeGreaterThan(100);
  });

  it('ships SQLite’s WASM module', () => {
    expect([...readFileSync(join(BUILD, 'sqlite3.wasm')).subarray(0, 4)]).toEqual([0x00, 0x61, 0x73, 0x6d]);
  });

  it('has a source map beside each script', () => {
    for (const script of ['page.js', 'hub.js', 'device-worker.js', 'device.js']) expect(readdirSync(BUILD)).toContain(`${script}.map`);
  });
});

describe('relocatable: nothing is addressed from the root', () => {
  it.each(['index.html', 'app.html', 'device.html'])('%s has no absolute href or src', (name) => {
    expect(read(name).match(/(?:href|src)="\/[^"]*"/g) ?? []).toEqual([]);
  });

  it.each(['page.js', 'hub.js', 'device-worker.js', 'device.js'])('%s has no absolute URL for a script, worker or the .wasm', (name) => {
    const bad = read(name).match(/["'`]\/[\w.-]+\.(?:js|wasm|html)(?:\?[^"'`]*)?["'`]/g) ?? [];
    expect(bad).toEqual([]);
  });

  it('finds its workers and the .wasm beside itself, through import.meta.url', () => {
    expect(read('page.js')).toMatch(/new URL\([^)]*hub\.js[^)]*import\.meta\.url\)/);
    expect(read('device.js')).toMatch(/new URL\([^)]*device-worker\.js[^)]*import\.meta\.url\)/);
    expect(read('hub.js')).toMatch(/new URL\(file, [\w.]*location\.href\)/);
    expect(read('device-worker.js')).toMatch(/new URL\(file, [\w.]*location\.href\)/);
  });

  it('points the embedded devices at device.html relative to the page', () => {
    const frames = [...read('app.html').matchAll(/<iframe[^>]*src="([^"]+)"/g)].map((m) => m[1]);
    expect(frames).toEqual(['device.html?device=a', 'device.html?device=b', 'device.html?device=c']);
  });
});

describe('the browser bundles', () => {
  it.each(['page.js', 'hub.js', 'device-worker.js', 'device.js'])('%s reaches for no Node module', (name) => {
    // An import or a require of a Node module; the unminified bundle also mentions `node:sqlite` in comments.
    expect(read(name)).not.toMatch(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["'](?:node:[\w/]+|fs|http|https|net|path|crypto|child_process)["']/);
  });

  it('puts TypeDBLite’s engine in the hub and the device workers, and not in the page scripts', () => {
    for (const name of ['hub.js', 'device-worker.js']) expect(read(name)).toContain('TypeDBLiteInterpreter');
    for (const name of ['page.js', 'device.js']) expect(read(name)).not.toContain('TypeDBLiteInterpreter');
  });
});

describe('the page', () => {
  it('puts the same fragment in index.html as app.html', () => {
    expect(read('index.html')).toContain(read('app.html').trim());
    expect(read('index.html')).not.toContain('<!--@APP-->');
  });

  it('has the controls the page script and the tests use, once each', () => {
    for (const id of ['bh-state', 'bh-toggle', 'bh-reset', 'bh-count', 'bh-info', 'bh-alert', 'bh-tasks']) {
      expect(read('app.html').match(new RegExp(`id="${id}"`, 'g'))).toHaveLength(1);
    }
  });

  it('announces the hub’s state and a failure to assistive technology', () => {
    const html = read('app.html');
    expect(html).toMatch(/id="bh-state"[^>]*role="status"/);
    expect(html).toMatch(/id="bh-alert"[^>]*role="alert"/);
    for (const letter of ['A', 'B', 'C']) expect(html).toContain(`title="Device ${letter}"`);
  });

  it('scopes every style to .bh, so it cannot leak into the site that embeds it', () => {
    const css = read('app.css').replace(/\/\*[\s\S]*?\*\//g, '');
    const selectors = [...css.matchAll(/(^|\})\s*([^{}]+)\{/g)].map((m) => m[2]!.trim());
    expect(selectors.length).toBeGreaterThan(5);
    for (const selector of selectors) for (const part of selector.split(',')) expect(part.trim()).toMatch(/^\.bh\b/);
  });

  it('reads colours only from --bh-* properties and the devices’ own', () => {
    const css = read('app.css');
    const used = [...css.matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]!);
    expect(used.length).toBeGreaterThan(5);
    // Its own `--bh-*`, and the devices' colours, which `devices.css` defines for every page that names a device.
    expect(used.filter((name) => !name.startsWith('--bh-') && !name.startsWith('--device-'))).toEqual([]);
  });

  it('defines every --bh-* property the stylesheet reads, in the standalone page', () => {
    const used = new Set([...read('app.css').matchAll(/var\((--bh-[\w-]+)\)/g)].map((m) => m[1]!));
    const html = read('index.html');
    for (const name of used) expect(html, `${name} is not defined in index.html`).toContain(`${name}:`);
  });
});

describe('the device page', () => {
  const shipped = readFileSync(CLIENT, 'utf8');
  const palettes = (html: string): { light: string; dark: string } => ({
    light: html.match(/^\s*:root\s*\{([^}]*)\}/m)![1]!.replace(/\s+/g, ' ').trim(),
    dark: html.match(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{([^}]*)\}/)![1]!.replace(/\s+/g, ' ').trim(),
  });

  it('keys the light and dark palettes on data-theme with the shipped page’s own values', () => {
    const device = read('device.html');
    const { light, dark } = palettes(shipped);
    const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();
    expect(norm(device)).toContain(`:root[data-theme="light"] { ${light} }`);
    expect(norm(device)).toContain(`:root[data-theme="dark"] { ${dark} }`);
  });

  it('keeps the shipped page’s own media query, for a page that is not embedded', () => {
    expect(read('device.html')).toContain('@media (prefers-color-scheme: dark)');
  });

  it('has the Disconnect switch in the header, not pressed, and loads its own script', () => {
    const device = read('device.html');
    expect(device).toMatch(/<header>[\s\S]*<button id="link" type="button" aria-pressed="false">Disconnect<\/button>[\s\S]*<\/header>/);
    expect(device).toContain('<script type="module" src="device.js"></script>');
  });

  it('drops the PWA manifest and icon links, which are the shipped client’s', () => {
    const device = read('device.html');
    expect(device).not.toContain('manifest');
    expect(device).not.toContain('rel="icon"');
    expect(shipped).toContain('manifest');
  });

  it('is otherwise the shipped page: its form, list and status are all still there', () => {
    const device = read('device.html');
    for (const id of ['device', 'status', 'pending', 'add', 'title', 'tasks', 'empty', 'error']) expect(device).toContain(`id="${id}"`);
  });
});

describe('the devices’ colours', () => {
  type Palette = Record<'a' | 'b' | 'c', string>;
  const css = read('devices.css').replace(/\/\*[\s\S]*?\*\//g, '');
  /** The three colours a rule block sets. */
  const palette = (block: string): Palette => ({
    a: block.match(/--device-a:\s*(#[0-9a-f]{6})/i)![1]!.toLowerCase(),
    b: block.match(/--device-b:\s*(#[0-9a-f]{6})/i)![1]!.toLowerCase(),
    c: block.match(/--device-c:\s*(#[0-9a-f]{6})/i)![1]!.toLowerCase(),
  });
  const block = (selector: string): string => css.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`))![1]!;
  const light = palette(block(':root'));
  const dark = palette(css.match(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{([^}]*)\}/)![1]!);

  const rgb = (hex: string): number[] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const luminance = (hex: string): number => {
    const [r, g, b] = rgb(hex).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (x: string, y: string): number => {
    const [hi, lo] = [luminance(x), luminance(y)].sort((m, n) => n - m) as [number, number];
    return (hi + 0.05) / (lo + 0.05);
  };
  const hue = (hex: string): number => {
    const [r, g, b] = rgb(hex) as [number, number, number];
    const max = Math.max(r, g, b);
    const d = max - Math.min(r, g, b);
    const h = d === 0 ? 0 : max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return (h * 60 + 360) % 360;
  };
  const apart = (x: string, y: string): number => {
    const d = Math.abs(hue(x) - hue(y));
    return Math.min(d, 360 - d);
  };

  // What the colours sit on, and what already means something, read from the pages themselves.
  const shipped = readFileSync(CLIENT, 'utf8');
  /** `#fff` is `#ffffff`. */
  const full = (hex: string): string => (hex.length === 4 ? `#${[...hex.slice(1)].map((c) => c + c).join('')}` : hex).toLowerCase();
  const vars = (text: string): Record<string, string> => Object.fromEntries([...text.matchAll(/(--[\w-]+):\s*(#[0-9a-f]{3,6})\b/gi)].map((m) => [m[1]!, full(m[2]!)]));
  const lightPage = vars(shipped.match(/^\s*:root\s*\{([^}]*)\}/m)![1]!);
  const darkPage = vars(shipped.match(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{([^}]*)\}/)![1]!);
  const themes = { light: { colours: light, page: lightPage }, dark: { colours: dark, page: darkPage } } as const;
  const names = ['a', 'b', 'c'] as const;

  it('is one colour per device, three different ones, in each theme', () => {
    for (const { colours } of Object.values(themes)) expect(new Set(Object.values(colours)).size).toBe(3);
  });

  it('keeps the same three in each of the ways a page can be themed', () => {
    expect(palette(block(":root\\[data-theme='light'\\]"))).toEqual(light);
    expect(palette(block(":root\\[data-theme='dark'\\]"))).toEqual(dark);
    expect(light).not.toEqual(dark);
  });

  it.each(['light', 'dark'] as const)('reads at least 4.5:1 on the %s theme’s page and card', (theme) => {
    const { colours, page } = themes[theme];
    for (const name of names) {
      for (const background of [page['--bg']!, page['--card']!]) expect(contrast(colours[name], background), `${theme} ${name} on ${background}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(['light', 'dark'] as const)('is a different hue from every other device, by 90 degrees at least, and from online, offline and waiting, by 30 (%s)', (theme) => {
    const { colours, page } = themes[theme];
    for (const [x, y] of [['a', 'b'], ['a', 'c'], ['b', 'c']] as const) expect(apart(colours[x], colours[y]), `${x} and ${y}`).toBeGreaterThanOrEqual(90);
    for (const name of names) for (const status of ['--on', '--off', '--wait']) expect(apart(colours[name], page[status]!), `${name} and ${status}`).toBeGreaterThanOrEqual(30);
  });

  it('reads at least 4.5:1 on the hub panel’s background too, in the standalone page', () => {
    const standalone = read('index.html');
    const panel = (text: string): string => text.match(/--bh-panel:\s*(#[0-9a-f]{6})/i)![1]!.toLowerCase();
    const lightPanel = panel(standalone.match(/:root\s*\{([^}]*)\}/)![1]!);
    const darkPanel = panel(standalone.match(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{([^}]*)\}/)![1]!);
    for (const name of names) {
      expect(contrast(light[name], lightPanel)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(dark[name], darkPanel)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('is loaded by every page that names a device, from beside it', () => {
    expect(read('device.html')).toContain('<link rel="stylesheet" href="devices.css">');
    expect(read('index.html')).toContain('<link rel="stylesheet" href="devices.css">');
  });

  it('gives each device’s page its own colour, by the name it is opened with, and falls back to the accent', () => {
    const device = read('device.html');
    for (const name of names) expect(device).toContain(`:root[data-device="${name}"] { --device: var(--device-${name}); }`);
    expect(device).toMatch(/header \{ border-top: 4px solid var\(--device, var\(--accent\)\); \}/);
    expect(device).toMatch(/#device \{ color: var\(--device, var\(--muted\)\)/);
  });

  it('colours the chip that says where a task was made by the device that made it, on the device pages and in the hub', () => {
    const device = read('device.html');
    for (const name of names) {
      expect(device).toContain(`.origin[data-origin="${name}"] { color: var(--device-${name}); border-color: var(--device-${name}); }`);
      expect(read('app.css')).toContain(`.bh-origin[data-origin='${name}'] { color: var(--device-${name}); }`);
    }
  });

  it('tints the row that flashes when a sync brings a change in with the colour of the device that made the change, and keeps the chip on the card', () => {
    const device = read('device.html');
    for (const name of names) expect(device).toContain(`li[data-editor="${name}"] { --flash: color-mix(in srgb, var(--device-${name}) 28%, var(--card)); }`);
    expect(device).toContain('li .origin { background: var(--card); }');
    // The shipped page's own highlight is what an unknown device falls back to, and it still fades.
    expect(device).toMatch(/li\.flash \{ background: var\(--flash\)/);
    // The row carries who made the latest change (the chip carries who made the task), and a change of editor is a change worth flashing.
    expect(read('device.js')).toMatch(/row\.item\.dataset\["editor"\]\s*=\s*task\.editedBy/);
    expect(read('device-worker.js')).toMatch(/task\.editedBy/);
  });

  it.each(['light', 'dark'] as const)('keeps a task’s text readable (6.5:1, past AA’s 4.5:1) on every device’s tint, in the %s theme', (theme) => {
    const percent = Number(read('device.html').match(/--device-a\) (\d+)%, var\(--card\)/)![1]) / 100;
    const { colours, page } = themes[theme];
    const channels = (hex: string): number[] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const mixed = (device: string): string => `#${channels(device).map((c, i) => Math.round(percent * c + (1 - percent) * channels(page['--card']!)[i]!).toString(16).padStart(2, '0')).join('')}`;
    for (const name of names) {
      expect(contrast(page['--ink']!, mixed(colours[name])), `${theme} ${name}`).toBeGreaterThanOrEqual(6.5);
      // …and it is a tint worth the name: further from the card than the shipped yellow was.
      expect(contrast(mixed(colours[name]), page['--card']!), `${theme} ${name} against the card`).toBeGreaterThanOrEqual(contrast(page['--flash']!, page['--card']!));
    }
  });

  it('is not the only thing that names a device: each page writes the device’s name beside its colour', () => {
    expect(read('device.js')).toMatch(/origin\.dataset\["origin"\]\s*=\s*task\.origin/);
    expect(read('device.js')).toMatch(/Device A/);
    expect(read('page.js')).toMatch(/origin\.textContent/);
  });
});
