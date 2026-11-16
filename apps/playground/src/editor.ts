// Monaco's `exports` map rewrites `monaco-editor/<x>.js` to `esm/vs/<x>.js`, so this is its core API,
// without the 80 language packs and the CSS, HTML, JSON and TypeScript services that `monaco-editor`
// itself pulls in.
import * as monaco from 'monaco-editor/editor/editor.api.js';
// 🔴 Monaco's own LSP client lives outside `esm/vs`, where no public subpath reaches it. `build.mjs`
// aliases this name to the installed file, and `tsconfig.client.json` maps it for the type checker.
import { MonacoLspClient, createTransportToWorker } from 'monaco-lsp-client';

import { LANGUAGE_ID, MONARCH, SURFACE, themeRules } from './highlighting.js';
import { currentScheme, onSchemeChange, resolveColour, type Scheme } from './scheme.js';

/**
 * The program editor: Monaco, with TypeQLite served by the real language server over LSP.
 *
 * Everything an editor knows about TypeQLite comes from that server, in a worker, through Monaco's own
 * LSP client: diagnostics, completion, hover, go to definition and references, rename, quick fixes,
 * outline, folding, formatting and semantic tokens. It is the server the VS Code extension runs
 * (`language-server.ts`), so the playground's editor and the extension cannot disagree about the
 * language. The only thing written here is the colouring a tokenizer can do from text alone
 * (`highlighting.ts`), because semantic tokens do not cover keywords.
 *
 * Browser only. `test-browser/playground.test.ts` is where it is tested, in Chromium.
 */
export interface ProgramEditor {
  getValue(): string;
  setValue(text: string): void;
  /** Called when the text changes, by the user or by `setValue`. */
  onDidChange(listener: () => void): void;
  /** Select a whole line (1-based) and put the cursor there. */
  goToLine(line: number): void;
  /** The text that is selected now. */
  getSelectedText(): string;
  focus(): void;
}

const PROGRAM_URI = 'file:///playground.tql';
let environmentReady = false;

/** Monaco asks for its editor worker (word-based features, diffing) through this global. */
function prepareEnvironment(): void {
  if (environmentReady) return;
  environmentReady = true;
  (self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
    getWorker: () => new Worker(new URL('editor.worker.js', import.meta.url), { type: 'module' }),
  };
  monaco.languages.register({ id: LANGUAGE_ID, extensions: ['.typeqlite', '.tql'], aliases: ['TypeQLite'] });
  monaco.languages.setMonarchTokensProvider(LANGUAGE_ID, MONARCH as unknown as monaco.languages.IMonarchLanguage);
  monaco.languages.setLanguageConfiguration(LANGUAGE_ID, {
    comments: { lineComment: '#' },
    brackets: [['{', '}'], ['(', ')'], ['[', ']']],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '(', close: ')' },
      { open: '[', close: ']' },
      { open: '"', close: '"', notIn: ['string'] },
      { open: "'", close: "'", notIn: ['string'] },
    ],
    surroundingPairs: [{ open: '{', close: '}' }, { open: '(', close: ')' }, { open: '[', close: ']' }, { open: '"', close: '"' }, { open: "'", close: "'" }],
    // A name holds hyphens (`project-id`), and a variable starts with `$`, so a "word" is both.
    wordPattern: /\$?[A-Za-z_\u0080-￿][\w\-\u0080-￿]*/,
  });
}

/**
 * (Re)defines the editor's theme for a scheme. Its surface is the host page's own: `--pg-code` for the
 * background and `--pg-ink` for the text, read from the page, so the editor sits in whatever page hosts it.
 * `SURFACE` is only the fallback for a browser that gives no value.
 */
function applyTheme(container: HTMLElement, scheme: Scheme): void {
  monaco.editor.defineTheme(`typeqlite-${scheme}`, {
    base: scheme === 'dark' ? 'vs-dark' : 'vs',
    inherit: true,
    rules: themeRules(scheme).map((rule) => ({ ...rule, foreground: rule.foreground })),
    colors: {
      'editor.background': resolveColour(container, '--pg-code') ?? SURFACE[scheme]['editor.background'],
      'editor.foreground': resolveColour(container, '--pg-ink') ?? SURFACE[scheme]['editor.foreground'],
    },
  });
  monaco.editor.setTheme(`typeqlite-${scheme}`);
}

export function createProgramEditor(container: HTMLElement, options: { onRun: () => void }): ProgramEditor {
  prepareEnvironment();
  const model = monaco.editor.createModel('', LANGUAGE_ID, monaco.Uri.parse(PROGRAM_URI));
  const editor = monaco.editor.create(container, {
    model,
    ariaLabel: 'Program',
    automaticLayout: true,
    minimap: { enabled: false },
    fontSize: 14,
    tabSize: 2,
    wordWrap: 'on',
    scrollBeyondLastLine: false,
    renderLineHighlight: 'line',
    'semanticHighlighting.enabled': true,
    padding: { top: 8, bottom: 8 },
  });
  applyTheme(container, currentScheme());
  onSchemeChange((scheme) => applyTheme(container, scheme));
  editor.addAction({
    id: 'typedblite.run',
    label: 'Run program',
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
    run: () => options.onRun(),
  });

  // The language server, in its own worker. The client attaches its providers to Monaco, and syncs the
  // model to the server, so there is nothing more to wire.
  new MonacoLspClient(createTransportToWorker(new Worker(new URL('language-worker.js', import.meta.url), { type: 'module' })));

  return {
    getValue: () => model.getValue(),
    setValue: (text) => model.setValue(text),
    onDidChange: (listener) => void model.onDidChangeContent(listener),
    goToLine: (line) => {
      const safe = Math.min(Math.max(1, line), model.getLineCount());
      editor.revealLineInCenter(safe);
      editor.setSelection(new monaco.Selection(safe, 1, safe, model.getLineMaxColumn(safe)));
      editor.focus();
    },
    getSelectedText: () => model.getValueInRange(editor.getSelection() ?? new monaco.Selection(1, 1, 1, 1)),
    focus: () => editor.focus(),
  };
}
