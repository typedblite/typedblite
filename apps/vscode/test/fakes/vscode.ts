import { posix } from 'node:path';

/**
 * Just enough of the `vscode` module for the extension's modules that touch it, outside VS Code.
 * `vitest.config.ts` points `vscode` here. Each test sets the world it needs through {@link fake}
 * and starts from {@link reset}.
 *
 * Only what `src/` calls is here, shaped as VS Code's API is. A call to anything else fails, as a
 * missing export, rather than quietly doing nothing.
 */

export class Uri {
  private constructor(readonly scheme: string, readonly path: string) {}
  static file(path: string): Uri {
    return new Uri('file', path);
  }
  static joinPath(base: Uri, ...segments: string[]): Uri {
    return new Uri(base.scheme, posix.join(base.path, ...segments));
  }
  toString(): string {
    return `${this.scheme}://${this.path}`;
  }
}

export enum ColorThemeKind {
  Light = 1,
  Dark = 2,
  HighContrast = 3,
  HighContrastLight = 4,
}

interface FakeExtension {
  readonly id: string;
  readonly extensionUri: Uri;
  readonly packageJSON: unknown;
}

/** The world a test sets up: settings by section, files by path, extensions, the theme's kind. */
export const fake = {
  settings: new Map<string, Record<string, unknown>>(),
  files: new Map<string, string>(),
  extensions: [] as FakeExtension[],
  kind: ColorThemeKind.Dark,
  commands: new Map<string, (...args: unknown[]) => unknown>(),
  /** An extension contributing `themes`, with each theme file's text at `<root>/<path>`. */
  themeExtension(root: string, themes: { id?: string; label: string; path: string }[]): void {
    this.extensions.push({ id: `test.${root}`, extensionUri: Uri.file(root), packageJSON: { contributes: { themes } } });
  },
};

export function reset(): void {
  fake.settings.clear();
  fake.files.clear();
  fake.extensions.length = 0;
  fake.kind = ColorThemeKind.Dark;
  fake.commands.clear();
}

export const workspace = {
  getConfiguration(section: string) {
    const values = fake.settings.get(section) ?? {};
    return { get: <T>(key: string, fallback?: T): T | undefined => (key in values ? (values[key] as T) : fallback) };
  },
  fs: {
    async readFile(uri: Uri): Promise<Uint8Array> {
      const text = fake.files.get(uri.path);
      if (text === undefined) throw new Error(`ENOENT: ${uri.path}`);
      return new TextEncoder().encode(text);
    },
  },
};

export const extensions = {
  get all(): readonly FakeExtension[] {
    return fake.extensions;
  },
};

export const window = {
  get activeColorTheme() {
    return { kind: fake.kind };
  },
};

export enum NotebookCellKind {
  Markup = 1,
  Code = 2,
}

/** The notebook data classes a serializer builds, as VS Code's are: plain holders. */
export class NotebookCellData {
  metadata?: Record<string, unknown>;
  outputs?: unknown[];
  constructor(
    public kind: NotebookCellKind,
    public value: string,
    public languageId: string,
  ) {}
}

/** An output item, as VS Code's: bytes and a MIME type, with the constructors a controller uses. */
export class NotebookCellOutputItem {
  constructor(
    public data: Uint8Array,
    public mime: string,
  ) {}
  static text(value: string, mime = 'text/plain'): NotebookCellOutputItem {
    return new NotebookCellOutputItem(new TextEncoder().encode(value), mime);
  }
  static json(value: unknown, mime = 'application/json'): NotebookCellOutputItem {
    return new NotebookCellOutputItem(new TextEncoder().encode(JSON.stringify(value)), mime);
  }
  static stdout(value: string): NotebookCellOutputItem {
    return NotebookCellOutputItem.text(value, 'application/vnd.code.notebook.stdout');
  }
  static error(value: Error): NotebookCellOutputItem {
    return NotebookCellOutputItem.json({ name: value.name, message: value.message, stack: value.stack }, 'application/vnd.code.notebook.error');
  }
}

export class NotebookCellOutput {
  constructor(public items: NotebookCellOutputItem[]) {}
}

export class NotebookData {
  metadata?: Record<string, unknown>;
  constructor(public cells: NotebookCellData[]) {}
}

export const commands = {
  async executeCommand<T>(command: string, ...args: unknown[]): Promise<T> {
    const handler = fake.commands.get(command);
    // VS Code's own message for a command nothing registers.
    if (!handler) throw new Error(`command '${command}' not found`);
    return (await handler(...args)) as T;
  },
};
