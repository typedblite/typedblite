import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TEXTMATE_OUT } from '../../../libs/language/src/typeqlite-textmate';
import { HOST_NODE_SETTING, HOST_REQUEST_COMMAND } from '../src/host/constants';
import { NOTEBOOK_TYPE, NOTEBOOK_TYPE_MARKDOWN } from '../src/notebook/constants';
import { RESTART_COMMAND } from '../src/notebook/controller';
import { COMMIT_COMMAND, EXPORT_MARKDOWN_COMMAND, EXPORT_SCRIPT_COMMAND, HOLDS_CHANGES_CONTEXT, OPEN_STORE_COMMAND, ROLLBACK_COMMAND } from '../src/notebook/store-commands';
import { FENCE_LANGUAGES } from '../src/markdown/protocol';
import { DEBUG_TYPE } from '../src/debug/constants';
import { THEME_BRIDGE_ID, THEME_FILES_COMMAND } from '../src/markdown/theme-source';

const APP = resolve(__dirname, '..');
const read = (path: string) => JSON.parse(readFileSync(resolve(APP, path), 'utf8'));

const manifest = read('package.json');
const config = read('../../libs/language/langium-config.json');

/**
 * 🔴 `langium-config.json` is the only source of the language's id and file extensions (ADR-008
 * D4). The manifest has to restate them, because VS Code reads them before any code runs. So this
 * spec is what keeps the two from drifting: a fixed list in a second place drifts the first time
 * the first one changes.
 */
