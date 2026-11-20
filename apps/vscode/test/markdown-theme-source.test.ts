import { themeFiles, THEME_BRIDGE_ID, type ThemeSources } from '../src/markdown/theme-source';

/**
 * Where the preview gets the theme's files from (ADR-010 D7): this extension host first, and the
 * Theme Bridge, in the host where VS Code keeps the themes, only when that fails.
 */
describe("finding the active theme's files", () => {
  const FILES = [{ tokenColors: [] }];
  const MISSING = { missing: "No extension in this extension host contributes the color theme 'Dark 2026'" };

  function sources(here: Awaited<ReturnType<ThemeSources['here']>>, bridge: ThemeSources['bridge']) {
    const asked: string[] = [];
    return {
      asked,
      sources: {
        here: async (name: string) => (asked.push(`here ${name}`), here),
        bridge: async (name: string) => (asked.push(`bridge ${name}`), bridge(name)),
      } satisfies ThemeSources,
    };
  }

  it('reads the theme here when it can, and never asks the bridge', async () => {
    const { asked, sources: s } = sources({ files: FILES }, async () => ({ files: [] }));
    expect(await themeFiles('Dark 2026', s, () => undefined)).toBe(FILES);
    expect(asked).toEqual(['here Dark 2026']);
  });

  it('asks the bridge, by name, when the theme is not in this host: a remote window', async () => {
    const { asked, sources: s } = sources(MISSING, async () => ({ files: FILES }));
    expect(await themeFiles('Dark 2026', s, () => undefined)).toBe(FILES);
    expect(asked).toEqual(['here Dark 2026', 'bridge Dark 2026']);
  });

  it('says to install the bridge when no extension registers its command', async () => {
    const log = vi.fn();
    const { sources: s } = sources(MISSING, () => Promise.reject(new Error("command 'typeqlite.themeFiles' not found")));
    expect(await themeFiles('Dark 2026', s, log)).toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining(`Install the TypeQLite Theme Bridge (${THEME_BRIDGE_ID})`));
  });

  it("passes on the bridge's reason when it cannot read the theme either", async () => {
    const log = vi.fn();
    const { sources: s } = sources(MISSING, async () => ({ missing: 'its tokenColors are in x.tmTheme, which is not JSON' }));
    expect(await themeFiles('Dark 2026', s, log)).toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('could not read it either: its tokenColors are in x.tmTheme'));
  });
});
