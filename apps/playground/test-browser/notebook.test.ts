/**
 * `nx run playground:test-browser` — the browser notebook's page, in a real Chromium, with the engine on WASM SQLite in a
 * worker. The unit tests prove the kernel, the client and the shared notebook code on `node:sqlite`; only this proves the
 * WASM binding, the workers, the bundle and the page work together, and that a reader gets the answers the guide prints.
 *
 * Needs Playwright's Chromium (`npx playwright-core install chromium`).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { serveDirectory } from '../src/dev/static-server.js';
import { playTour, type Kernel, type Piece } from '../../vscode/test/support/tour-player';

const BUILD = fileURLToPath(new URL('../.build', import.meta.url));
const ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const GUIDE = join(ROOT, 'docs/guides/try-it.tql.md');
let site: Awaited<ReturnType<typeof serveDirectory>>;
let browser: Browser;
const work = mkdtempSync(join(tmpdir(), 'typedblite-try-it-browser-'));

beforeAll(async () => {
  site = await serveDirectory(BUILD);
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser?.close();
  await site?.close();
  rmSync(work, { recursive: true, force: true });
});

type Shown = { kind: string; plain: string };
type Hook = {
  cellCount(): number;
  source(index: number): string;
  setSource(index: number, text: string): void;
  markers(index: number): { message: string; severity: number }[];
  shown(index: number): Shown[];
  state(index: number): string;
  status(): string;
};

/** Every page records the JSON-RPC methods and URIs it sends to the language worker, so a test can tell the server was asked. */
const recordLsp = () => {
  const sent: { method: string; uri?: string }[] = [];
  (window as unknown as { __lspSent: typeof sent }).__lspSent = sent;
  const original = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function (this: Worker, message: unknown, ...rest: unknown[]) {
    const m = message as { jsonrpc?: string; method?: string; params?: { textDocument?: { uri?: string } } } | null;
    if (m?.jsonrpc && m.method) sent.push({ method: m.method, uri: m.params?.textDocument?.uri });
    return (original as (...args: unknown[]) => void).call(this, message, ...rest);
  } as typeof original;
};

const errors = new WeakMap<Page, string[]>();
/** What the page wrote to its console, so a test can say it complained of nothing it should not. */
const warnings = new WeakMap<Page, string[]>();
const open = async (): Promise<Page> => {
  const page = await (await browser.newContext()).newPage();
  const seen: string[] = [];
  errors.set(page, seen);
  page.on('pageerror', (error) => seen.push(error.message));
  page.on('console', (message) => warnings.get(page)?.push(message.text()));
  warnings.set(page, []);
  await page.addInitScript(recordLsp);
  await page.goto(`${site.url}/try.html`);
  await page.waitForFunction(() => (window as unknown as { typedbliteNotebook?: Hook }).typedbliteNotebook !== undefined, undefined, { timeout: 30_000 });
  return page;
};
const hook = <T>(page: Page, call: (h: Hook, ...args: never[]) => T, ...args: unknown[]): Promise<T> =>
  page.evaluate(`(${call.toString()})(window.typedbliteNotebook, ...${JSON.stringify(args)})`) as Promise<T>;
/** Press a cell's play button, as a person does, and wait until it has finished running. */
const runCellOnPage = async (page: Page, index: number): Promise<Shown[]> => {
  await page.getByRole('button', { name: `Run cell ${index + 1}` }).click();
  await page.waitForFunction((i) => ['done', 'failed'].includes((window as unknown as { typedbliteNotebook: Hook }).typedbliteNotebook.state(i)), index, { timeout: 30_000 });
  return hook(page, (h, i: number) => h.shown(i), index) as Promise<Shown[]>;
};

