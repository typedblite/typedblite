import type { ThemeFile } from './theme.js';

/** The command the TypeQLite Theme Bridge registers, on the side of VS Code where themes live. */
export const THEME_FILES_COMMAND = 'typeqlite.themeFiles';

/** The bridge's extension id, for the message that tells a user to install it. */
export const THEME_BRIDGE_ID = 'typedblite.typeqlite-theme';

/** A theme's files, base `include` first, or why they could not be read. Plain data: it crosses hosts. */
export type ThemeFilesResult = { readonly files: readonly ThemeFile[] } | { readonly missing: string };

export interface ThemeSources {
  /** Read the theme in this extension host. */
  here(themeName: string): Promise<ThemeFilesResult>;
  /** Ask the bridge. Rejects when no extension registers the command. */
  bridge(themeName: string): PromiseLike<ThemeFilesResult | undefined>;
}

/**
 * The active theme's files, from wherever they can be read (ADR-010 D7).
 *
 * 🔴 **In a remote window, themes are not where this extension runs.** The Markdown preview's
 * plugins, and so this extension, run in the remote extension host (WSL, SSH, a container). Colour
 * themes, the built-in ones included, are UI extensions, in the local VS Code. An extension in the
 * remote host cannot see them: `vscode.extensions.all` lists only its own host's extensions. So this
 * looks here first and, failing that, asks the bridge, which runs where the themes are and reads the
 * same files with the same code.
 *
 * Undefined when neither can, with the reason logged: the preview then keeps its own colours.
 */
export async function themeFiles(
  themeName: string,
  sources: ThemeSources,
  log: (message: string) => void,
): Promise<readonly ThemeFile[] | undefined> {
  const here = await sources.here(themeName);
  if ('files' in here) return here.files;
  let there: ThemeFilesResult | undefined;
  try {
    there = await sources.bridge(themeName);
  } catch (error) {
    log(
      `${here.missing}. In a remote window (WSL, SSH, a container) themes live in the local VS Code, where ` +
        `this extension cannot read them. Install the TypeQLite Theme Bridge (${THEME_BRIDGE_ID}) there, and ` +
        `the preview will use your theme's colours. (${(error as Error).message})`,
    );
    return undefined;
  }
  if (there && 'files' in there) return there.files;
  log(`${here.missing}. The TypeQLite Theme Bridge could not read it either: ${there?.missing ?? 'it gave no answer'}.`);
  return undefined;
}
