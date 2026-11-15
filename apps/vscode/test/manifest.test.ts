import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TEXTMATE_OUT } from '../../../libs/language/src/typeqlite-textmate';
import { FENCE_LANGUAGES } from '../src/markdown/protocol';
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

  it('activates on that language', () => {
    expect(manifest.activationEvents).toEqual([`onLanguage:${language.id}`]);
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

  it('has a language configuration file where it says', () => {
    expect(existsSync(resolve(APP, contributed.configuration))).toBe(true);
  });

  it('is the extension ADR-008 D1 names: VS Code builds the id from publisher.name', () => {
    expect(`${manifest.publisher}.${manifest.name}`).toBe('typedblite.typeqlite');
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
 * where VS Code keeps colour themes, and answers one command for the main extension.
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

  it('ships its bundle, its icon and its licence, and nothing of the main extension', () => {
    expect(existsSync(resolve(APP, 'theme-bridge', bridge.main))).toBe(true);
    expect(readFileSync(resolve(APP, 'theme-bridge', bridge.icon)).equals(readFileSync(resolve(APP, manifest.icon)))).toBe(true);
    expect(bridge.vsce).toEqual({ dependencies: false });
    // The main package must not carry the bridge's folder.
    expect(readFileSync(resolve(APP, '.vscodeignore'), 'utf8').split('\n')).toContain('theme-bridge/**');
  });

  it("shares the main extension's version, licence, publisher and engine", () => {
    for (const field of ['version', 'license', 'publisher', 'engines'] as const) {
      expect(bridge[field], field).toEqual(manifest[field]);
    }
  });
});