describe('the browser notebook in Chromium', () => {
  it('shows the guide: Markdown around nine cells, each an editor with the guide\'s statement', async () => {
    const page = await open();
    expect(await hook(page, (h) => h.cellCount())).toBe(9);
    expect(await hook(page, (h) => h.source(0))).toMatch(/^define\n  entity book, owns title @key/);
    expect(await page.locator('.nb-markup h2').first().innerText()).toBe('1. Describe your data');
    expect(await page.locator('.nb-markup h1').count(), 'the page around the notebook has the title').toBe(0);
    // The guide's printed answers are not on the page: the real ones appear under each cell.
    expect(await page.locator('.nb-markup').allInnerTexts().then((all) => all.join('\n'))).not.toContain('entity:book:#1');
    await page.context().close();
  });

  // 🔴 Every cell asks the language server for its tokens at once. Langium's provider used to answer one cell with another's
  // tokens in front of its own, and Monaco warned that they ran past the end of the line.
  it('colors every cell from its own tokens: Monaco has nothing to say about them', async () => {
    const page = await open();
    await page.waitForFunction(() => (window as unknown as { __lspSent: { method: string }[] }).__lspSent.filter((m) => m.method === 'textDocument/semanticTokens/full').length >= 9, undefined, { timeout: 30_000 });
    await page.waitForTimeout(1_000);
    expect(warnings.get(page)!.filter((text) => /semantic tokens/i.test(text))).toEqual([]);
    await page.context().close();
  });

  // The whole guide, played through the page: every cell run on WASM in a worker, every answer read from what is drawn.
  it('plays the guide top to bottom as a reader does, and every answer it prints is the one on the page', async () => {
    const page = await open();
    const kernel: Kernel = {
      async run(source, index) {
        expect(await hook(page, (h, i: number) => h.source(i), index), `the page's cell ${index + 1} holds the guide's statement`).toBe(source);
        const shown = await runCellOnPage(page, index);
        return shown.map((block): Piece => ({ kind: block.kind === 'facts' ? 'facts' : 'other', text: block.plain }));
      },
      useStore: () => Promise.reject(new Error('the browser notebook has no store to choose')),
    };
    const report = await playTour(readFileSync(GUIDE, 'utf8'), kernel, work, ROOT);
    expect(report.failures.join('\n\n')).toBe('');
    expect(report.cells).toBe(9);
    expect(errors.get(page)).toEqual([]);
    await page.context().close();
  }, 180_000);

  it('Run all runs the cells in order and stops at the refusal on the last one, on purpose', async () => {
    const page = await open();
    await page.getByRole('button', { name: 'Run all' }).click();
    await page.waitForFunction(() => /^(Done|Stopped at cell)/.test((window as unknown as { typedbliteNotebook: Hook }).typedbliteNotebook.status() ?? ''), undefined, { timeout: 60_000 });
    expect(await hook(page, (h) => h.status())).toBe('Stopped at cell 9: it was refused.');
    const states = await page.evaluate(() => Array.from({ length: 9 }, (_, i) => (window as unknown as { typedbliteNotebook: Hook }).typedbliteNotebook.state(i)));
    expect(states).toEqual([...Array(8).fill('done'), 'failed']);
    expect(await page.locator('.nb-cell[data-state="failed"] .nb-error').innerText()).toContain('TypeQLite refused this statement');
    expect(await page.getByRole('button', { name: 'Run all' }).isEnabled()).toBe(true);
    await page.context().close();
  }, 120_000);

  it('Restart gives an empty store: a cell that needs the schema is then refused with the engine\'s own message', async () => {
    const page = await open();
    await runCellOnPage(page, 0);
    await runCellOnPage(page, 1);
    await page.getByRole('button', { name: 'Restart' }).click();
    await page.waitForFunction(() => /^Restarted/.test((window as unknown as { typedbliteNotebook: Hook }).typedbliteNotebook.status() ?? ''));
    // The page goes back to how it opened: no answer from the old store stays on it.
    expect(await page.locator('.nb-outputs > *').count()).toBe(0);
    expect(await page.locator('.nb-label').allInnerTexts()).toEqual(Array(9).fill('[ ]'));
    expect(await page.locator('.nb-cell[data-state="idle"]').count()).toBe(9);
    const shown = await runCellOnPage(page, 2);
    expect(await page.locator('.nb-cell[data-cell="2"] .nb-label').innerText(), 'the run count starts again').toBe('[1]');
    expect(shown.find((block) => block.kind === 'refusal')?.plain).toContain('no schema has been applied');
    await page.context().close();
  }, 60_000);

  // 🔴 A reader's statement is a stranger's text once a link shares it, and a value is data.
  it('shows what a statement inserts as text: an <img onerror> value never becomes an element', async () => {
    const page = await open();
    await runCellOnPage(page, 0);
    const attack = '<img src=x onerror="window.__pwned = 1">';
    await hook(page, (h, text: string) => h.setSource(1, text), `insert $b isa book, has title '${attack}', has author "x", has status "to-read";`);
    await runCellOnPage(page, 1);
    await hook(page, (h, text: string) => h.setSource(2, text), 'match $b isa book, has title $t; select $t;');
    await runCellOnPage(page, 2);
    expect(await page.locator('.nb-cell[data-cell="2"] td').first().innerText()).toBe(attack);
    expect(await page.locator('.nb-outputs img, .nb-outputs script').count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    await page.context().close();
  }, 60_000);

  // ADR-012 N4, in the browser: the cells of the page are one notebook, so a label defined in one resolves in another.
  it('the language server knows the cells as one notebook: a label defined above resolves below, and an unknown one is flagged', async () => {
    const page = await open();
    // The server answers diagnostics asynchronously; wait until it has said something about every cell it was told of.
    await page.waitForFunction(() => ((window as unknown as { __lspSent: { method: string }[] }).__lspSent ?? []).filter((m) => m.method === 'textDocument/didOpen').length >= 9, undefined, { timeout: 30_000 });
    const uris = await page.evaluate(() => (window as unknown as { __lspSent: { method: string; uri?: string }[] }).__lspSent.filter((m) => m.method === 'textDocument/didOpen').map((m) => m.uri));
    expect(uris.every((uri) => /^vscode-notebook-cell:\/try\/try-it\.tql\.md#cell\d$/.test(uri ?? ''))).toBe(true);

    await hook(page, (h, text: string) => h.setSource(1, text), 'insert $b isa nobook, has title "x";');
    await page.waitForFunction(() => (window as unknown as { typedbliteNotebook: Hook }).typedbliteNotebook.markers(1).some((m) => /nobook/.test(m.message)), undefined, { timeout: 30_000 });
    // `book` and `title`, defined in cell 1, resolve in the cells below it: nothing flagged there.
    expect(await hook(page, (h) => h.markers(2))).toEqual([]);
    await page.context().close();
  }, 60_000);

  it('offers a cell the labels defined in the cells above it', async () => {
    const page = await open();
    await page.waitForFunction(() => ((window as unknown as { __lspSent: { method: string }[] }).__lspSent ?? []).filter((m) => m.method === 'textDocument/didOpen').length >= 9, undefined, { timeout: 30_000 });
    await hook(page, (h, text: string) => h.setSource(2, text), 'match $x isa ');
    await page.locator('.nb-cell[data-cell="2"] .view-lines').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Control+Space');
    await page.waitForSelector('.suggest-widget.visible', { timeout: 30_000 });
    const offered = await page.locator('.suggest-widget .monaco-list-row').allInnerTexts();
    expect(offered.join(' ')).toMatch(/\bbook\b/);
    await page.context().close();
  }, 60_000);

  it('runs a cell with Ctrl+Enter from the editor, and Shift+Enter moves on to the next', async () => {
    const page = await open();
    await page.locator('.nb-cell[data-cell="0"] .view-lines').click();
    await page.keyboard.press('Control+Enter');
    await page.waitForFunction(() => (window as unknown as { typedbliteNotebook: Hook }).typedbliteNotebook.state(0) === 'done', undefined, { timeout: 30_000 });
    await page.locator('.nb-cell[data-cell="1"] .view-lines').click();
    await page.keyboard.press('Shift+Enter');
    await page.waitForFunction(() => (window as unknown as { typedbliteNotebook: Hook }).typedbliteNotebook.state(1) === 'done', undefined, { timeout: 30_000 });
    expect(await page.evaluate(() => document.activeElement?.closest('.nb-cell')?.getAttribute('data-cell'))).toBe('2');
    await page.context().close();
  }, 60_000);
});