describe('the manifest agrees with langium-config.json', () => {
  const [language] = config.languages;
  const [contributed] = manifest.contributes.languages;

  it('contributes exactly one language, with the id langium-config.json declares', () => {
    expect(manifest.contributes.languages).toHaveLength(1);
    expect(contributed.id).toBe(language.id);
  });

  it('claims exactly the file extensions langium-config.json declares', () => {
    expect([...contributed.extensions].sort()).toEqual([...language.fileExtensions].sort());
  });

  // VS Code generates `onLanguage:` for a contributed language (since 1.74), so the manifest does not list it.
  it('activates on opening either notebook type, and when a TypeQLite debug session starts', () => {
    expect(manifest.activationEvents).toEqual([
      `onNotebook:${NOTEBOOK_TYPE}`,
      `onNotebook:${NOTEBOOK_TYPE_MARKDOWN}`,
      `onDebugResolve:${DEBUG_TYPE}`,
      `onDebugDynamicConfigurations:${DEBUG_TYPE}`,
    ]);
  });

  it('points its grammar at the generated TextMate file, under the scope that file declares', () => {
    const [grammar] = manifest.contributes.grammars;
    expect(grammar.language).toBe(language.id);
    expect(grammar.path).toBe(`./${TEXTMATE_OUT}`);
    // `build` runs `sync-grammar`, which copies the file in, so it exists by the time this runs.
    const tmLanguage = read(grammar.path);
    expect(grammar.scopeName).toBe(tmLanguage.scopeName);
  });

  it('injects that grammar into Markdown fences of exactly the languages the preview highlights', () => {
    const injection = manifest.contributes.grammars.find((g: { injectTo?: string[] }) => g.injectTo);
    expect(injection.injectTo).toEqual(['text.html.markdown']);
    expect(Object.values(injection.embeddedLanguages)).toEqual([language.id]);
    const file = read(injection.path);
    expect(file.scopeName).toBe(injection.scopeName);
    const fence = file.repository['fenced-typeqlite'];
    const [content] = fence.patterns;
    expect(Object.keys(injection.embeddedLanguages)).toEqual([content.contentName]);
    expect(content.patterns).toEqual([{ include: manifest.contributes.grammars[0].scopeName }]);
    const languages = /\(\?i:\(([^)]*)\)/.exec(fence.begin)![1]!.split('|');
    expect(new Set(languages)).toEqual(FENCE_LANGUAGES);
  });

  it('contributes the TypeQLite debugger (ADR-014): its type, for the language, breakpoints in its files, and a launch that needs a program', () => {
    const [debuggerContribution] = manifest.contributes.debuggers;
    expect(manifest.contributes.debuggers).toHaveLength(1);
    expect(debuggerContribution).toMatchObject({ type: DEBUG_TYPE, label: 'TypeQLite', languages: [language.id] });
    expect(manifest.contributes.breakpoints).toEqual([{ language: language.id }]);
    const launch = debuggerContribution.configurationAttributes.launch;
    expect(launch.required).toEqual(['program']);
    // The launch arguments are the adapter's own (`LaunchArguments` in @typedblite/debugger), less noDebug, which VS Code sets.
    expect(Object.keys(launch.properties).sort()).toEqual(['cwd', 'program', 'schema', 'seed', 'stopOnEntry']);
    for (const snippet of debuggerContribution.configurationSnippets) expect(snippet.body).toMatchObject({ type: DEBUG_TYPE, request: 'launch' });
  });

  it('has a language configuration file where it says', () => {
    expect(existsSync(resolve(APP, contributed.configuration))).toBe(true);
  });

  it('is the extension ADR-008 D1 names: VS Code builds the id from publisher.name', () => {
    expect(`${manifest.publisher}.${manifest.name}`).toBe('typedblite.typedblite-workbench');
  });

  it('contributes a markdown-it plugin, so the Markdown preview activates it and asks for one (ADR-010)', () => {
    expect(manifest.contributes['markdown.markdownItPlugins']).toBe(true);
  });

  it("shows the TypeDBLite logo: the brand's own icon, a PNG of at least 128 px", () => {
    // `sync-icon` copies it in, so `docs/brand/` stays the only copy in git. VS Code shows it in the
    // Extensions view and on the extension's page, and refuses an SVG for it.
    const icon = readFileSync(resolve(APP, manifest.icon));
    expect(icon.equals(readFileSync(resolve(APP, '../../docs/brand/typedblite-icon-512.png')))).toBe(true);
    expect(icon.subarray(1, 4).toString()).toBe('PNG');
    expect(Math.min(icon.readUInt32BE(16), icon.readUInt32BE(20))).toBeGreaterThanOrEqual(128);
  });

  it("gives .typeqlite and .tql files the logo's mark as their file icon, in a light and a dark form", () => {
    // `contributes.languages[].icon` is the only way an extension names a file icon. VS Code uses it when the
    // file icon theme has no icon of its own for the language, so a theme that does have one wins. `sync-icon`
    // copies the SVGs from `docs/brand/`.
    const language = manifest.contributes.languages.find((l: { id: string }) => l.id === 'typeqlite');
    expect(language.extensions).toEqual(expect.arrayContaining(['.typeqlite', '.tql']));
    for (const [variant, source] of [['light', 'typedblite-file-icon.svg'], ['dark', 'typedblite-file-icon-dark.svg']] as const) {
      const icon = readFileSync(resolve(APP, language.icon[variant]), 'utf8');
      expect(icon, variant).toBe(readFileSync(resolve(APP, '../../docs/brand', source), 'utf8'));
      expect(icon.startsWith('<svg'), variant).toBe(true);
    }
  });

  it('bundles its dependencies rather than shipping node_modules', () => {
    expect(manifest.vsce).toEqual({ dependencies: false });
    expect(manifest.main).toBe('./out/extension.cjs');
  });

  // ADR-012 N2: `*.tql.md` is the notebook's own file and opens as one; any other `*.md` is a notebook only by choice, so
  // no Markdown file is taken over.
  it('contributes the notebook: `*.tql.md` by default, any `*.md` only as an option', () => {
    const [own, any] = manifest.contributes.notebooks;
    expect(own).toMatchObject({ type: NOTEBOOK_TYPE, priority: 'default', selector: [{ filenamePattern: '*.tql.md' }] });
    expect(any).toMatchObject({ type: NOTEBOOK_TYPE_MARKDOWN, priority: 'option', selector: [{ filenamePattern: '*.md' }] });
    expect(manifest.contributes.notebooks).toHaveLength(2);
  });

  // 🔴 Feature invariant 3: Commit and Rollback exist only for a notebook that holds its changes, so they are never offered
  // against a store that commits each statement.
  it('offers Commit and Rollback only while a notebook holds its changes, and the store and exports for notebooks', () => {
    const palette: { command: string; when: string }[] = manifest.contributes.menus.commandPalette;
    const whenOf = (command: string) => palette.find((entry) => entry.command === command)?.when;
    for (const command of [COMMIT_COMMAND, ROLLBACK_COMMAND]) expect(whenOf(command), command).toContain(HOLDS_CHANGES_CONTEXT);
    for (const command of [OPEN_STORE_COMMAND, EXPORT_SCRIPT_COMMAND, EXPORT_MARKDOWN_COMMAND, RESTART_COMMAND]) {
      expect(whenOf(command), command).toMatch(/typeqlite-notebook/);
    }
    const toolbar: { command: string; when: string }[] = manifest.contributes.menus['notebook/toolbar'];
    for (const command of [COMMIT_COMMAND, ROLLBACK_COMMAND]) expect(toolbar.find((e) => e.command === command)?.when, command).toBe(HOLDS_CHANGES_CONTEXT);
  });

  it('registers one serializer for each notebook type, with outputs transient', () => {
    const source = readFileSync(resolve(APP, 'src/extension.ts'), 'utf8');
    expect(source).toContain('for (const type of [NOTEBOOK_TYPE, NOTEBOOK_TYPE_MARKDOWN])');
    expect(source).toContain('registerNotebookSerializer(type, serializer, { transientOutputs: true })');
  });

  it('contributes the engine host command, hidden from the palette, and the setting that names its node', () => {
    expect(manifest.contributes.commands.map((c: { command: string }) => c.command)).toEqual([
      HOST_REQUEST_COMMAND,
      RESTART_COMMAND,
      OPEN_STORE_COMMAND,
      COMMIT_COMMAND,
      ROLLBACK_COMMAND,
      EXPORT_SCRIPT_COMMAND,
      EXPORT_MARKDOWN_COMMAND,
    ]);
    expect(manifest.contributes.menus.commandPalette[0]).toEqual({ command: HOST_REQUEST_COMMAND, when: 'false' });
    const setting = manifest.contributes.configuration.properties[HOST_NODE_SETTING];
    expect(setting).toMatchObject({ type: 'string', default: '' });
    // A path to an executable is the machine's, not a workspace's: a repository must not choose what runs.
    expect(setting.scope).toBe('machine');
  });

  it('ships the engine host bundle the client starts, where the client looks for it', () => {
    expect(existsSync(resolve(APP, 'out/host/sidecar.cjs'))).toBe(true);
    expect(readFileSync(resolve(APP, 'src/extension.ts'), 'utf8')).toContain("asAbsolutePath('out/host/sidecar.cjs')");
    // `.vscodeignore` must not drop it from the package.
    const ignored = readFileSync(resolve(APP, '.vscodeignore'), 'utf8').split('\n');
    expect(ignored.filter((line) => /^\/?out\b/.test(line))).toEqual([]);
  });

  // 🔴 Feature invariant 6: the extension runs the host as a process and never imports it, so what runs a statement is
  // the host's, and the extension defines nothing of TypeQLite.
  it('never imports the engine host, the runtime or the session package', () => {
    const files = readdirSync(resolve(APP, 'src'), { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const source = readFileSync(resolve(file.parentPath, file.name), 'utf8');
      expect(source, file.name).not.toMatch(/from\s+['"](@typedblite\/(engine-host|runtime|session)|[./]+\/.*engine-host)/);
    }
  });

  it('leaves no relative require in any bundle, since nothing ships beside them', () => {
    // A UMD dependency's `require('./impl/format')` survives bundling and fails only once installed.
    // 🔴 esbuild renames a UMD factory's `require` parameter (`require2`, or `n` minified), so this
    // looks for ANY call whose one argument is a relative path, not for `require` by name.
    for (const bundle of ['out/extension.cjs', 'out/language-server/main.cjs', 'theme-bridge/out/extension.cjs']) {
      const source = readFileSync(resolve(APP, bundle), 'utf8');
      expect(source.match(/[\w$]+\(\s*["']\.\.?\/[^"'\s]*["']\s*\)/g) ?? [], bundle).toEqual([]);
    }
  });
});

/**
 * The TypeQLite Theme Bridge is a second extension, packaged from this project (ADR-010 D7). It runs
 * where VS Code keeps color themes, and answers one command for the main extension.
 */
describe('the Theme Bridge manifest', () => {
  const bridge = read('theme-bridge/package.json');

  it('is the extension the main one tells users to install', () => {
    expect(`${bridge.publisher}.${bridge.name}`).toBe(THEME_BRIDGE_ID);
  });

  it('runs only in the UI extension host, where the themes are, even in a remote window', () => {
    expect(bridge.extensionKind).toEqual(['ui']);
  });

  it('activates on the command the main extension sends, and contributes nothing else', () => {
    expect(bridge.activationEvents).toEqual([`onCommand:${THEME_FILES_COMMAND}`]);
    expect(bridge.contributes).toBeUndefined();
  });

  it('ships its bundle, its icon and its license, and nothing of the main extension', () => {
    expect(existsSync(resolve(APP, 'theme-bridge', bridge.main))).toBe(true);
    expect(readFileSync(resolve(APP, 'theme-bridge', bridge.icon)).equals(readFileSync(resolve(APP, manifest.icon)))).toBe(true);
    expect(bridge.vsce).toEqual({ dependencies: false });
    // The main package must not carry the bridge's folder.
    expect(readFileSync(resolve(APP, '.vscodeignore'), 'utf8').split('\n')).toContain('theme-bridge/**');
  });

  it("shares the main extension's version, license, publisher and engine", () => {
    for (const field of ['version', 'license', 'publisher', 'engines'] as const) {
      expect(bridge[field], field).toEqual(manifest[field]);
    }
  });
});
