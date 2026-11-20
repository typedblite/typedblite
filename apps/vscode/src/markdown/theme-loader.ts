import * as vscode from 'vscode';
// 🔴 The ES module build, not the package's `main`: that is UMD, which `require`s its own files at
// run time, so esbuild leaves the requires in and the installed extension cannot find them.
import { parse, type ParseError } from 'jsonc-parser/lib/esm/main.js';
import { resolveTheme, type Theme, type ThemeFile } from './theme.js';
import { THEME_FILES_COMMAND, themeFiles, type ThemeFilesResult } from './theme-source.js';

/**
 * The active color theme's token coloring, read from the files of the extension that contributes
 * it, with the user's customizations applied (ADR-010).
 *
 * 🔴 There is no API for a theme's token colors, so this finds the theme the way the workbench
 * does: by the id or label in `workbench.colorTheme` (or the preferred theme for the OS's scheme when
 * `window.autoDetectColorScheme` is on), among the `contributes.themes` of every extension, the
 * built-in ones included. In a remote window the theme is not in this extension host, and the files
 * come from the TypeQLite Theme Bridge instead (`theme-source.ts`, ADR-010 D7).
 *
 * The customizations are read HERE, never by the bridge: settings for the remote machine apply only
 * in the remote host. Undefined when the theme cannot be read. The preview then falls back to its
 * own highlighting colors, and says why in the log.
 */
export async function loadTheme(log: vscode.OutputChannel): Promise<Theme | undefined> {
  const themeName = activeThemeName();
  const files = await themeFiles(
    themeName,
    {
      here: readThemeFiles,
      bridge: (name) => vscode.commands.executeCommand<ThemeFilesResult | undefined>(THEME_FILES_COMMAND, name),
    },
    (message) => log.appendLine(`Markdown preview: ${message}`),
  );
  if (!files) return undefined;
  const editor = vscode.workspace.getConfiguration('editor', { languageId: 'typeqlite' });
  return resolveTheme(files, {
    themeName,
    semanticHighlighting: editor.get<boolean | 'configuredByTheme'>('semanticHighlighting.enabled', 'configuredByTheme'),
    semanticTokenColorCustomizations: editor.get('semanticTokenColorCustomizations'),
    tokenColorCustomizations: editor.get('tokenColorCustomizations'),
  });
}

/**
 * The files of the theme named, as this extension host sees them: the main extension's first try,
 * and all the bridge does.
 */
export async function readThemeFiles(themeName: string): Promise<ThemeFilesResult> {
  const location = findTheme(themeName);
  if (!location) return { missing: `No extension in this extension host contributes the color theme '${themeName}'` };
  try {
    return { files: await readThemeChain(location, new Set()) };
  } catch (error) {
    return { missing: `Could not read the color theme '${themeName}': ${(error as Error).message}` };
  }
}

/** The settings whose change changes what `loadTheme` returns. */
export const THEME_SETTINGS = [
  'workbench.colorTheme',
  'workbench.preferredDarkColorTheme',
  'workbench.preferredLightColorTheme',
  'workbench.preferredHighContrastColorTheme',
  'workbench.preferredHighContrastLightColorTheme',
  'window.autoDetectColorScheme',
  'editor.semanticHighlighting',
  'editor.semanticTokenColorCustomizations',
  'editor.tokenColorCustomizations',
];

function activeThemeName(): string {
  const workbench = vscode.workspace.getConfiguration('workbench');
  if (vscode.workspace.getConfiguration('window').get<boolean>('autoDetectColorScheme')) {
    const preferred = {
      [vscode.ColorThemeKind.Dark]: 'preferredDarkColorTheme',
      [vscode.ColorThemeKind.Light]: 'preferredLightColorTheme',
      [vscode.ColorThemeKind.HighContrast]: 'preferredHighContrastColorTheme',
      [vscode.ColorThemeKind.HighContrastLight]: 'preferredHighContrastLightColorTheme',
    }[vscode.window.activeColorTheme.kind];
    const name = workbench.get<string>(preferred);
    if (name) return name;
  }
  return workbench.get<string>('colorTheme') ?? '';
}

function findTheme(name: string): vscode.Uri | undefined {
  for (const extension of vscode.extensions.all) {
    const themes: unknown = extension.packageJSON?.contributes?.themes;
    if (!Array.isArray(themes)) continue;
    for (const theme of themes as { id?: string; label?: string; path?: string }[]) {
      if (typeof theme.path === 'string' && (theme.id === name || theme.label === name)) {
        return vscode.Uri.joinPath(extension.extensionUri, theme.path);
      }
    }
  }
  return undefined;
}

/** The theme file and every file it includes, base first. */
async function readThemeChain(location: vscode.Uri, seen: Set<string>): Promise<ThemeFile[]> {
  if (seen.has(location.toString()) || seen.size > 16) {
    throw new Error(`the theme's includes loop at ${location.path}`);
  }
  seen.add(location.toString());
  const json = await readJson(location);
  const base = typeof json['include'] === 'string'
    ? await readThemeChain(vscode.Uri.joinPath(location, '..', json['include']), seen)
    : [];
  let tokenColors = json['tokenColors'];
  if (typeof tokenColors === 'string') {
    // A path to the rules. A `.tmTheme` (plist) file is the older form, and is not read: the
    // preview keeps its own colors for that theme rather than guess.
    if (!tokenColors.endsWith('.json')) throw new Error(`its tokenColors are in ${tokenColors}, which is not JSON`);
    const rules = await readJson(vscode.Uri.joinPath(location, '..', tokenColors));
    tokenColors = Array.isArray(rules) ? rules : (rules['tokenColors'] ?? rules['settings']);
  }
  return [
    ...base,
    {
      semanticHighlighting: typeof json['semanticHighlighting'] === 'boolean' ? json['semanticHighlighting'] : undefined,
      semanticTokenColors: isObject(json['semanticTokenColors']) ? json['semanticTokenColors'] : undefined,
      tokenColors: Array.isArray(tokenColors) ? tokenColors : undefined,
    },
  ];
}

async function readJson(location: vscode.Uri): Promise<Record<string, unknown>> {
  const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(location));
  const errors: ParseError[] = [];
  const json: unknown = parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0 || (typeof json !== 'object' || json === null)) {
    throw new Error(`${location.path} is not valid JSON with comments`);
  }
  return json as Record<string, unknown>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
