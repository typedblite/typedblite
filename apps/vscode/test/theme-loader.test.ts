import { loadTheme, readThemeFiles } from '../src/markdown/theme-loader';
import { semanticStyle, textMateStyle } from '../src/markdown/theme';
import { THEME_FILES_COMMAND } from '../src/markdown/theme-source';
import { ColorThemeKind, fake, reset } from './fakes/vscode';

/**
 * Finding the active theme's files the way the workbench does, and falling back to the Theme Bridge
 * when they are not in this extension host (ADR-010 D3, D7). The e2e suite proves this against a real
 * VS Code's built-in themes; these cases cover the paths a real VS Code does not reach on demand: a
 * theme by label, the preferred theme for the OS's scheme, `tokenColors` in a file of its own, a
 * `.tmTheme`, an include loop, broken JSON, and every bridge outcome.
 */
const log = () => {
  const lines: string[] = [];
  return { lines, appendLine: (line: string) => lines.push(line) } as unknown as import('vscode').OutputChannel & { lines: string[] };
};
const KEYWORD = ['source.typeqlite', 'keyword.control.typeqlite'];

beforeEach(reset);

/** A theme `Test Dark` that includes a base, as Dark Modern includes Dark+. */
function installTheme(theme: Record<string, unknown> = {}) {
  fake.themeExtension('/ext', [{ id: 'Test Dark', label: 'Test Dark Label', path: './themes/dark.json' }]);
  fake.files.set(
    '/ext/themes/base.json',
    JSON.stringify({ semanticHighlighting: true, tokenColors: [{ scope: 'keyword', settings: { foreground: '#111111' } }] }),
  );
  fake.files.set(
    '/ext/themes/dark.json',
    // Comments and a trailing comma: theme files are JSON with comments.
    `// Test Dark\n${JSON.stringify({ include: './base.json', ...theme }).replace(/}$/, ',}')}`,
  );
}

describe('loading the active theme', () => {
  it('finds it by the id in workbench.colorTheme, follows its include, and resolves its colors', async () => {
    installTheme({ tokenColors: [{ scope: 'keyword.control', settings: { foreground: '#222222' } }] });
    fake.settings.set('workbench', { colorTheme: 'Test Dark' });
    const theme = await loadTheme(log());
    expect(textMateStyle(theme!, KEYWORD)).toEqual({ foreground: '#222222' });
    expect(textMateStyle(theme!, ['source.typeqlite', 'keyword.other'])).toEqual({ foreground: '#111111' });
  });

  it('finds it by its label too, as the workbench does', async () => {
    installTheme();
    fake.settings.set('workbench', { colorTheme: 'Test Dark Label' });
    expect(await loadTheme(log())).toBeDefined();
  });

  it("uses the preferred theme for the window's scheme when autoDetectColorScheme is on", async () => {
    installTheme();
    fake.kind = ColorThemeKind.Dark;
    fake.settings.set('window', { autoDetectColorScheme: true });
    fake.settings.set('workbench', { colorTheme: 'Something Else', preferredDarkColorTheme: 'Test Dark' });
    expect(await loadTheme(log())).toBeDefined();
  });

  it('reads tokenColors from a file of their own', async () => {
    installTheme({ tokenColors: './rules.json' });
    fake.files.set('/ext/themes/rules.json', JSON.stringify({ tokenColors: [{ scope: 'keyword.control', settings: { foreground: '#333333' } }] }));
    fake.settings.set('workbench', { colorTheme: 'Test Dark' });
    expect(textMateStyle((await loadTheme(log()))!, KEYWORD)).toEqual({ foreground: '#333333' });
  });

  it("applies the user's customizations and editor.semanticHighlighting.enabled, read in this host", async () => {
    installTheme();
    fake.settings.set('workbench', { colorTheme: 'Test Dark' });
    fake.settings.set('editor', {
      'semanticHighlighting.enabled': false,
      tokenColorCustomizations: { keywords: '#444444' },
    });
    const theme = (await loadTheme(log()))!;
    expect(textMateStyle(theme, KEYWORD)).toEqual({ foreground: '#444444' });
    expect(semanticStyle(theme, 'keyword', [])).toBeUndefined();
  });
});

describe('when the theme is not readable in this extension host', () => {
  it('asks the Theme Bridge by name, and uses the files it returns: a remote window', async () => {
    const asked: unknown[] = [];
    fake.commands.set(THEME_FILES_COMMAND, (name) => {
      asked.push(name);
      return { files: [{ tokenColors: [{ scope: 'keyword', settings: { foreground: '#555555' } }] }] };
    });
    fake.settings.set('workbench', { colorTheme: 'Remote Only' });
    const theme = await loadTheme(log());
    expect(asked).toEqual(['Remote Only']);
    expect(textMateStyle(theme!, KEYWORD)).toEqual({ foreground: '#555555' });
  });

  it('logs that the bridge should be installed when nothing answers its command', async () => {
    fake.settings.set('workbench', { colorTheme: 'Remote Only' });
    const output = log();
    expect(await loadTheme(output)).toBeUndefined();
    expect(output.lines.join('\n')).toMatch(/Install the TypeQLite Theme Bridge/);
  });

  it('refuses a .tmTheme rule file rather than guess at it, and says so', async () => {
    installTheme({ tokenColors: './rules.tmTheme' });
    fake.settings.set('workbench', { colorTheme: 'Test Dark' });
    expect(await readThemeFiles('Test Dark')).toEqual({ missing: expect.stringMatching(/rules\.tmTheme, which is not JSON/) });
  });

  it('refuses broken JSON and an include loop, naming each', async () => {
    fake.themeExtension('/bad', [
      { label: 'Broken', path: './broken.json' },
      { label: 'Loop', path: './a.json' },
    ]);
    fake.files.set('/bad/broken.json', '{ "tokenColors": [ ');
    fake.files.set('/bad/a.json', JSON.stringify({ include: './b.json' }));
    fake.files.set('/bad/b.json', JSON.stringify({ include: './a.json' }));
    expect(await readThemeFiles('Broken')).toEqual({ missing: expect.stringMatching(/broken\.json is not valid JSON with comments/) });
    expect(await readThemeFiles('Loop')).toEqual({ missing: expect.stringMatching(/includes loop/) });
  });

  it('names the theme when no extension contributes it', async () => {
    expect(await readThemeFiles('Nowhere')).toEqual({
      missing: "No extension in this extension host contributes the color theme 'Nowhere'",
    });
  });
});
